# Nível de raciocínio

- **Status:** entregue
- **Data:** 2026-11-01
- **Issues/PRs:** #

## O que é
O usuário escolhe quanto o modelo "pensa" antes de responder: Padrão do modelo, Desligado, Baixo, Médio ou Alto. A escolha vale por conversa (no seletor de modelo do chat) e como padrão do bot (na engrenagem), e o próprio bot muda o padrão dele quando o usuário pede no chat.

## Problema
Um modelo forte em "Baixo" custa menos que um modelo fraco no padrão, mas hoje só dá para limitar o raciocínio por teto de tokens (`LLM_REASONING_MAX_TOKENS`, global e invisível). Quem quer gastar menos (ou pensar mais num pedido difícil) não tem controle.

## Por que existe
O OpenRouter normaliza o raciocínio em `reasoning.effort` (`low`/`medium`/`high`) e `reasoning.enabled: false`. Expor isso em quatro níveis simples dá o controle de custo sem expor internals (tokens, parâmetros do provedor).

## Alternativas descartadas
- Só teto de tokens (`reasoning.max_tokens`): difícil de explicar ao usuário e cada família de modelo reage de um jeito.
- Nível por mensagem: o pedido repete a escolha o tempo todo; por conversa e por bot cobre o uso real.
- Mostrar o controle para todo modelo: provedor que ignora ou recusa o parâmetro gera falsa sensação de controle. Só aparece onde o catálogo diz que há raciocínio.
- Oferecer "Desligado" sempre: vários modelos não desligam; lista conservadora (`canDisableReasoning`), o resto começa em "Baixo".

## Como funciona
- **Precedência:** pedido do chat > `Bot.policyJson.reasoningEffort` > conta (`models.reasoningEffort`) > nada (padrão do modelo). Resolvido no worker (`apps/worker/src/reasoning-effort.ts`).
- **shared** (`reasoning-effort.ts`): tipo `ReasoningEffort`, parser estrito, `supportsReasoningEffort` (só OpenRouter com raciocínio no catálogo/curadoria), `canDisableReasoning`, `effortForModel` (por chamada; "Desligado" vira "Baixo" onde o modelo não desliga) e os helpers da política do bot.
- **llm** (`chat-tools.ts`) — com reserva (`models:[...]`), "Desligado" só segue se todos os modelos da lista desligam de verdade; senão vira `effort: low` (o mais barato que todos aceitam; omitir cairia no padrão do modelo, geralmente mais caro): `reasoningEffort` vira `reasoning: { effort }` (ou `{ enabled: false }` para Desligado) e vence `reasoningMaxTokens`/`LLM_REASONING_MAX_TOKENS`. Só no caminho OpenRouter; plano ChatGPT, Anthropic direto, OpenCode e endpoints OpenAI-compatíveis não recebem.
- **api:** `POST /v1/runs` aceita `reasoningEffort` (inválido = 400) e grava em `agent_runs.budgetJson.reasoningEffort`; a retomada e os turnos encadeados (`followUpRequest`) mantêm. `PATCH /v1/bots/:id` valida `policyJson.reasoningEffort`.
- **worker / agent-runtime:** `ComputerUseParams.reasoningEffort` + `modelSupportsReasoning` (capacidades do catálogo). O laço v1 e o v2 decidem a cada chamada, porque o modelo pode mudar no meio do run (modo Automático, modelo para código). Subagentes e rotinas criam runs sem o campo e usam o do bot.
- **Agent-first:** tool `set_reasoning_effort` (`packages/agent-runtime/src/tools/set-reasoning-effort.ts`) muda o padrão do bot. Só existe em turno humano do chat (origin `chat` + `humanTurn`) com pedido explícito (termo raciocínio/reasoning/thinking junto de nível ou verbo), nunca em bot→bot, rotina, webhook, subagente ou proativo; mostra um cartão com o resultado.
- **web:** `components/model-picker/reasoning-effort-control.tsx` aparece no seletor de modelo do composer (escolher um modelo com suporte mantém o seletor aberto), com "Pronto". Escolha por bot (o bot 1:1 tem uma única conversa) em `localStorage`, ou seja, vale para este bot neste aparelho, e a ajuda na tela diz isso (`atlas:reasoning:<botId>`, com try/catch). Linha "Raciocínio" na engrenagem do bot (parte da política mais recente do servidor antes de salvar, para não sobrescrever mudança feita pelo chat). No modo Automático o controle não aparece e a escolha antiga não é enviada.

## Riscos
- Contrato novo e opcional em `POST /v1/runs` e em `budgetJson`: api e worker em versões diferentes funcionam (campo ignorado = padrão do modelo). Sem migration.
- Modelo fora do catálogo ou catálogo fora do ar: sem suporte conhecido, nada é enviado (comportamento de hoje).
- Dados existentes: `policyJson` sem a chave segue igual; `mergeServerPolicyKeys` não toca nela.
- Custo: o nível não adiciona chamada; só muda o parâmetro. "Alto" gasta mais tokens por design.
- Replays/evals: sem escolha, o corpo da requisição não muda (teste em `packages/llm`).

## Custo
Nenhuma chamada nova. Efeito esperado: modelo forte em "Baixo" gasta menos tokens de raciocínio que no padrão.

## Como testar
- `pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/llm test`, `pnpm --filter @workspace/agent-runtime test`, `pnpm --filter web test`.
- api e worker: `pnpm exec tsx --test "src/**/*.test.ts"` (ver `.agents/rules/50-testes.md`).
- Prévia manual: abrir o seletor de modelo do chat com um modelo de raciocínio (ex.: Claude Sonnet) e conferir "Raciocínio" com os quatro níveis; com `openai/gpt-4o` o controle não aparece.
