# PLANO-RUN-V2 — Núcleo de run do Atlas com base no Hermes Agent + OpenClaw 2.0

Plano baseado no NEW-RUN.md (08/10/2026), ajustado pelo orquestrador e aprovado pelo usuário. Unifica com as issues #35, #45 e #46.

> Documento expandido do PLANO-RUN-V2, agora incluindo as partes adicionais do Hermes Agent e lições do OpenClaw 2.0 (nome não confirmado; tratado como apelido de release) que valem a pena replicar. Escrito em 08/10/2026. As evidências reais das runs `cmuxij8ix000rlg3c1s1kkfmr` e `cmuxks4zl0019lg3ch7ecsirq` continuam válidas e são reaproveitadas aqui.

## 0. Relação com o trabalho em andamento

- **F1 (JOIN)** resolve a issue #35 (a mensagem "vou dormir" assassinou a tarefa; JOIN não reescreve objetivo).
- **F3 (Guards de execução)** sobrepõe-se à issue #45 (Lote A2/A3: delivery reserve, re-read guard, progress-governed budget, per-run cost cap). **Não reimplementar**: F3 apenas adiciona `research_note` (memória de trabalho) e adapta-se ao que A3 entrega.
- **F4 (Subagentes robustos)** sobrepõe-se à issue #46 (deadline, relatórios parciais de subagentes, delegação, bolhas intermediárias).
- Já implementado e a ser reaproveitado: cache de leitura (F3), referência de resultado idêntico (F3b) e ledger novelty, economia de contexto (F6), TaskState/journal (F2b), snapshot de config por run (S0).

## 1. Diagnóstico confirmado com dados reais

Coleta em 07/10/2026 (transações READ ONLY; relatório e JSON arquivados pelo usuário).

### 1.1 Bug A — "vou dormir" assassinou a tarefa (run `cmuxij8ix000rlg3c1s1kkfmr`)

- Objetivo original (intacto em `agent_runs.objective`): pesquisa comparativa de estruturas agênticas (DOTS, MUSE, Grok Bot, OpenClaw, Hermes, Claude Code) com relatório em PDF.
- `RunInput` real: `mode: "steer"`, conteúdo "Vou dormir, amanhã vc me fala o que encontrou, boa noite jujuba :)", consumido às 00:23:29; run concluída às 00:24:35 (~65 s depois).
- Cadeia: `apps/web/hooks/use-atlas-chat.ts` (~linha 1503) sempre envia `steer` → `ingestSteerInputs` (`packages/agent-runtime/src/computer-use.ts:4426-4462`) injeta a mensagem e chama `taskTracker.reviseObjective()` (linha 4451) → `taskState.objective` vira a despedida (`version: 2, phase: done`, critérios e artefatos vazios) → o modelo encerra respondendo sobre teclado/MacBook/agenda (memória, não a tarefa) → status `completed`, sem PDF.
- Lição de referência: no Grok Bot, "prompts submitted while a turn is running are queued, not dropped"; no Hermes, mensagem mid-turn interrompe e vira novo turno. Nenhum dos dois reescreve o objetivo da tarefa.

### 1.2 Bug B — pesquisa em loop de releitura (run `cmuxks4zl0019lg3ch7ecsirq`)

- Objetivo: "Pesquisa dnv e faz um pdf, quero algo mt completo!". Status: `budget_exhausted` após 100 decisões (31 min, 5,1M tokens de prompt — 4M de cache —, US$ 0,20).
- **145 chamadas de `artifact_read`, sendo 132 ao mesmo artefato** (`cmuxle8vo004blg6w6mx0gbve`); mesmo trio `{id, offset:0, length:3000}` até 12 vezes. Nenhuma chamada `create_file`; nenhum PDF entregue.
- Três causas combinadas:
  1. O bloqueio de repetição (`checkRepeat`, `packages/agent-runtime/src/progress.ts:163-176`) só pega **2 repetições consecutivas idênticas** (mesmo argsKey + resultKey). Alternância de offsets e intercalação de tools nunca dispara.
  2. **Não há memória de trabalho de pesquisa**: o modelo relê o artefato porque é o único mecanismo de "relembrar" o que já leu.
  3. **Não há gate de entrega**: o run prometia PDF e nada forçou `create_file` antes do teto duro.
- Estagnação (`execution/stagnation.ts`) só emite nudges aos passos 3 e 5; não aborta nem restringe tools.

### 1.3 Bug C — subagentes frágeis

- 19 runs filhos analisados: mistura de `completed`, `failed` e `budget_exhausted` ("Decision deadline exceeded", parede de 8 min). A seção "Hermes Agent" da pesquisa morreu com o filho estourado.
- Modelo dos filhos no período: `xiaomi/mimo-v2.6-flash`. Pais: `deepseek/deepseek-v4.1-flash` (histórico); Jujuba hoje usa `anthropic/claude-haiku-5.5` + subagente Mimo.

## 2. O que o Hermes faz bem (referência estudada)

Fontes: docs oficiais `hermes-agent.nousresearch.com/docs/developer-guide/` (architecture, agent-loop, prompt-assembly, gateway-session-lifecycle, completion-backlog-delivery) e repo `NousResearch/hermes-agent`.

1. **Loop em fases de turno**: `run_agent.py` é facade fina; o loop mora em `agent/conversation_loop.py` e cada fase em `agent/turn_*.py` (iteration prep, API call, API error, overflow, truncation, recovery).
2. **Ciclo do turno**: append user msg → system prompt cacheado → verificação preflight de compressão (>50% da janela) → montar mensagens → injetar camadas efêmeras (avisos de budget, pressão de contexto) → chamada interruptível → tool calls? executar e voltar : persistir e retornar.
3. **Prompt em 3 tiers** (`agent/system_prompt.py` + `prompt_builder.py`): `stable` (identidade, tools, skills) → `context` (arquivos de projeto, snapshot do workspace) → `volatile` (skills index, memória, perfil, timestamp/ambiente). Camadas efêmeras (budget warnings, context pressure, overlays) **nunca** entram no prefixo cacheado — vão na mensagem do turno. Objetivo explícito: preservar prompt caching do provedor.
4. **Alternância estrita**: user/assistant alternados; pares tool_call/tool_result inseparáveis; só `tool` pode repetir em sequência.
5. **Fila de entrada mid-turn** (`gateway/run_busy.py`): slot único `_pending_messages` por sessão + overflow FIFO `_queued_events`; rajada colapsa no slot (burst collapse); `/queue` gera um turno completo por item, em ordem.
6. **Chamada interruptível** (`_interruptible_api_call`): HTTP em thread de fundo monitorando evento de interrupção; interrompido, o turno é descartado sem injetar resposta parcial no histórico.
7. **Compressão**: preflight >50%; gateway >85% entre turnos; flush de memória antes; protege as últimas N=20 mensagens; pares de tools juntos; nova lineage de sessão ("filha").
8. **Completion backlog** (`run_notifications.py` + `tools/process_registry_notifications.py`): conclusões de processos em background coalescem numa única notificação por conversa; falhas e sucessos permanecem no lote.
9. **Recuperação**: active-turn markers + delivery ledger + `resume_pending`; crash recovery só retoma turnos marcados sem resposta entregue.
10. **Budgets**: iteração por agente (default 500; subagente 50 via `delegation.max_iterations`), independentes entre pai e filhos; fallback de modelos em cadeia, inclusive cadeia separada para tarefas auxiliares.

## 3. Lições do OpenClaw 2.0 (nome não confirmado; tratado como apelido de release) (referência adicional)

Fonte: relatório da run de pesquisa (`DADOS-RUN-V2-2026-10-07.md`).

- **Arquitetura**: `Gateway → Session Router → Agent Runtime → Tool Host → Host exec/Sandbox`.
- **Local-first**: SQLite (`sessions.db`, `events.db`, WAL) + WebSocket gateway `127.0.0.1:18789`.
- **Canais**: WhatsApp/Telegram/Slack/Discord/Signal/iMessage/WebChat.
- **Skills portáveis** e SDK de plugins.
- **Subagentes isolados** e **multi-agente com bindings** (agentes se comunicam).
- **Riscos documentados**: workspace não é sandbox; OAuth não portátil; `agentDir` não reutilizável; `gateway.auth.mode: "none"` perigoso.

Para o Atlas, as lições aplicáveis são: separar claramente Gateway/Runtime/Tool Host (já existe em partes); considerar WebSocket para gateway quando escalar; manter workspace e sandbox como conceitos distintos; evitar amarrar estado a caminhos locais.

## 4. Decisões de produto (tomadas pelo usuário)

1. **"Vou dormir" = continuar em background e entregar ao final.** Mensagem casual nunca altera objetivo; a run segue até concluir e o resultado fica entregue/registrado para quando o usuário voltar.
2. **Muse Spark 1.3 (`meta/muse-spark-1.3`) não entra cegamente**: entra via eval head-to-head contra `xiaomi/mimo-v2.6-flash` como modelo de subagente (F4).
3. **Refatoração da base no formato Hermes, sem reescrita total**: replica-se a organização do loop (fases de turno, prompt em tiers, fila de entrada, backlog) dentro de `packages/agent-runtime` (TypeScript). Não é port de código Python; é replicação de arquitetura.
4. **`interrupt` existe como ação explícita separada** (botão/comando "parar e redirecionar agora"), com a semântica original do Hermes (aborta a chamada em voo). Padrão do composer é `join`.
5. **VM/sandbox Docker continua**: o plano só toca o loop, não o tool plane.

## 5. Arquitetura alvo

### 5.1 Mapa Hermes/OpenClaw 2.0 → Atlas

| Hermes | Atlas v2 | Observação |
|---|---|---|
| `agent/conversation_loop.py` + `turn_*.py` | `packages/agent-runtime/src/loop/` (`turn-prepare.ts`, `turn-model-call.ts`, `turn-tools.ts`, `turn-recover.ts`) | `computer-use.ts` vira facade fina |
| `_interruptible_api_call` | `loop/turn-model-call.ts` com `AbortSignal` (já existe no stream) | Só aborta em `interrupt`/`cancel`; `join` não interrompe |
| `prompt_builder.py` (3 tiers) | `loop/prompt-builder.ts` (stable → context → volatile) | Camadas efêmeras na mensagem do turno, fora do prefixo cacheado |
| `run_busy.py` (slot + overflow FIFO, burst collapse) | `loop/inputs.ts` + `RunInput.mode = "join"` | Merge com a mensagem anterior pendente; nunca reescreve objetivo |
| Alternância estrita de mensagens | `loop/transcript.ts` (escritor único) | Pares tool_call/result inseparáveis |
| Compressão preflight >50%, protect_last_n=20, lineage | `loop/context-engine.ts` + `ModelContextEpoch` (PLANO_ARQUITETURA §6) | Fase F6 |
| `run_notifications.py` (completion backlog) | `delivery/backlog.ts` + worker de entrega | Fase F5 |
| IterationBudget + fallback chains | `budget.ts` (manter) | Já existe |
| `delegate_task` com budget independente | `tools/delegate-task.ts` (manter + robustecer) | F4 |
| Memory flush antes de comprimir | memory-review existente + flush pré-compressão | F6 |

### 5.2 O que NÃO muda

Memória (perfil/bot/revisão), MCP (conectores, pool, OAuth), crons/rotinas e webhooks, sandbox/VM (`packages/sandbox`, Chrome, Playwright/CDP, noVNC, adoção por label, viewer), fila BullMQ, lease/checkpoint/heartbeat, budgets existentes (`budget.ts`, `tool-budget.ts`, `generation-budget.ts`), cards de UI, gateway de eventos SSE.

## 6. O modelo de entrada mid-run (contrato central)

### 6.1 Modos de `RunInput`

| Modo | Quem escolhe | Semântica |
|---|---|---|
| `join` (**padrão**) | composer da web/API quando há run ativa | Entra na run sem parar nada. Na próxima fronteira de decisão: se a última mensagem do transcript for `user` pendente → **concatena** (burst collapse); se for `assistant`/`tool` → anexa nova mensagem `user`. A chamada ao modelo em voo **termina normalmente**. Objetivo nunca é reescrito. Notas casuais ("vou dormir") viram contexto: a run continua e entrega o resultado ao concluir. |
| `redirect` | Classificador (JEV + regex; F1) | Join + revisão de objetivo **versionada**: registra no checkpoint `{ previousText, newText, reason, version }`. Só com intenção explícita de mudar a tarefa. |
| `interrupt` | Ação explícita do usuário (botão/comando) | Semântica Hermes: aborta a chamada em voo (descarta resposta parcial), processa a nova entrada imediatamente como redirect. |
| `queue` | Composer ("enfileirar") | FIFO para depois da run (fluxo `chainFollowUp` atual, mantido). |
| `cancel` | Como hoje | Cancelamento com estado terminal `cancelled`. |

### 6.2 Regras duras

1. **Nenhum caminho automático chama `reviseObjective` com texto cru do usuário.** Revisão de objetivo exige `redirect` classificado + registro versionado. A linha atual `taskTracker.reviseObjective(input.content)` (`computer-use.ts:4451`) é removida na F1.
2. **Alternância nunca é violada** pelo merge: o escritor único (`loop/transcript.ts`) valida cada inserção; duas `user` seguidas viram uma só (concatenação com separador); `user` nunca entra entre `assistant(tool_calls)` e seus `tool` results — o join espera a fronteira seguinte.
3. **Ordem FIFO preservada** entre joins; inputs com anexos (imagens) mantêm `image_ref` na mensagem mesclada.
4. **Na dúvida, join.** Classificador indisponível ou incerto → join como nota; nunca redirect. Regex conservador pega cancelamento/comandos explícitos mesmo com JEV off.
5. Mensagens casuais não concluem a run: o `softEvaluate` (existente) continua exigindo evidência de tool para `concluded=true`; uma nota de despedida não é evidência.

### 6.3 Experiência do "vou dormir" (aceite)

Run ativa de pesquisa → usuário manda "Vou dormir, amanhã vc me fala o que encontrou, boa noite" → input entra como `join` (nota) → loop continua → run conclui a pesquisa e o PDF → resultado final persistido e entregue (F5: backlog/notificação) → usuário acorda com o relatório pronto. **Teste de replay obrigatório** com os `RunInput` reais da run `cmuxij8ix000rlg3c1s1kkfmr`: objetivo permanece o original (`version: 1`), status final `completed`, `resultText` menciona o relatório pedido.

## 7. Fases de implementação

### F0 — Fundação: o loop em fases de turno (espelho `turn_*.py`)

Sem mudança de comportamento; extração pura.

- Criar `packages/agent-runtime/src/loop/`:
  - `turn-prepare.ts` — leitura de checkpoint, controle (pause/cancel), verificação de budget, ingestão de inputs (chama `inputs.ts` quando existir), checagem de compressão.
  - `turn-model-call.ts` — `streamStep` e ciclo de chamada interruptível (hoje espalhado no `computer-use.ts`): timeout de primeiro evento, idle timeout, classificação de finish_reason (`truncated`/`incomplete`), retry único.
  - `turn-tools.ts` — dispatch de tool calls (lote, idempotência, journal, ledger, stagnation, guards).
  - `turn-recover.ts` — erros de API, overflow, truncation, loop detection, `summarizeTerminalStop`.
- `computer-use.ts` permanece como facade exportando `runComputerUse` (assinatura inalterada) e os tipos consumidos por `apps/worker` e testes existentes.
- Executar F0 numa janela SEM outros agentes mexendo em packages/agent-runtime; extração pura; suíte verde a cada commit.
- Critério de aceite: suíte atual do `agent-runtime` 100% verde sem alteração de expectativas; `computer-use.ts` < 1.500 linhas ao final; `apps/worker` compila sem mudanças de import.

### F1 — Transcript + JOIN (mata o Bug A)

- `loop/transcript.ts`: escritor único do histórico da run; impõe alternância, protege pares de tools, expõe `appendUserJoin()` com burst collapse (concatena com `\n\n` quando a última mensagem é `user` pendente).
- `loop/inputs.ts`: consome `RunInput` por modo (§5.1); implementa join/queue/cancel; chama o classificador para redirect.
- `jev/intent.ts`: estender `JevIntents` com `redirect` (pergunta: "Does the user's message explicitly change, replace or cancel the current task?"). Fallback regex conservador ("para tudo", "cancela", "esquece isso" → cancel; "na verdade, quero X" / "muda para X" → redirect). Indeciso → join.
- Remover `reviseObjective` automático; adicionar `objectiveRevisions[]` ao checkpoint (`AgentRunCheckpoint`) com `{ previousText, newText, reason, version, atStep }`.
- Web/API: `apps/web/hooks/use-atlas-chat.ts` passa a enviar `join` por padrão; ação "Interromper e redirecionar" envia `interrupt`; "Enfileirar" envia `queue`. `apps/api` valida os novos modos (`RunInputMode` em `packages/shared`).
- Compatibilidade: inputs antigos com `mode: "steer"` são lidos como `join` (sem revisão de objetivo) — nenhuma run em voo quebra.
- Testes: replay da run `cmuxij8ix...` (§5.3); merge com alternância (user+user concatena; user entre assistant(tool_calls) e tool results espera fronteira); redirect versionado registrado; JEV off → join; interrupt aborta chamada em voo sem injetar resposta parcial.

### F2 — Prompt em tiers (cache como política, não acidente)

- `loop/prompt-builder.ts`: monta o system prompt em `stable` (identidade do bot, regras de tools, skills index) → `context` (perfil/memória renderizada, instruções de idioma) → `volatile` (timestamp, sessão, modelo, notas de pesquisa, avisos de budget/pressão de contexto).
- Camadas efêmeras (avisos de budget, `research notes so far`, notas de stagnation) vão na mensagem do turno ou bloco system efêmero pós-prefixo — nunca mutam o prefixo cacheado dentro da mesma época.
- Medir: registrar `cachedTokens`/`promptTokens` por decisão no `usageJson.telemetry` antes e depois; meta: razão cache/prompt ≥ a observada hoje (~80%) em runs longas, sem cair com F3 ligado.

### F3 — Guards de execução (mata o Bug B)

- `loop/read-guard.ts`: reaproveitar o cache de leitura (F3) e a referência de resultado idêntico (F3b); o guard de releitura por artefato é o do A2/A3.
- Tool `research_note` (`tools/research-note.ts`): notas estruturadas `{ sourceRef, findings (≤ 500 chars), keyFacts[], links[] }`; persiste no checkpoint (`researchNotes[]`, cap por run, ex.: 40) e é injetada como camada efêmera a cada passo ("Research notes so far", mais novas primeiro, orçamento de tokens próprio).
- **Gate de entrega**: usa o uso de orçamento unificado = max(passos/teto, tempo ativo/teto, custo US$/teto), já implementado no A3 (#45). 80% → aviso; 90% → só ferramentas de síntese/escrita.
- Estagnação: no 2º nudge (`STAGNATION_FINAL_NUDGE_AT`), o próximo passo roda com tools restritas a síntese/escrita (hoje é só texto).
- Testes: fixture que reproduz o padrão das 145 leituras (132 no mesmo artefato) → run conclui com `create_file` em ≤ 40 passos; notas aparecem na camada efêmera; gate de 80%/90% respeitado; run legítima de leitura única não é afetada.

### F4 — Subagentes robustos + eval de modelo (mata o Bug C)

- Filhos herdam `read-guard` + `research_note` (o relatório do filho inclui as notas no fim).
- Parede de pesquisa do filho: 8 → 12 min (config); estouro de prazo devolve **relatório parcial + notas** (estende o mecanismo `spoken` de `delegate-task.ts`).
- Filho `failed` por deadline → 1 retry automático com escopo reduzido (goal original + "focus only on the most important sub-question"), marcado no card como retry.
- Arnês de eval `scripts/eval-subagent-model.ts`: replay das 3 pesquisas reais (Claude Code, OpenClaw, Hermes) com `xiaomi/mimo-v2.6-flash` × `meta/muse-spark-1.3`; métricas: completude (rubrica JEV), nº de decisões, custo USD, taxa de `failed`/`budget_exhausted`. Orçamento explícito pequeno (regra do projeto). Relatório em `docs/eval-subagent-model.md`; o vencedor vira default de `subagentModel` nos bots (mudança de config, não de código).
- Testes: retry único com escopo reduzido; parcial com notas; órfãos continuam falhando como hoje (`failOrphanSubagentRuns`).

### F5 — Completion backlog (a experiência "acordei e estava pronto")

- `delivery/backlog.ts` (worker): run concluída cujo último input do usuário é nota de ausência (ou sem leitura em N min) → entra em backlog de entrega por conversa.
- Múltiplas conclusões na mesma janela coalescem numa única notificação/mensagem (espelho `run_notifications.py`); falhas permanecem no lote com texto honesto.
- Nota de despedida com horário explícito ("amanhã 7h") → agenda a entrega (reusa infra de rotinas; one-shot).
- UI: badge de "resultados novos" ao abrir a conversa; SSE continua sendo projeção dos eventos persistidos.
- Testes: coalescing de 2 conclusões; entrega agendada por nota com horário; backlog não duplica mensagem final já entregue.

### F6 — Compressão Hermes-style (implementa PLANO_ARQUITETURA §6)

- Preflight: estimar ocupação antes de cada chamada; >50% da janela → compactação incremental protegida (formato estruturado, referências, validação de versão de época) antes da próxima decisão; >85% entre turnos → compressão obrigatória.
- Proteger últimas 20 mensagens completas; pares tool_call/tool_result nunca separados; flush de memória antes de comprimir (chamar memory-review síncrono leve).
- `ModelContextEpoch`: rotação com checkpoint + resumo validado, mesma `conversationId`/`runId`, sem criar conversa visível nova.
- Crash no meio da compactação: mantém época anterior (contrato já descrito na §6 do plano-mãe).
- Testes: fixtures com >2 janelas, mensagem durante o resumo, crash antes/depois do commit, troca para modelo de janela menor.

## 8. Telemetria (transversal, começa na F0)

Adicionar ao `usageJson.telemetry` por run: leituras por `artifactId` (top 5), repetições por `argKey` (top 5), intents de entrada classificados (`join`/`redirect`/`interrupt`), cache hit ratio por decisão, retries de subagente. Sem mudança de comportamento; alimenta o acompanhamento pós-lançamento e o eval da F4.


## 9. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Split do god file introduz regressão | F0 é extração pura; suíte verde a cada passo; facade mantém assinatura |
| Classificador errar redirect como join | Na dúvida → join; regex conservador; telemetria expõe taxa de erro |
| Caps bloquearem pesquisa legítima | Caps generosos (3/8) + erro orientado; métricas mostram falsos positivos |
| Micro-compação invalidar cache todo turno | Opt-in explícito; modelo auxiliar barato; medir antes de ligar |
| Tool registry auto-descoberta importar helpers | AST check só pega `registry.register()` top-level |
| Agent cache perder estado em restart | Estado crítico continua em Postgres (lease/checkpoint); cache é otimização |
| Background process vazar | Registry com ownership e receipts; notificações coalescem |

## 10. Sequência de implementação

Sequência recomendada:

1. Concluir A3 (#45) e as Correções rápidas (#48), em andamento.
2. F1 (JOIN), que fecha a #35.
3. F3-research_note (+ o A2 da #45).
4. F4 (subagentes, relatório parcial no timeout, eval Muse × MiMo), que fecha a #46.
5. F5 (entrega em background / completion backlog).
6. F2 (prompt em tiers).
7. F0 (split do computer-use.ts) numa janela isolada.
8. Backlog: F6, F7, F10, F13.
9. Cortados/futuro: F8 (auto-discovery por AST: desnecessário; registro explícito basta), F9 (Atlas quase não tem tool de terminal), F11, F12, F14, F15.

| Fase | Esforço aproximado | Valor |
|---|---|---|
| F0 | 1,5–2 dias | Fundação |
| F1 | 1,5–2 dias | **Mata Bug A** |
| F3 | ~2 dias | **Mata Bug B** |
| F2 | 1 dia | Cache eficiente |
| F4 | 2–3 dias | **Mata Bug C** + decisão Muse |
| F5 | 1–1,5 dia | Entrega offline |
| F6 | 2–3 dias | Longevidade |
| F7 | 2–3 dias | Compressão incremental (opt-in) |
| F8 | 2 dias | Manutenibilidade de tools |
| F9 | 1,5–2 dias | Segurança de terminal |
| F10 | 1–2 dias | Otimização de cache (medir primeiro) |
| F11 | 2–3 dias | Processos em background |
| F12 | 1–2 dias | Undo/retry |
| F13 | 1 dia | Identidade + snapshots |
| F14-F15 | pesquisa | Gateway / multi-agente |

As duas dores relatadas saem nas primeiras 2 semanas (F0-F4).

## 11. Apêndice — evidências de referência

- Runs analisadas: `cmuxij8ix000rlg3c1s1kkfmr` (steer "vou dormir", 41 decisões, `completed` sem PDF), `cmuxks4zl0019lg3ch7ecsirq` (100 decisões, 145 `artifact_read`, 132 no artefato `cmuxle8vo004blg6w6mx0gbve`, `budget_exhausted`).
- Pontos de código citados: `packages/agent-runtime/src/computer-use.ts` (linhas 4426-4462 ingestão de steer; 4451 `reviseObjective`), `packages/agent-runtime/src/progress.ts:163-176` (`checkRepeat`), `packages/agent-runtime/src/execution/stagnation.ts`, `packages/agent-runtime/src/execution/task-state.ts:39-43`, `packages/agent-runtime/src/tools/delegate-task.ts`, `apps/web/hooks/use-atlas-chat.ts` (~1503), `apps/worker/src/processors/agent-run.ts`.
- Docs Hermes estudadas: architecture, agent-loop, prompt-assembly, gateway-session-lifecycle (§8 message queuing), completion-backlog-delivery.
- Comportamento Grok Bot/x.ai: fila de prompts durante o turno; bots continuam em cloud com o app fechado; entrega ao final.
- Modelos atuais da conta: default `anthropic/claude-haiku-5.5`, manutenção `deepseek/deepseek-v4.1-flash`, fallback `xiaomi/mimo-v2.6-flash`, subagente da Jujuba `xiaomi/mimo-v2.6-flash`. Candidato: `meta/muse-spark-1.3` (OpenRouter).
