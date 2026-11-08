# Cards do agente no chat (Motor v4)

- **Status:** entregue no web e no celular (Motor v4 ainda desligado por padrão)
- **Data:** 2026-11-08
- **Issues/PRs:** branch `wip/f7-w`, junta `feat/harness-v4-cards-app`

## O que é
Quando o bot precisa de você, o chat mostra um card simples: aprovar uma ação ("Enviar para ana@..."), pagar uma compra digitando o código do cartão, fazer um passo que só você pode fazer, responder uma pergunta. Quando o bot termina, uma linha de recibo diz o que foi feito.

## Problema
O motor v4 estaciona o run esperando o dono e emite eventos (`approval_request`, `handoff_request`, `ask_owner`, `receipt`). Sem card, o dono não tinha como aprovar nem pagar.

## Por que existe
Um card por tipo, na pele do `ChatCard`, falando em frase simples (nunca nome de ferramenta, id ou fatos crus). A compra é a exceção com campo: o CVV é digitado a cada compra e vai direto à loja.

## Alternativas descartadas
- Campo de CVV no card genérico: o card de compra da F6 já cuida de todas as regras do código; o genérico só mostra um espaço explicativo para pagamentos sem o campo.
- "Agora não" no handoff: a API só tem `handoff_done`; esconder os botões sem resolver o pedido seria falso.
- Mandar o texto da resposta à pergunta na rota do card: a rota só marca respondido; o texto segue como fala da conversa, que é como o run seguinte o recebe.

## Como funciona
- Eventos tipados em `packages/shared/src/agent-v4-events.ts`; `agentCardKey` (identidade estável ao vivo = gravado) e `purchaseRequestFromEvent` (fatos da compra) são compartilhados.
- Web: `lib/agent-cards.ts` (puro), `components/ai-elements/agent-cards/agent-card.tsx`, dedupe em `lib/thread-merge.ts`, restauração em `use-atlas-chat.ts` e `thread-live.ts`.
- Celular: `lib/agent-cards.ts`, `chat-live.ts`/`chat-thread.ts` (ao vivo e gravado), `chat-controller.ts` (`respondToRequest`, `answerAgentCard`), `components/chat/agent-cards.tsx`.
- Rotas: `POST /v1/agent-v4/runs/:runId/requests/:key/respond` (`approve` | `deny` | `handoff_done`, com `cvv` só na compra) e `POST /v1/agent-v4/cards/:cardId/respond` (`answered` | `dismissed`).
- CVV: web usa `CvvField` (input não controlado); celular usa `TextInput` com `secureTextEntry`, `keyboardType="number-pad"`, `textContentType="oneTimeCode"`, sem autofill, valor numa `ref`. Nos dois: lido ao enviar, apagado antes da chamada, nunca em estado, store, URL ou log.

## Riscos
- O worker ainda não grava os cards como mensagens da conversa: o web os restaura pelos eventos do run; o celular só os de run ativo ou parado esperando (o recibo de run encerrado some ao recarregar no celular).
- Decisão local: web em localStorage, celular só em memória. A fonte da verdade é o servidor (a chamada resolvida marca o card).
- Card de compra com fatos malformados cai no card genérico, sem campo de CVV: aprovar ali falha com `cvv_required` (mensagem amigável, nada é cobrado).
- Deploy com versões mistas: web ou app antigos ignoram os tipos novos.

## Como testar
`pnpm --filter @workspace/shared test`, `cd apps/web && pnpm test`, `cd apps/mobile && pnpm test`, prévias em `apps/web/e2e/agent-cards-previews.spec.ts`.
