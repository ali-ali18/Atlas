# F5 — Subagentes (`delegate_task`)

**Dono:** Bot B · **Depende de:** F4 (travas por tool). O bloco web depende de o usuário commitar `template-4/*`. · **Status:** pronto para revisão

## Decisão do usuário
Uma tool `delegate_task`: o agente abre runs filhos com contexto próprio e tools restritas, **em paralelo**, e integra os resumos. Nada de subagentes nomeados ou configuráveis por bot (por enquanto).

## Diagnóstico
- `runComputerUse` (`packages/agent-runtime/src/computer-use.ts:3543`) recebe tudo por injeção: `messages`, `model`, `mcp`, `budget`, `origin`, `streamChat`, `onEvent`, `onCheckpoint`, `onStep` e `runId` (padrão `"local"`). A recursão é viável.
- As tools vêm do `COMPUTER_USE_TOOLS` do módulo com filtros (sandbox `:140`, rotina `:3682-3692`, perfil `:3693-3722`). Falta um parâmetro de filtro vindo de fora.
- `runTools` é sequencial (`:4095`).
- `AgentRun` não tem `parentRunId` (`packages/db/prisma/schema.prisma:220-261`). A criação fica em `createAgentRun` (`packages/db/src/runs.ts:145`). `enqueueNextRun` (`apps/worker/src/processors/agent-run.ts:685-729`) encadeia runs sem vínculo.
- **Efeitos colaterais a evitar no filho:**
  - `getBotProfile` (`:3706`);
  - executores que gravam rotina, memória e skill;
  - flags que param o run no card (`:3658-3661`).
- A VM ou navegador do sandbox é **uma só** por run: o filho não recebe as tools de sandbox.

## Tarefas
- [x] **Migration:** `AgentRun.parentRunId String?` + `@@index([parentRunId])` + relação opcional. Nome com timestamp próprio (o Bot C também cria uma migration).
- [x] **`runComputerUse`** ganha `toolFilter?: (name: string) => boolean`, aplicado depois dos filtros atuais sobre `baseTools` e as tools MCP (inclusive as ativadas por `mcp_tool_search`).
- [x] **`origin: "subagent"`:**
  - remove `propose_*`, `delegate_task` (profundidade 1), `propose_profile_update`, tools de card e de sandbox e `list_routines`;
  - pula `getBotProfile`;
  - a flag de card não se aplica.
- [x] **Tool `delegate_task`:**
  - schema: `{ tasks: [{ goal: string, context?: string, tools?: string[] }] }`, com 1 a 3 tarefas;
  - `tools` são nomes exatos ou prefixos (`mcp__github__`, `web_search`);
  - sem `tools` → padrão só leitura: tools MCP read-only + `web_search`, `web_extract`, `memory_search`, `session_search`.
- [x] **Executor:**
  - cria um `AgentRun` filho por tarefa (`parentRunId`, mesmo `userId`/`botId`/`conversationId`, `origin:"subagent"`, `objective=goal`);
  - roda `runComputerUse` em **`Promise.all`**, com orçamento próprio (soft 12, hard 30 passos, 8 min de relógio), system prompt enxuto de subagente ("You are a focused sub-agent… return a concise report with findings and sources") + `goal` + `context`, e o mesmo `mcp` runtime e `streamChat` do pai;
  - resultado ao pai: por tarefa, `status` (ok/falhou), o relatório final (até ~4k chars) e as tools usadas. A falha de um filho **não** lança erro no pai;
  - uso e tokens dos filhos somam no orçamento e custo do pai;
  - resume: `findCompletedTool` (`:4138`) reaproveita o resultado do `delegate_task` já concluído.
- [x] **Eventos:** `subagent_started {taskIndex, goal, childRunId}` e `subagent_done {taskIndex, status, summary}` pelo `onEvent` do pai. Os eventos de tool do filho vão prefixados com `childRunId` (a UI pode ignorar).
- [x] **Web:** bloco recolhível "Subagente: <goal>" no chat-thread (status, resumo, tools), reaproveitando o componente de tool call existente. Tipos SSE em `use-atlas-chat.ts` e `lib/atlas-api.ts`.
- [x] **Prompt (texto do Bot C; mandar o texto a C via `REVIEW.md`):**
  - delegar quando houver 2 a 3 frentes independentes (pesquisar lojas diferentes, revisar vários PRs) ou uma leitura longa que poluiria o contexto;
  - não delegar tarefa simples nem nada que precise do navegador ou de cards.

## Testes obrigatórios
LLM mockado:
- [x] O pai chama `delegate_task` com 2 tarefas → 2 filhos com `parentRunId`, rodando em paralelo (verificar pela sobreposição de tempo no mock), resultado agregado no `tool_result`.
- [x] O filho não vê `propose_*`, `delegate_task` nem tools de sandbox; o `toolFilter` por prefixo funciona.
- [x] Um filho falha → o pai recebe `status: falhou` e continua.
- [x] O orçamento do filho estoura → o relatório parcial volta.
- [x] Resume do pai não reexecuta os filhos já concluídos.

## Commits
1. `feat(db): parentRunId em AgentRun`
2. `feat(agent): toolFilter e origin subagent no runComputerUse`
3. `feat(agent): delegate_task (subagentes em paralelo)`
4. `feat(web): bloco de subagente no chat`

## Critérios de aceite
- No `/run`: "pesquisa o preço do MacBook M5 Pro 24GB/1TB no Mercado Livre, Amazon e Kabum" → `delegate_task` com 3 tarefas, 3 blocos no chat e a resposta final consolidada.
- `select id,"parentRunId",status from agent_runs order by "createdAt" desc limit 5` mostra os filhos vinculados.

## Commits feitos
- 4aa55ba `feat(db): parentRunId em AgentRun` (migração `20260930010000_agent_run_parent`)
- 2a2e360 `feat(agent): toolFilter e origin subagent no runComputerUse`
- e62311b `feat(agent): delegate_task (subagentes em paralelo)`
- 3ee19b2 `feat(agent): card persistido dos subagentes na conversa`
- bcf3bd5 `feat(web): bloco de subagente no chat`
- 840093e `test(db): summaries ignora o papel subagents`

## Decisões e desvios (para o revisor)
- **Execução dos filhos:** dentro do worker do pai (`Promise.all` de `runComputerUse`), como manda o Executor da spec; cada filho tem uma linha `AgentRun` (`origin:"subagent"`, `parentRunId`, `status`, `usageJson`, passos em `agent_steps`) mas **sem job próprio** na fila. Reusar a fila exigiria um lease por filho e o pai esperar jobs; não compensa para 1 a 3 filhos de até 8 min.
- **Filho sem `conversationId`:** a spec dizia "mesmo conversationId". Deixei `null` porque (a) o índice único "um run ativo por conversa" barraria o filho e (b) `finishAgentRun` grava o texto de runs `failed`/`budget_exhausted` na conversa. O vínculo é `parentRunId` + `userId` + `botId` (herdados do PAI lido no banco).
- **Só leitura:** o filho recebe `web_search`, `web_extract`, `memory_search`, `session_search` e tools MCP com `readOnlyHint`. `tools` no `delegate_task` só estreita (escrita nunca entra, mesmo com autonomia total). Escrita fica com o pai.
- **Autonomia (F10):** o filho recebe uma cópia congelada da política em vigor do pai; `subagent` conta como origem sem humano (`isUnattendedOrigin`), então tool que cairia em `ask` sai do filho e `set_autonomy` não existe nele. Bloqueios/exceções do pai valem no filho.
- **Limites:** 1 a 3 tarefas por chamada, até 4 chamadas por run (`maxCallsPerTool`), profundidade 1, filho com soft 12 / hard 30 passos, 8 min e 200k tokens, reduzidos ao que sobra no pai (`planChildBudget`); sem folga no pai a tool recusa com dica. Uso dos filhos soma no `usageTotals` do pai (checkpoint e custo). Relatório volta com até ~4k chars, credenciais redigidas.
- **Estouro de orçamento do filho:** volta `status: partial` com o resumo final do filho (ou o que ele já tinha escrito, quando o teto foi de tokens e não há folga para o resumo). Todos os filhos falhando = `ok:false` no pai (conta nas travas por tool); um falhando = o pai segue com `failed` naquela tarefa.
- **Cancelar/pausar:** os filhos usam o `shouldContinue`/`shouldPause`/`abortSignal` do pai; `requestCancelAgentRun` também marca `cancelRequested` nos filhos. **Resume:** `findCompletedTool` reaproveita o resultado; se o pai cai no meio, os filhos `running` do mesmo pai viram `failed` ao retomar (`failOrphanSubagentRuns`) e `failStaleRunningRuns` limpa o resto; `recoverStaleRunningRuns` ignora filhos (não re-enfileira).
- **UI:** um bloco por `delegate_task` (não um por filho): linha recolhível por tarefa (status, resumo, ferramentas), ao vivo pelos eventos `subagent_started/tool/done` (com `groupId`) e persistido como card `subagents` na conversa (não vai ao modelo nem ao resumo). Sem rota nova na API.
