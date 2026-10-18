# Plano Agente v2 — um agente que funciona

## Por quê
O usuário perdeu a confiança no bot ("nada ele consegue fazer, tudo dá erro"). O diagnóstico no banco (8 dias até 28/09/2026: 215 runs, 20 `failed`, 4 `budget_exhausted`) e no código mostra causas concretas:

| Sintoma | Causa | Fase |
|---|---|---|
| "GitHub não está conectado" (estando conectado) | `github_list_repos` busca a conexão pelo `userId` exato, e a linha é o legado `"default"` | F1 |
| Um usuário usa conectores de outro | `listConnectedMcpConnections` ignora `userId` | F1 |
| Planilha 403 | Planilha criada pelo navegador do sandbox (outra conta); o conector não tem `create_spreadsheet` | F2 |
| "Monitorar a cada 50 min" recusado | Prompt proíbe intervalo no GitHub; só existe cron de 5 campos | F3 |
| Run inteiro morre por uma tool opcional | Travas globais (4 falhas seguidas, limite por tool lança erro, detector de repetição) | F4 |
| Firecrawl falha 10 de 28 | Timeout fixo de 30s, sem retry, sem fallback | F4 |
| `browser_text` "Execution context was destroyed" | `evaluate` sem esperar carregar; a mensagem manda "repita" e isso aciona o detector de loop | F4 |
| `propose_questionnaire` falha 14 de 63 | Parse descarta erros e vira `{}`, items e choices em formato diferente | F4 |
| "Falha após 5 tentativas" (rate limit) | Sem retry por passo nem fallback de modelo; refaz o job inteiro | F4 |
| Sem subagentes | Loop sequencial, sem `parentRunId` | F5 |
| Prompt pt-BR fixo | Sem campo de idioma | F6 |
| Não gera arquivos (PDF, Word, Excel, código) | Não existe `create_file`, renderizador, rota de download nem prévia | F9 |
| Bots não conversam entre si; o grupo responde como um bot só | Não existe `ask_bot`; `ConversationMessage` sem autor; sem orquestração de turnos | F8 |
| Pede autorização o tempo todo; sem lugar para controlar | Confirmação espalhada (`confirmWrites` por conexão, cards de perfil/skill); rotinas só leitura | F10 |
| Proposta no Bling pela VM custou ~US$ 3 (112 passos, 17 screenshots); não há tool HTTP | O agente só chega a serviços por MCP, Google embutido, `web_extract` (GET público) e VM | F13 |
| O agente não recebe nem devolve fotos (composer só texto, "Anexar arquivo" sem ação, sem detecção de visão, sem parte de imagem na mensagem) | F14 |

Decisões do usuário:
- **Subagentes:** tool `delegate_task`.
- **GitHub:** webhook **+** intervalo.
- **Modelo:** manter `openai/gpt-6-luna` com fallback.
- **Idioma:** `Bot.language`, padrão `pt-BR`.

## Bots (donos)
| Bot | Responsabilidade | Fases |
|---|---|---|
| **Bot A — Conectores e dados** | Conexões, conectores MCP, Google builtin, catálogo, grupos | F1, F2, F4-MCP, F7.2, F7.3, F8B |
| **Bot B — Runtime do agente** | Loop do agente, travas, navegador, LLM, worker, subagentes, consulta entre bots, autonomia | F4 (exceto MCP), F5, F7.4, F7.5, F8A, F10 |
| **Bot C — Rotinas, prompt e arquivos** | Gatilhos de rotina, eval, geração de arquivos | F3, F9, F7.1 |
| **Bot D (GPT) — Idioma e prompt** | Idioma por bot (F6a agora); tradução do prompt (F6b no fim) | F6 |

### Posse de arquivos (só o dono edita)
- **A:**
  - `packages/db/src/mcp-connections.ts`, `packages/db/scripts/claim-default*` e o helper novo de claim-default em `packages/db`;
  - `packages/agent-runtime/src/mcp/**`, `packages/agent-runtime/src/github/hook-sync.ts`;
  - `apps/api/src/routes/mcp.ts`, `apps/api/src/routes/github.ts`, `apps/api/src/index.ts` (boot);
  - `packages/shared/src/mcp-catalog.ts`;
  - rota e card de saúde (F7.2);
  - F8B: `packages/shared/src/group-turns.ts`, `apps/worker/src/processors/group-turn.ts`, migration `authorBotId` e as partes de grupo na web.
- **B:**
  - `packages/agent-runtime/src/computer-use.ts`: **loop e executores** (tudo exceto `SYSTEM_PROMPT`, os textos de prompt e as descrições de tools);
  - `budget.ts`, `progress.ts`, `research-budget.ts`;
  - `packages/llm/**`, `docker/agent-sandbox/**`;
  - `apps/worker/src/processors/agent-run.ts`, `apps/worker/src/index.ts`, `packages/db/src/runs.ts`;
  - `packages/queue/src/agent-run-queue.ts`;
  - migration `parentRunId`;
  - componente web do bloco de subagente e de consulta entre bots (F8A).
- **C:**
  - `computer-use.ts`: **`SYSTEM_PROMPT`, `AGENTIC_RESEARCH_PROMPT`, `connectorsPrompt`, `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION`, as descrições de tools e o executor `propose_routine`**;
  - `packages/queue/src/routine-queue.ts`;
  - `packages/shared/src/{routine*,schedule-cron,questionnaire}.ts`;
  - `apps/worker/src/processors/{routine,memory-review}.ts`;
  - `packages/db/src/{bots,memory-context,routines}.ts`, migration `Bot.language`;
  - `apps/api/src/routes/bots.ts`, `apps/api/src/routes/routines.ts`, `apps/api/src/chat/*`;
  - web: `agent-settings.tsx`, `routine-map.ts`, `routine-editor.tsx`;
  - script de eval (F7.1);
  - F9:
    - `packages/agent-runtime/src/files/**`, `packages/db/src/artifacts.ts`, a tool `create_file` (executor em `computer-use.ts`);
    - `apps/api/src/routes/files.ts`;
    - web: cartão de arquivo e modal de prévia;
    - o endpoint `/pdf` no sandbox é do B: fazer a mudança mínima e anotar em `REVIEW.md`.

Precisa tocar arquivo de outro bot? Anote em `REVIEW.md` (arquivo, motivo e trecho) **antes** de editar e mantenha a mudança mínima.

## Regras
- **Branch e worktree por bot:** `agente-v2/bot-a`, `agente-v2/bot-b`, `agente-v2/bot-c`, a partir de `checkpoint/agentic-baseline`.
- Commits atômicos com as mensagens do arquivo da fase, em pt-BR, terminando em `Co-Authored-By: ...` do modelo que escreveu. **Sem push.** **pnpm**, nunca npm ou npx.
- Código escrito por subagentes Sonnet; o bot orquestra e confere.
- **Migrations:** gerar com `prisma migrate dev --create-only` **no momento do commit** (não antes), sempre depois de rebase no `checkpoint/agentic-baseline`, para que os timestamps saiam em ordem. Se duas migrations colidirem no merge, quem chegou depois renomeia a pasta com um timestamp novo. Nomes distintos (B: `parentRunId`, C: `language`). `prisma generate` pode falhar no Windows com EPERM; nesse caso rode `pnpm exec tsc` no pacote.
- **`computer-use.ts`:** B e C editam regiões diferentes. Quem entrar depois faz o rebase.

## Ordem e dependências
```
A: F1 ──► F2 ──► F4-MCP ──► F7.2 ──► F7.3 ─────────(espera F8A)──► F8B
B: F4 ──────────────► F5 ──► F8A ──► F7.4 ──► F7.5
C: F3 ──► F9 (backend 9A/9B; 9C web depois do template-4) ──► F7.1 ──(espera A e B + template-4)──► F6
```
- F9: o backend (9A e 9B) não depende de ninguém. A web (9C) espera o `template-4/*` commitado. O 9D (Python no sandbox) fica para o Bot B, depois.
- A F8A reaproveita a infraestrutura de run filho da F5.
- A F8B (grupos) usa a identidade por membro da F8A e precisa de `template-4/*` commitado.
- Os textos de prompt da F8 vão para o Bot C incluir na F6 (via `REVIEW.md`). Se a F6 já estiver mergeada, o Bot C faz um commit pequeno de prompt.
- As migrations da F8 (`authorBotId`) também usam timestamp próprio.
- A F6 (tradução do prompt) reescreve o texto de todo o `computer-use.ts`. Ela é **a última**.
- A F7.4 (erro padronizado) muda o formato de erro que a F6 vai ensinar no prompt. B avisa C em `REVIEW.md` quando o formato ficar pronto.

## Definição de pronto (por fase)
- [ ] Checklist da fase marcada.
- [ ] Testes da fase verdes, mais `pnpm exec turbo typecheck` verde.
- [ ] Suítes gerais verdes:
  - `pnpm --filter @workspace/shared test`
  - `pnpm --filter @workspace/agent-runtime test`
  - API: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"` em `apps/api`
  - worker: o mesmo comando em `apps/worker`
- [ ] Status da fase = **pronto para revisão**, e os hashes dos commits anotados no arquivo da fase.

## Revisão
Revisor: sessão principal do Claude. Por fase ele:
- lê o diff do branch;
- roda os testes;
- faz a verificação manual da fase (`/run`, bot Jujuba);
- nas fases F1 e F4, confere a consulta de falhas no banco:
  ```sql
  select "inputJson"->>'name', count(*), sum(case when ("outputJson"->>'ok')='false' then 1 else 0 end)
  from agent_steps where type='tool_result' and "createdAt" > now()-interval '2 days' group by 1 order by 3 desc;
  ```

O veredito vai para `REVIEW.md`. O merge no `checkpoint/agentic-baseline` só acontece depois de aprovado, na ordem **A → B → C**.

## Ações do usuário
- [ ] Commitar ou descartar as mudanças pendentes em `apps/web/components/ui/templates/template-4/*`. Isso bloqueia a F6 e o bloco web da F5.
- [ ] Pôr `OPENROUTER_FALLBACK_MODELS` no `.env` (F4).
- [ ] Cadastrar no Google o redirect OAuth `http://localhost:3000/v1/mcp/oauth/callback`, se ainda não fez.
  - A porta 3000 está certa: é o web, e o rewrite do Next leva até a API em 3001.
  - Abra o app pelo **mesmo host** do `ATLAS_URL` (`localhost`, não `127.0.0.1`). Em host diferente, o cookie de sessão não vai junto no callback, e ele cai em "Entre no Atlas".
- [ ] (opcional) Apagar `NEXT_PUBLIC_API_URL` do `.env` e do `apps/web/.env.local`. Não é usado em lugar nenhum e confunde as portas.
- [ ] Depois da F2, pedir ao bot "recria a planilha de preços do MacBook". A planilha antiga é de outra conta.

## Status
| Fase | Dono | Status |
|---|---|---|
| F1 Conexões | A | a fazer |
| F2 Planilhas | A | a fazer |
| F3 GitHub e intervalo | C | a fazer |
| F4 Confiabilidade | B (+A na parte MCP) | a fazer |
| F5 Subagentes | B | pronto para revisão |
| F6a Idioma (encanamento) | D | a fazer |
| F6b Tradução do prompt | D | bloqueada (F3, F4, F5 mergeadas) |
| F7 Sugestões | A/B/C | a fazer |
| F8A Consulta entre bots (`ask_bot`) | B | a fazer (depois da F5) |
| F8B Grupos com pausa automática | A | bloqueada (F8A, template-4) |
| F9 Arquivos (PDF, Word, Excel, código) com prévia | C | a fazer |
| F10 Autonomia (níveis, exceções, validade; conta + bot) | B (A revisa conectores) | a fazer (depois de F1 e F2) |
| F11 Decisões com Jev (intenção, tools, verificação, bloqueio, delegação, travamento) | B | pronto para revisão |
| F12 Uso do computador (snapshot com refs, ferramenta nativa, escala/zoom, espera e verificação) | B | a fazer |
| F13 APIs HTTP (conexão "API personalizada", `http_request`, OpenAPI, Bling primeiro) | A + B | a fazer |
| F14 Imagens (receber fotos do usuário e devolver imagens; visão com fallback, `show_image`, geração opcional) | B + C (web) | a fazer (executor: GPT 6.1 Sol; reusa a infra de artefato da F9) |
