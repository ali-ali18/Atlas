# Progresso — Plano de arquitetura agêntica

Documento de acompanhamento da implementação de `PLANO_ARQUITETURA_AGENTICA.md`.
Atualizado a cada entrega/etapa concluída.

## Estado geral

| Entrega | Status | Notas |
|---------|--------|-------|
| 0 — Estabilizar a base | Parcial | Checkpoint Git feito; README/smoke/métricas ainda pendentes |
| 1 — Runs duráveis e F5 seguro | Parcial | Aceite 2026-09-16; **regressões abertas** em cancel vs troca de conversa, um-run-atômico, SSE `[DONE]`/timeout e concorrência de workers — ver log 2026-09-17 |
| Memória (adiantada da E2) | **Feita** | pgvector + embeddings + dedup semântico + leitura híbrida + read tools (M0–M4) |
| Orçamento E3-mínimo (§5.3) | **Feita** | Soft/hard/wall/tokens/caps, loop-detect, muro honesto; **custo USD fora de escopo** |
| Sessão VM — perfil persistente | **Feita** | Volume por conversa provado vivo; falta MFA/`waiting_user` real |
| UI/UX runs | **Feita** | Merge `ui/alpine-trail` + activity, typewriter, scroll, sem toggle |
| 2 — Contexto adaptativo | Pendente | Próxima da fila (resumo/épocas/handoff ainda zerados) |
| 3 — Orçamento e autonomia (resto) | Parcial | Núcleo feito acima; falta extensão multi-job, detector de quase-loop, visuais de orçamento |
| 4 — Browser persistente e login assistido | Parcial | Perfil em volume feito; falta login assistido (ApprovalRequest) e tools de abas/wait/download |
| 5 — Rotinas reais | Pendente | Painel ainda mock |
| 6 — Apps | Pendente | |
| 7 — Multiusuário | Futuro | Fora do escopo da instância pessoal; só se houver mais contas no mesmo Atlas |

---

## Backlog aprovado pelo usuário

### Fora de escopo (decisão explícita)

- **Custo em USD**: irrelevante para instalação pessoal. Tokens são registrados (`usageJson`, tokens por step), mas não há tabela de preços, teto em dinheiro nem exibição de custo — e não haverá.
- **Multiusuário (E7)**: mantido futuro; `userId "default"` por decisão.

### Intervenção do usuário na VM

- Criar `ApprovalRequest` persistido para login, credencial, MFA, CAPTCHA, consentimento OAuth e confirmações necessárias.
- Mudar o run para `waiting_user`, notificar com link para a VM e retomar somente após validação do estado esperado.
- Nunca registrar senha, código MFA ou credencial no chat, memória, logs ou eventos.

### Entrevista ao criar um bot

- Após a criação, oferecer conversa curta e opcional para configurar o bot.
- Derivar perguntas úteis de nome, descrição, modelo, ferramentas e integrações disponíveis.
- Salvar apenas respostas confirmadas na política e memória privada do bot; permitir pular, editar ou concluir depois.

### Sessão e compactação de contexto

- Centralizar leitura e gravação do contexto em `ConversationSessionService`, usado por chat, worker, retomadas e rotinas.
- Criar `ModelContextEpoch` e compactar por `snapshotVersion`, sem sobrescrever mensagens recebidas durante o resumo.
- Rodar compactação após o stream ou em ociosidade; fazer de forma síncrona somente perto do limite crítico do modelo.

---

## Entrega 0 — Estabilizar a base

### Feito

1. **Checkpoint Git** (2026-09-14)
   - Branch: `checkpoint/agentic-baseline`
   - Commit: `976dbdc`

### Pendente

- Atualizar README / smoke tests / métricas do limite de 8 passos

---

## Entrega 1 — Runs duráveis e F5 seguro

Status geral: **Parcial**. O aceite de 2026-09-16 permanece, mas cancel/continuidade/concorrência voltaram a ter regressões em correção (não marcar Feita só porque typecheck passa).

### Etapas

| # | Etapa | Status |
|---|-------|--------|
| 1.1 | Tabelas + `RunInput` | Feito |
| 1.2 | Runtime extraído | Feito |
| 1.3 | Fila, lease e heartbeat | Feito |
| 1.4 | API de runs | Feito |
| 1.5 | Eventos persistidos e SSE | Feito |
| 1.6 | Reconexão depois de F5 | Feito |
| 1.7 | Cancelamento e retry seguro | Feito |
| 1.8 | Mensagens durante o run | Feito |

### Critério de aceite (provas)

- Steer incorporado antes da próxima decisão: visto ao vivo (caso MacBook/24GB).
- Queue encadeado + steer órfão com follow-up: implementado (encadeamento no worker).
- F5/fecha-aba reanexa no mesmo run: validado manualmente várias vezes.
- Restart de API/worker: retomada por checkpoint + lease (código + testes de resume).
- `jobId` determinístico + `UnrecoverableError` + reconciliadores (sweepers de stale/orphan-cancel provados no banco real).
- Typecheck 10/10; suites `shared` e `agent-runtime` verdes.

### Log

#### 2026-09-14 — Correção P2002 + P0 em andamento

- Causa do crash do worker: `RunEvent` `P2002 (runId, seq)` porque deltas SSE e o evento `done` gravavam a sequência em paralelo.
- Correção: lock advisory + `INSERT … MAX(seq)+1`, fila de persistência no runtime e `await emitState.tail` antes de finalizar o run.
- Migration `20260915020000_run_input_lease_steps` aplicada (RunInput, leaseToken, chaves de AgentStep).
- Testes unitários: `pnpm --filter @workspace/shared test` (2) e `pnpm --filter @workspace/agent-runtime test` (10) passaram.
- `pnpm typecheck` passou.
- Ainda **não** Feito: testes de lease/SSE/F5 manuais, lint completo, prova de retry BullMQ em ambiente real.

#### 2026-09-16 — Entrega 1 fechada + Memória (M0–M4) + Orçamento E3-mínimo

Commits (branch `checkpoint/agentic-baseline`): `1e93544` (sweepers), `dfe1162`
(hardening E1), `7a72722` (merge UI `ui/alpine-trail`), `2625953` (volume do
perfil), `f6624da` (web sem toggle), `0a424ca` (pause-send-resume),
`c92969c`/`595111b`/`94ede12`/`2c2f421` (memória M0–M3), `4be614c` (M4),
`f634ca1` (orçamento/loop).

Destaques com prova viva no banco real:

- **Sweepers**: run `running` sem heartbeat → `failed`; cancel órfão → `cancelled`. Probe com linhas descartáveis: ambos transicionaram com 1 evento cada, resíduo zero. Dois runs reais travados (pausado 71min com lease presa; queued com job `completed` retido) foram destravados pelo reconciliador + `requestResume` com recolhimento de lease.
- **Armadilha do `jobId` determinístico encontrada e corrigida**: job `completed` retido faz o re-add ser ignorado em silêncio → `enqueueAgentRunJob` remove artefatos terminais antes; reconciliador confere o job real (`waiting/active/delayed` = vivo; perdido/completed = re-enfileira; `failed` = finaliza).
- **Memória**: pgvector 0.8.6 + `text-embedding-3-small` (1536d); 69/69 fatos com vetor; dedup semântico calibrado (paráfrase EN/PT barrada, tópico distinto passa); leitura híbrida vetor+FTS (RRF) com escopo e validade — prompt de memória 1612 → 930 chars no caso de teste.
- **Orçamento**: soft (avalia/conclui/estende 1x) / hard / relógio 30min / tokens registrados / teto por tool / policy por bot; loop 3x ou 4 falhas seguidas → `failed` com diagnóstico; muro → `budget_exhausted` honesto (provado vivo com `maxWallMs` de teste).
- **VM**: `screenshot_ref` (storage) vs Data URL (transporte) — matou os crashes `Invalid URL`/`Data URL`; volume `atlas-profile-<conversa>` provado (marker sobreviveu a remove+recreate); erros PT-BR com recreate; DSML full-width sanitizado.
- **UX**: sem toggle (modelo decide), pause→digita→auto-resume, `onCancelled` ligado, 1 bolha/step, scroll com stick, play persistente e botão único, labels de status reais (`queued`, `waiting_*`, passo X de Y), anti-vazamento entre chats na troca de bot.
- **Lições operacionais**: runtime lê `dist` (build + restart api/worker após mexer em `packages/*`); `tsx watch` ignora `node_modules`; stack única (`pnpm dev`) — nunca duas; `curl.exe` com JSON single-quoted chega vazio (usar `Invoke-RestMethod`).

Pendente conhecido (não é E1): integração desskippada, `ensureRunning` proativo no `exec`, abort mid-tool, visuais de orçamento, `openrouter.ts` sem fallback `message.content` (UI branch, observar).

#### 2026-09-17 — Revisão execução/streaming/UI (em curso)

Não reabre a Entrega 1 como “feita”. Itens com prova automática vs. o que ainda é manual:

**Implementado no código**
- Leitor SSE com `[DONE]`, erro no body após 200, `signal` no fetch e `finally` cancel+releaseLock (`packages/llm`).
- `AbortError` classificado pela origem do signal (cancel do usuário vs timeout vs lease); worker antigo não chama `finishAgentRun` se o lease já tem outro dono; `recoverStaleRunningRuns` reenfileira, `failStaleRunningRuns` só após graça longa.
- Avaliação de limite brando interna (sem `assistant_delta`); JSON inválido não estende; progresso verificável; loop por args+resultado e alternância A-B; muro honesto com `BudgetExhaustedError`.
- Índice único parcial um run ativo por conversa + `P2002` vira `RunInput` steer; `AGENT_RUN_CONCURRENCY` padrão 4.
- Troca de conversa não cancela o POST que acabou de criar o run; cursor só na bolha `streamingMessageId`; `waiting_user` ≠ `waiting_external`; viewer de sandbox por conversa.

**Auto-testado** (`pnpm test` inclui `@workspace/llm`)
- `shared` 14, `llm` 6, `agent-runtime` 45 — todos verdes; 10 testes de persistência/lease **skip** sem `ATLAS_TEST_DATABASE_URL`.
- SSE `[DONE]` / erro após 200 / hang do body e cancel do usuário (simulado, sem chamada paga).
- `classifyRunError` + `errorFromAbortSignal` (cancel vs timeout vs abort genérico).
- Soft-eval: JSON inválido não estende; eval interna sem delta público.
- Loop A-B-A-B e 3× mesmo args+resultado.
- Helpers `shouldCancelCreatedRun` / `isLiveStreamingBubble`.
- Typecheck: shared, llm, agent-runtime, api, worker, web.

**Manual / pendente**
- Migration `20260917010000_one_active_run_per_conversation` no Postgres vivo (falha se já houver dois ativos na mesma conversa).
- Restart único da stack (`pnpm dev` que já está no ar) para api/worker lerem o `dist` recém-gerado — não subir segundo processo.
- Dois/quatro agentes trabalhando ao mesmo tempo na UI.
- Troca de conversa com POST de run ainda pendente, F5 no meio do stream, pause/play com estado real.
- Não aplicado: segundo `pnpm dev`, mexer no boot do sandbox/Chrome do Bob.
