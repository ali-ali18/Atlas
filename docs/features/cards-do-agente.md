# Cards do agente no chat (Motor v4)

- **Status:** entregue no web e no celular, agora também gravados na conversa (Motor v4 ainda desligado por padrão)
- **Data:** 2026-11-08 (gravação na conversa: 2026-11-12)
- **Issues/PRs:** branch `wip/f7-w`, junta `feat/harness-v4-cards-app`; #163 item 3, branch `feat/v4-cards-persistidos`

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

## Gravação na conversa (issue #163, item 3)
- **Quem grava:** `apps/worker/src/v4-card-persistence.ts` embrulha o `persistEvent` do run v4. Cada um dos quatro eventos vira uma linha de `conversation_messages` (`persistAgentV4Card`, `packages/db/src/agent-v4-cards.ts`): `role` = tipo do evento (`approval_request`, `handoff_request`, `ask_owner`, `receipt`), `content` = o evento em JSON, `runId` = o run. Uma vez por identidade (`agentCardKey`, a mesma do ao vivo); reemitir não duplica. Melhor esforço: falha de banco vai ao log e não derruba o run.
- **Sem segredo:** `sanitizeAgentV4EventForStorage` (shared) passa todo texto por `redactSecrets` (inclui número de cartão por Luhn), derruba campos `cvv`, `cvc`, `cardNumber`, `password`, `token` etc. de argumentos e fatos de risco, e revalida pelo parser. O CVV nunca esteve no evento (só o aviso `ownerInput: "card_cvv"`); o card de compra gravado não tem o campo preenchido, só o aviso.
- **Estado derivado na leitura, não gravado:** `listConversationMessages` anexa `cardState` (`pending`, `approved`, `denied`, `done`, `answered`, `dismissed`, `expired`) a cada card com estado, a partir de `agent_v4_requests` (aprovação/handoff/resposta de pergunta), `agent_conversation_offers` (pergunta) e do status do run (`resolveAgentCardState`, puro, em shared). Pedido pendente que passou de 24 h, ou cujo run terminou sem decisão, ou pergunta com oferta ignorada = `expired` (selo "Venceu", sem botão). Assim não há escrita dupla nem card que mostre um botão que a API recusaria. Consultas escopadas pela conversa (o `runId` do conteúdo só vale se o run for da conversa).
- **Clientes:** web (`agentCardFromStored(..., state)`) e celular (`agentCardFromStored(..., { state })`, `agentCardPending` respeita o estado) nascem resolvidos fora de "pendente". Merge com o ao vivo: o gravado fica na posição dele e herda o "resolvido" do ao vivo (testes em `thread-merge.test.ts` e `chat-thread.test.ts`).
- **Sem migration.** Versões mistas: api/worker antigos não gravam nem devolvem `cardState` (cliente novo mostra como antes); cliente antigo recebe `cardState` como campo extra ignorado. Linha com `role` v4 num web ANTES do restaurador de cards cai no fallback de "tool" (linha de texto cru); o web e o celular deste branch já restauram. Resumos da conversa ignoram esses papéis (`FRESH_SUMMARY_IGNORE_ROLES`) e o histórico do LLM só lê `user`/`assistant`.
- **Fora deste item:** apagar cards antigos por retenção (seguem a retenção da conversa); `ask_owner` com `choices` (o kernel hoje não as emite no SSE, então não há o que gravar).

## Riscos
- O recibo de run encerrado e os pedidos pendentes agora voltam ao recarregar (web e celular). Run de agenda/rotina com conversa também grava seus recibos.
- Decisão local: web em localStorage, celular só em memória. A fonte da verdade é o servidor (a chamada resolvida marca o card).
- Card de compra com fatos malformados cai no card genérico, sem campo de CVV: aprovar ali falha com `cvv_required` (mensagem amigável, nada é cobrado).
- Deploy com versões mistas: web ou app antigos ignoram os tipos novos.

## Como testar
`pnpm --filter @workspace/shared test`, `cd apps/web && pnpm test`, `cd apps/mobile && pnpm test`, prévias em `apps/web/e2e/agent-cards-previews.spec.ts`.
