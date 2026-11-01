# Testes de integração do agente (v1 e v2)

Rede de segurança ponta a ponta para o piloto e a migração do motor v2 (ADR 0002). Postgres **real**, modelo **roteirizado** (sem rede), run criado pela rota real `POST /v1/runs` da API e processado pelo `processAgentRunJob` real do worker.

## Como rodar

```bash
# 1. Postgres com pgvector e as migrations aplicadas (nome do banco contendo "test")
export ATLAS_TEST_DB_URL=postgresql://test:test@localhost:5432/atlas_integ_test
DATABASE_URL=$ATLAS_TEST_DB_URL pnpm --filter @workspace/db exec prisma migrate deploy

# 2. Pacotes compilados (como no CI)
pnpm exec turbo build --filter=worker^... --filter=api^...

# 3. Suíte
pnpm --filter worker test:integration
```

Sem `ATLAS_TEST_DB_URL` o comando avisa e sai com 0 (pulado); o `pnpm test` normal nunca roda estes arquivos (eles são `*.integration.ts`, fora do glob `*.test.ts`). No CI o passo "Integração do agente" roda no mesmo service Postgres do job `check`, depois das migrations e dos testes do db.

Os testes criam usuários com id único e não limpam o banco: dá para rodar várias vezes no mesmo banco. Não aponte para banco de verdade (a variável é recusada se o nome não contém `test`).

## O que cobre

| Arquivo | Cenários |
|---|---|
| `apps/worker/src/integration/motor.integration.ts` | 1 "Bom dia" v1; 2 "Bom dia" v2 (motor em `budgetJson.engine`); 3 pesquisa longa v2 (30 leituras passam do passo 24) e o v1 como caracterização; 4 estouro de orçamento v2 (`budget_cost`, entrega sem tools); 5 escrita de conector para no cartão `confirm` (v1 e v2); 6 cancelamento no meio (v1 e v2); 7 retomada do v2 após shutdown do worker; 8 escopo entre usuários (404) |
| `apps/worker/src/integration/grupo.integration.ts` | 9 grupo Cookie + 2 membros: cobrança única a quem responde "me envie o plano", resumo sem esperar; aceite automático do principal para cartão de leitura e não para escrita |

Cada cenário confere o que ficou no banco: `status`, `stopReason`/`stopDetail`, mensagens (resposta e cartões), `run_events` em ordem, `agent_steps` e o custo em `usageJson`.

## Como funciona

- `harness.ts`: `installFakeLlm(roteiro)` troca o `fetch` e serve respostas SSE no formato do OpenRouter (cada chamada de streaming consome a próxima entrada; qualquer outra URL falha). `createApi(userId)` monta o `createRunRoutes` real (Hono) com sessão e fila falsas em memória. `processRun` chama `processAgentRunJob` com filas e sinais em memória (não precisa de Redis). `createFixture` cria usuário, bot e conversa pelo `createBot` do db. `driveGroup` anda o despacho de grupos (`processGroupTurnsAndPending`) e processa os runs que ele enfileira.
- Conector MCP falso: linha em `mcp_connections` com as ferramentas no cache; a escrita para no cartão de confirmação e nunca chama o servidor.
- Cenário novo: acrescente um `test` em um dos arquivos com um roteiro (`script([...])`), crie o run por `sendChat` e confira com `snapshot(runId)`.

## Defeitos conhecidos (testes marcados `todo`)

- **Motor v2 nunca é escolhido pelo caminho real.** `pickRunEngine` recebe `hasCheckpoint: Boolean(checkpoint)` (`apps/worker/src/processors/agent-run.ts`), mas `createAgentRun` grava um checkpoint em todo run (`packages/db/src/runs.ts`), então `engine-choice.ts` lê "retomada no v1". Os demais cenários do v2 gravam o motor com `pinEngine` (o que um seletor correto faria). Quando o defeito for corrigido, o teste `todo` passa a verde e o `todo` sai.
