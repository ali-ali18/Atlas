# P4 — revisão de roteamento, fallback e telemetria

Worktree `atlas-gpt-p4`, branch `agente-v3/gpt-p4`. Rebase sobre `rodada/desempenho` **9a5f0eb** concluído. Pré-requisitos P1, P2 e P3 integrados somente nesta worktree; correção Responses `354618d` integrada como `9e844e2`. Sem push, merge ou aplicação de migration.

## Implementado

- Worker resolve provedor pelo modelo e usa credencial SIWC exclusivamente do `userId` gravado no run. Modelo ChatGPT não exige chave OpenRouter; fallback exige a chave ao entrar no ramo OpenRouter.
- Fallback configurável por `policyJson.chatgptFallbackModel`: ausência usa `deepseek/deepseek-v4.1-flash`, `null` desliga, string aceita somente modelo OpenRouter. O stream troca antes de texto entregue, registra `fallbackFrom`, preserva modelo pedido/servido e emite aviso. Depois de texto entregue, falha com erro amigável sem misturar respostas.
- Quota persiste `ProviderConnection.lastLimitAt` por dono. Novo processo consulta o mesmo cooldown; padrão 15 minutos, configurável em `ATLAS_CHATGPT_LIMIT_COOLDOWN_MS`. A janela de reset real do plano permanece hipótese.
- Telemetria inclui provider, costKind, reasoningTokens e fallbackFrom. Uso do plano soma `planCalls` e tokens, sem USD zero e sem incrementar custo desconhecido. Resumo e reconciliação não cobram chamadas do plano. Uso misto conserva o custo monetário informado e desconhecido somente das chamadas OpenRouter.
- Catálogo desconhecido permite tentativa multimodal; `vision:false` bloqueia explicitamente. Não se infere capacidade pelo nome. 404 de outro dono/flag desligada continua erro duro; somente 503 admite indisponibilidade conservadora. Contexto usa catálogo ou `ATLAS_CHATGPT_CONTEXT_TOKENS` (padrão conservador 64000).
- Rotina só usa assinatura com `allowChatgptPlan:true`; padrão false, campo validado como booleano na API. Sem opt-in resolve fallback do bot; sem fallback pula com motivo. Criação/alteração e lookup do bot da rotina filtram dono.
- Filho herda provedor do pai, mantendo limite existente de concorrência. Preferência do bot por outro provedor não troca a credencial do filho.
- Resumo, revisão de memória e descritor de imagem ficam no OpenRouter. Jev já usa endpoint OpenRouter e modelo constante `typesafe/jev-1.13`; reconciliação permanece OpenRouter.
- O adaptador SIWC não envia teto de saída. Após a chamada, o runtime grava usage/telemetria e verifica orçamento real antes de tools/conclusão. Uma chamada pode exceder o saldo; o run para sem chamada extra de resumo quando os tokens já ultrapassaram o teto.

## Migration — NÃO aplicada

`packages/db/prisma/migrations/20261004170000_routine_plan_opt_in/migration.sql` adiciona `Routine.allowChatgptPlan Boolean NOT NULL DEFAULT false`. Apenas schema e Prisma Client locais foram gerados. Claude deve fazer backup e aplicar no banco real, junto com ProviderConnection da P2, após revisão.

## Commits da P4 após rebase

| Hash | Mudança |
|---|---|
| 8271be5 | Política pura, evento e tipos de plano |
| 5f01957 | Fallback antes de texto e cooldown |
| 5600916 | Usage e metadados no loop/filhos |
| 77e7106 | Resumo não trata plano como custo desconhecido |
| ccaaa34 | Reconciliação ignora plano |
| 04c6cd8 | Opt-in e posse nas rotinas DB + migration |
| 1c94d41 | Validação de opt-in na API |
| 30ae528 | Worker por provedor e catálogo do dono |
| 049d2ed | Filho preserva provedor |
| 3e3648b | Rotina exige opt-in/fallback |
| 46c38b2 | Manutenção fica no OpenRouter |
| 3baa758 | Fixture completa da rotina ignorada |
| 6c0aa14 | Orçamento real após chamada |
| b1974bc / 6b0db54 | Estilo dos módulos novos |
| 39a0dd6 / 58c202c | Fixtures/dependências tipadas |
| c9ce6f1 | IDOR HTTP POST/PATCH, B recebe 404 |
| c89f205 | Visão false versus catálogo 503 |

Equivalentes antes do rebase já enviados ao orquestrador: `38eeb87` = `8271be5`; `0bd4db1` = `5f01957`; `613ddbe` = `5600916`. Não integrar patches equivalentes duas vezes.

## Verificação — outputs reais

Testes sem rede, OAuth real ou banco real. API/DB/worker usam `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper`. API completa também recebeu `ATLAS_OWNER_EMAIL=owner@example.com` e `BETTER_AUTH_SECRET` fictício: o teste existente de GitHub importa auth antes de configurar ambiente e a execução sem essas variáveis falhou; com fixtures, passou.

| Comando | Resultado |
|---|---|
| `pnpm --filter @workspace/shared test` | 37 arquivos, 419 passed; 4.94 s |
| `pnpm --filter @workspace/llm test` | 21 arquivos, 114 passed; 3.07 s |
| `pnpm --filter @workspace/agent-runtime test` | 87 arquivos passed + 1 skipped; 818 passed + 10 skipped existentes; 14.70 s |
| `pnpm --filter api exec tsx --test "src/**/*.test.ts"` | 137 passed, 0 failed; 9037.3382 ms |
| `pnpm --filter worker exec tsx --test "src/**/*.test.ts"` | 75 passed, 0 failed; 2683.3479 ms |
| `pnpm --filter api exec tsx --test "../../packages/db/src/**/*.test.ts"` | 74 passed, 0 failed; 735.348 ms |
| `pnpm exec turbo typecheck` | 12 successful/12; 11 cached; 5.277 s |

Depois da padronização, os testes afetados foram repetidos: política 4; fallback 4; modelUsage 2; posse/opt-in DB/API/worker 6; IDOR HTTP 2; visão/catálogo 4. Todos passaram. Nenhum segredo em eventos/telemetria; fixtures usam somente valores fictícios.

## Conflitos e limites

Rebase preservou `finishReason` da F2b junto de `providerItems` da P1 no destructuring do loop; testes `servedModel` da F4 foram mantidos junto dos testes de custo do plano. Sem alteração em `checkpoint.ts`, `packages/db/src/runs.ts`, journal ou ledger de efeitos. A fiação em computer-use é restrita a histórico opaco (P1), uso/telemetria e checagem pós-chamada (P4).

A validação de modelo na criação/retomada dos runs e persistência de histórico opaco no checkpoint continuam dependentes dos hunks P1/P3 bloqueados na revisão automática e tratados pelo orquestrador. Não declarar E2E em produção até integração desses pontos, migrations e checklist manual do dono. Não foi feito consentimento real, chamada paga, teste >1h, medição do reset de quota/contexto/cache ou migração real. Plano congelado permanece inalterado.
