# P1 — adaptador Responses

Base inicial: `4fe6e44`; branch `agente-v3/gpt-p1`.

## Posse compartilhada (antes de editar)
- `packages/llm/src/chat-tools.ts`: somente tipos opcionais `providerItems`, `reasoningTokens`, `costKind` e `appliedOutputCap`; sem alterar parser, finish_reason ou requests OpenRouter.
- `packages/agent-runtime/src/computer-use.ts`: preservar `providerItems` ao inserir a mensagem do modelo no histórico; sem importar provedor.
- `packages/agent-runtime/src/hygiene.ts`: contar itens opacos no orçamento de contexto e descartar junto da mensagem original; sem alterar política de execução.
- `packages/shared/src/index.ts`: exportar referência pura de modelo.

Leitor Responses separado reutiliza `abortable` e as regras de liberação do reader existentes; o SSE OpenRouter permanece intacto para evitar colisão com F2b.

## Entrega parcial: pendência obrigatória de checkpoint
A revisão automática de aprovação recusou a alteração de `packages/agent-runtime/src/checkpoint.ts` e `packages/shared/src/runs.ts`, por posse da F2b/Sonnet e ausência de autorização explícita para tocar essa área. Nenhum hunk desses arquivos foi aplicado. A fase **não está completa** enquanto a retomada perder os itens opacos. O orquestrador consultou o usuário; pode autorizar GPT ou pedir ao Sonnet para aplicar o delta abaixo.

Delta mínimo pendente (texto de revisão, NÃO aplicado):
```diff
--- a/packages/shared/src/runs.ts
+++ b/packages/shared/src/runs.ts
@@ tipo SerializedLlmMessage
 export type SerializedLlmMessage = {
+  providerItems?: {
+    provider: "chatgpt";
+    model: string;
+    items: Record<string, unknown>[];
+  };
```
Em `serializeLlmMessages` e nos **dois** objetos construídos por `hydrateLlmMessages`, adicionar após `tool_call_id`:
```ts
...(message.providerItems ? { providerItems: message.providerItems } : {}),
```
Teste obrigatório do delta: `serialize -> JSON.stringify/parse -> hydrate -> resolveLlmMessagesForModel` mantém `providerItems` tanto com `content:null` como com array de texto. Retomada entre duas decisões mantém reasoning + function calls + outputs; na troca de modelo o roteador remove os itens opacos.

## O que está implementado
- Referências `chatgpt/<slug>` validadas, IDs legados intactos.
- Tradução de instruções, texto, imagens, pares call/output e itens opacos no mesmo modelo; órfãos/duplicatas rejeitados antes de request.
- Transporte **somente** `https://api.openai.com/v1/responses`, com token SIWC injetado. Nenhum cliente ou credencial do Codex CLI.
- SSE por eventos nomeados, texto, duas chamadas completas, reasoning em ordem, usage com cache/cache-write/reasoning e `costKind:"plan"`, `appliedOutputCap:false`.
- TTFT, watchdog inicial/idle, prazo absoluto e cancelamento reutilizam infraestrutura atual. Retry antes de delta; códigos SIWC fatais não são retentados; 401 genérico renova uma vez com `previousAccessToken`.
- Hook `markNeedsLogin` opcional para status persistente em dois 401 ou invalid_user; erro fatal do cofre preserva status/code seguro.
- Roteador com assinatura de stream existente, descartando itens opacos na troca de modelo/provedor. OpenRouter recebe o mesmo objeto original quando não há metadados para descartar.
- Loop conserva itens em memória entre decisões, sem importar o provedor. Higiene conta o tamanho opaco e poda com o turno original; replay por SSE usa duas tools locais e reasoning sem rede.

## Commits
- `c28f4d4` feat(shared): identifique modelos por provedor sem alterar ids antigos
- `fafa649` feat(llm): traduza histórico e uso para Responses do plano ChatGPT
- `0c25e3c` feat(llm): consuma stream Responses com prazo e refresh seguro
- `341b1ea` feat(llm): roteie decisões pelo provedor do modelo
- `c0f9a93` feat(agent): preserve histórico opaco do provedor entre decisões
- `34675a9` fix(llm): valide códigos de erro e framing do stream Responses
- `9f86fdb` fix(llm): envie apenas parâmetros validados no protocolo SIWC

## Verificação real (04/10/2026, sem rede nos testes)
- `pnpm --filter @workspace/shared test`: 33 arquivos, **396 passed**, duração 1.33s.
- `pnpm --filter @workspace/llm test`: 18 arquivos, **101 passed**, duração final 1.75s.
- `pnpm --filter @workspace/agent-runtime test`: 78 arquivos passaram, 1 arquivo já pulado; **746 passed | 10 skipped (756)**, duração 7.37s. Integrações existentes requerem banco configurado; não foram habilitadas.
- API: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`: **127 pass, 0 fail, 0 skipped**, duration_ms **6040.2622**.
- Worker, mesmo runner: **68 pass, 0 fail, 0 skipped**, duration_ms **4729.3392**.
- DB (via `apps/api`, `pnpm exec tsx --test "../../packages/db/src/*.test.ts"`): **65 pass, 0 fail, 0 skipped**, duration_ms **1157.9695**; Prisma mockado.
- `pnpm exec turbo typecheck`: **12 successful, 12 total; 7 cached; Time:20.51s**. Última mudança posterior só removeu parâmetro no corpo; LLM test/typecheck novamente verdes.
- `pnpm exec turbo build --filter=@workspace/agent-runtime...`: **6 successful, 6 total; 1 cached; 16.959s**. `queue` e `mail` também compilados antes de repetir testes API/worker (primeira tentativa falhou por dist ausente).
- `rg "eyJ|Bearer " packages/llm/src/responses/__fixtures__`: **0 ocorrências**.
- `git diff --check`: sem erro. `rodada/desempenho` continua em `4fe6e44`, merge-base igual; nenhum rebase necessário ainda.

## Hipóteses e limitações
- Orquestrador verificou catálogo **público** `https://openrouter.ai/api/v1/models` em 04/10/2026: **466 modelos e 0 prefixos chatgpt/**. Não houve inferência nem token.
- Referência de protocolo: fontes `src/test-tools.ts` e README do spike. Não foram lidos tokens, arquivos de store ou auth.json.
- Fonte primária: [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Fixtures foram reconstruídas com IDs sintéticos no formato do spike, **não são captura de conta real**.
- `prompt_cache_key`, `prompt_cache_retention` e `parallel_tool_calls` explícitos omitidos: o spike validou duas chamadas paralelas sem a flag; hipóteses sem aceite real não são enviadas. Cache SIWC precisa medição manual futura.
- Visão/tools vêm de capacidades explícitas de catálogo; desconhecido é conservador (`false`), sem inferir pelo nome do modelo.
- `response.incomplete` gera erro acionável, não sucesso vazio; após texto entregue não reinicia resposta. Integração com finish_reason da F2b fica para rebase coordenado.
- P1 não liga feature, não faz login/cofre/refresh DB, não grava cooldown/fallback nem altera custo agregado do loop (P2/P4). O runtime ainda conta custo desconhecido até a telemetria P4.
- Sem chamada paga/real, login ou teste da assinatura; sem migration, push, merge ou comentário de issue. Orquestrador fará o comentário após integração/revisão.
