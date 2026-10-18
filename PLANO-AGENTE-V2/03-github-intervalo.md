# F3 — GitHub: webhook + intervalo, e revisão de segurança 0–10

**Dono:** Bot C · **Depende de:** F1 para testar ponta a ponta (o código pode começar antes) · **Status:** pronto para revisão

## Diagnóstico
- O pedido real: "monitore todas as entradas do monorepo loja-exemplo (git, PR, merge) e valide se é seguro de 0 a 10, a cada 50 minutos". O agente respondeu que o GitHub "funciona por eventos instantâneos, não em intervalos de 50 minutos".
- O prompt proíbe intervalo:
  - `packages/agent-runtime/src/computer-use.ts:236-240`: "Gatilho GitHub: webhook instantâneo — NÃO tem 'de tempos em tempos'. NUNCA pergunte frequência…";
  - `:1062`: descrição do `propose_routine`;
  - `:1087`: "github = gatilho do GitHub (webhook único, sem polling)".
- Hoje só existe cron de 5 campos (`packages/shared/src/schedule-cron.ts:36-39`). `*/50` dispara em :00 e :50, não a cada 50 min.
- O scheduler usa `upsertJobScheduler({ pattern, tz })` (`packages/queue/src/routine-queue.ts:~86`). O BullMQ aceita `{ every: ms }`, que dá o intervalo exato.
- O gatilho `once` (commit `5ec19f7`) é o modelo a copiar: `triggerJson` sem migration, `formatOnceSummary`, branches em api, web e worker.
- Runs de rotina recebem MCP read-only (`apps/worker/src/processors/agent-run.ts:461`), suficiente para ler commits e PRs.
- Não existe tool nem skill de revisão de código. Existem só as dicas do catálogo (`packages/shared/src/mcp-catalog.ts:158-162`).

## Tarefas
- [x] **shared:** `trigger.kind = "interval"` com `everyMinutes` (inteiro de 5 a 1440):
  - validação pura com erros em pt-BR;
  - `formatIntervalSummary` → "A cada 50 min" / "A cada 2 h";
  - atualizar os unions de `RoutineTriggerType` e `RoutineTriggerJson` (mesmos arquivos do `once`: `routine-once.ts`, `routines.ts`, `events/triggers.ts`, `computer.ts`, `index.ts`).
- [x] **db** (`packages/db/src/routines.ts`): `triggerType="interval"`, `schedule=null`, `triggerJson={kind:"interval", everyMinutes}`. Ajustar `asTriggerType` e as branches de create e update.
- [x] **queue** (`routine-queue.ts`):
  - `syncRoutineScheduler` com `interval` → `upsertJobScheduler(schedulerId, { every: everyMinutes*60_000 }, template)`;
  - o reconcile de boot (`reconcileRoutineSchedulers`, filtro `desired`) inclui `interval`;
  - a remoção segue o mesmo caminho do cron.
- [x] **api** (`apps/api/src/routes/routines.ts`): parse de create e update aceita `interval`.
- [x] **agent-runtime** (`computer-use.ts`, região do Bot C):
  - `propose_routine` aceita `trigger_type:"interval"` + `every_minutes`;
  - executor create e edit;
  - `routineDetailText` e `list_routines` com `formatIntervalSummary`.
- [x] **Prompt:** remover a proibição (`:236-240`, `:1062`, `:1087`). Regra nova:
  - evento instantâneo (push, PR aberto, merge) → gatilho `github` (webhook);
  - "a cada N min/h" → `interval`;
  - os dois juntos são permitidos (ex.: webhook de PR + revisão a cada 50 min);
  - nunca recusar intervalo.
- [x] **"Desde a última execução":** `buildUserTurn` (`apps/worker/src/processors/routine.ts:~138`) inclui `lastRunAt` (fim do último run concluído da rotina, ou "primeira execução"), para o agente usar `since` em `list_commits` e filtrar PRs por `updated`.
- [x] **Skill builtin "Revisão de segurança 0–10"** do GitHub (`mcp-catalog.ts`, que é do Bot A: anotar em `REVIEW.md` e fazer a mudança mínima; ou texto no prompt de rotina). Passos:
  1. Listar commits e PRs desde `lastRunAt`.
  2. Ler os **diffs**, e não a árvore: `pull_request_read` (métodos `get_diff`/`get_files`) e `get_commit` (traz o patch). **Não navegar arquivo a arquivo com `get_file_contents`.** Só abrir um arquivo inteiro quando o diff não bastar, e sempre com o `ref` da própria PR ou commit. Isso vem do caso real de 28/09, em que ler arquivo a arquivo estourou o limite de 10 chamadas e errou caminhos entre branches.
  3. Muitas PRs abertas (o loja-exemplo tem uma pilha de 19): revisar as mais recentes ou as da pilha atual, até 5 por execução, e dizer quantas ficaram para a próxima. Se o Bot B já tiver feito a F5, delegar 1 PR por subagente.
  3. Checar segredos no código, injeção (SQL, comando), authn/authz (IDOR), validação de entrada, dependências novas ou vulneráveis e config insegura.
  4. Responder com **Nota X/10**, uma justificativa em 1 linha e achados por severidade (crítico, alto, médio, baixo) com `arquivo:linha`.
  5. Sem mudanças → "Sem novidades desde <lastRunAt>." (curto).
- [x] **Web** (`routine-map.ts`, `routine-editor.tsx`, `data.ts`): o chip e o resumo de `interval` usam `formatIntervalSummary`. Não precisa de criação manual (a regra é o agente criar a rotina).

## Testes obrigatórios
- [x] shared: validação de `interval` (4 e 1441 inválidos; 5 e 50 válidos) e resumo.
- [x] queue: `syncRoutineScheduler` chama `upsertJobScheduler` com `every` (queue mockada).
- [x] agent-runtime: `propose_routine interval` cria `triggerJson` `{kind:"interval", everyMinutes:50}`.
- [x] Replay com LLM mockado: pedido "monitora o monorepo loja-exemplo a cada 50 minutos e dá nota de segurança" → `github_list_repos` e depois `propose_routine interval 50`, sem recusa e sem questionário.
- [x] Teste de string do prompt: não contém "NUNCA pergunte frequência"; contém a regra nova.

## Commits
1. `feat(routines): gatilho de intervalo (a cada N minutos)`
2. `fix(agent): GitHub aceita intervalo além do webhook`
3. `feat(routines): rotina recebe lastRunAt + skill de revisão de segurança 0–10`

## Critérios de aceite
- No `/run` (depois da F1): o pedido do loja-exemplo cria a rotina "A cada 50 min", e o primeiro run manual devolve "Nota X/10" com achados.
- O painel de rotinas mostra "A cada 50 min", e a rotina sobrevive a um restart do worker (scheduler reconciliado).

## Commits feitos
- 2aefac5 feat(routines): gatilho de intervalo (a cada N minutos)
- bd6dcf5 fix(agent): GitHub aceita intervalo além do webhook
- 24de38b feat(routines): rotina recebe lastRunAt + skill de revisão de segurança 0–10

Decisões: sem migration (`triggerJson`); webhook + intervalo juntos = duas rotinas; a revisão 0–10 é o template `github_security_review` do `propose_routine` (texto em `packages/shared/src/routine-security-review.ts`), sem mexer no `mcp-catalog.ts` (Bot A).
