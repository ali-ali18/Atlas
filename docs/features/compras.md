# Compras: cartão salvo, checkout com CVV e mandato (Motor v4, F6.2 a F6.4)

- **Status:** em andamento (backend, telas de cartão e cartão de compra prontos; a VM de verdade chega na F8)
- **Data:** 2026-11-07
- **Issues/PRs:** frente C da F6 (`wip/f6-c`)

## O que é
O dono guarda um cartão no app **sem o CVV**. Quando o bot monta um carrinho, aparece um cartão de aprovação com loja, itens, frete, total e o final do cartão, com um campo para o dono digitar o CVV. O código vai direto para o formulário da loja; o bot nunca vê o número nem o código. Quem quiser pode dar um mandato (valor, loja, prazo, usos) que dispensa só o "confirmar".

## Problema
Pagar é o efeito mais sensível do produto. Um segredo de pagamento no contexto do modelo, no journal, num log ou num evento é um vazamento. O dono decidiu (05/11): cartão salvo sem CVV, CVV digitado a cada compra.

## Por que existe
Dar ao bot a capacidade de comprar de ponta a ponta sem ele jamais tocar no segredo. O CVV só existe durante a aprovação e é de uso único.

## Alternativas descartadas
- Guardar o CVV criptografado: contra a decisão do dono e contra o desenho dos meios de pagamento.
- Passar o CVV no corpo da aprovação até o banco (para o kernel ler do checkpoint): grava o segredo em banco e checkpoint.
- Cobrar por API de pagamento (Stripe etc.): a loja é qualquer loja, o pagamento é o formulário dela.

## Como funciona

### Cartão no cofre (F6.2)
- Tabela `saved_cards` (`secretsEnc`: número, nome, validade e endereço de cobrança, AES-256-GCM da mesma caixa dos conectores) com `brand`, `last4` e `label` em colunas. **Não existe coluna, tipo nem campo de CVV**; o corpo de `POST /v1/cards` é estrito (`cvv`, `cvc`, `csc` = 400).
- Rotas: `GET /v1/cards` (só apelido, bandeira, final), `POST /v1/cards` (Luhn, validade futura), `DELETE /v1/cards/:id`. Escopo pela sessão; cartão de outro dono é 404.
- Tela: Configurações › Cofre › "Cartões de compra" (adicionar, ver final, apagar com confirmação).

### Caminho do CVV (de onde entra a onde morre)
1. O dono digita no `CvvField` do cartão de aprovação (campo não controlado: o valor só vive no `<input>`).
2. Ao enviar, o web lê o valor, **apaga o campo** e manda `POST /v1/agent-v4/runs/:runId/requests/:key/respond` com `{ decision: "approve", cvv }`. Só pedidos de `checkout` aceitam `cvv`; sem ele, 400.
3. A API valida (3 a 4 dígitos) e chama `CvvEscrow.deposit`: valor **selado** (AES-GCM) no Redis, chave = sha256(dono, run, id do pedido de aprovação), TTL de 15 min. A chave já embute o hash dos argumentos (o id do pedido vem de run + chamada + hash). Se a decisão não for gravada agora (410, 409, repetição), o CVV é descartado.
4. O run é retomado; o executor entrega à tool o `approvalId`. A tool `checkout` chama `CardFill.fill`, que abre o cartão no cofre (por dono), faz `CvvEscrow.take` (GETDEL: lê e apaga, uso único) e envia a ação `card_fill` à porta `Sandbox`. O valor morre ali.
5. Nada disso passa por banco, journal, checkpoint, log, evento SSE, `tool_result` nem recibo. Rede de segurança: `redactSecrets` agora também troca qualquer sequência de 13 a 19 dígitos que passe no Luhn.

### `checkout`
- Efeito `money`, `ownerInput: "card_cvv"`. Sempre cartão de aprovação (nem autonomia total dispensa). `riskFacts`: loja (domínio da URL https, nunca o nome que o modelo deu), itens, frete, total, moeda e "Visa final 1111".
- Sem CVV (esqueceu, expirou, outro pedido) a tool falha honesta pedindo para o dono confirmar de novo; nada é pago.
- Loja abre 3DS, app do banco ou captcha: a tool devolve `park: "handoff"` e o kernel estaciona com o cartão "Assumir" **depois** do efeito; a retomada fecha a chamada sem repetir o pagamento.

### Mandato (F6.4)
- Tabela `purchase_mandates` (um por dono): `PUT/GET/DELETE /v1/purchase-mandate`. O worker o carrega para runs com o dono presente; o `decide()` já existente confere valor, moeda, loja (domínio), prazo e usos.
- Com mandato válido o cartão vira `inputOnly`: sem "confirmar", só o campo do CVV. O uso é gasto ao executar (`onMandateSpent` grava o número que resta, só para baixo).

## Como encaixar no cartão de aprovação geral (outra conta, `origin/feat/harness-v4-cards-app`)
O evento `approval_request` ganhou `ownerInput?: "card_cvv"` e `inputOnly?: boolean`. No cartão geral:
1. `purchaseRequestFromEvent(event)` (`apps/web/components/ai-elements/purchase/purchase-facts.ts`) devolve `null` se não for compra. Se devolver, renderize `<PurchaseApprovalCard request={...} />` no lugar do cartão genérico.
2. Se preferirem manter um só cartão: use `CvvField` (`@workspace/ui/components/cvv-field`) dentro dele e `respondAgentV4Request({ runId, key: requestId, decision: "approve", cvv })` de `lib/atlas-api.ts`. Regras: ler o valor só ao enviar, limpar o campo antes da chamada, nunca guardar em estado, store, URL ou log.
3. `inputOnly` esconde "confirmar": só campo e envio.

## Riscos
- **Versões mistas no deploy:** tabelas novas por acréscimo; API nova + worker velho (ou o contrário) só perde a capacidade de pagar (a tool não é oferecida). O evento ganhou campos opcionais.
- **CVV expirado antes da retomada (fila lenta):** a tool falha honesta e o dono confirma de novo.
- **Redis:** o canal usa o Redis da fila; sem chave de servidor (`CONNECTOR_ENCRYPTION_KEY`) ou sem Redis a aprovação de compra responde 503 e nada é aprovado.
- **VM:** o adaptador real do navegador do v4 é da F8. Hoje o worker usa a `Sandbox` indisponível: `card_fill` devolve "computador indisponível", nada é pago e o bot oferece o link da loja.

## Custo
Sem custo de modelo extra. Uma consulta ao banco por run com dono presente (cartões e mandato) e duas chaves Redis por compra aprovada.

## Como testar
- shared: `payment-card.test.ts` (Luhn, validade, bandeira, redação de número).
- db (Postgres): `saved-cards.db.test.ts` (IDOR, limite, mandato).
- agent: `capabilities/shopping/checkout.test.ts` (vazamento em evento, pedido ao modelo, journal, recibo e checkpoint; sem CVV não executa; CVV de outro pedido, run ou dono não vale; segundo aprovar não paga de novo; B não usa cartão de A; mandato só-campo; 3DS com handoff sem repetir).
- api: `cards.test.ts`, `agent-v4.test.ts` (CVV).
- worker: `v4-adapters/payment.test.ts`.
- web: `cards-state.test.ts`, `cards.test.tsx`, `purchase-approval-card.test.tsx`; prévias em `apps/web/e2e/__previews__/compras/` (`e2e/compras-previews.spec.ts`, com `ATLAS_PREVIEW_PAGES=1` por causa da página `app/dev/compras`, que dá 404 sem a variável).
