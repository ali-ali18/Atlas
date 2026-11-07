# Compras no Motor v4: produto, comparação e compra registrada

- **Status:** em andamento (F6: frente P integrada com a frente C; cartão, checkout e CVV em `compras.md`)
- **Data:** 2026-11-07
- **Issues/PRs:** —

## O que é
O bot acha um produto na internet, mostra um cartão com foto, preço, frete, total e link, compara lojas pelo total e, quando você compra, guarda a compra e acompanha a entrega sozinho.

## Problema
No v2 não há cartão de produto, o total com frete sai errado na comparação e nada acompanha a entrega depois da compra (`docs/ops/v4-baseline.md`).

## Por que existe
O modelo lia o preço no texto da página e errava o total. Agora o preço, o frete e a disponibilidade vêm de dado estruturado da própria página, e o total é calculado por código.

## Alternativas descartadas
- Ler o preço do Markdown da página: o JSON-LD nem chega nele e páginas de loja costumam ser quase só script.
- Somar zero quando o frete não vem: faz a loja sem frete informado "ganhar". O frete desconhecido fica explícito e a comparação diz que pode mudar.
- Baixar as fotos no servidor: abre SSRF e custo. O card leva só a URL e o navegador do dono a busca (http/https, sem `Referer`).
- `confirm` em `record_purchase`: o registro é do próprio dono, não move dinheiro nem sai do Atlas; pedir confirmação depois de um checkout já aprovado seria ruído.

## Como funciona
- `packages/shared/src/product.ts`: `parseProductPage` (JSON-LD `Product`/`Offer`/`AggregateRating`, OpenGraph e meta description), `offerTotal`, `compareOffers`, cartão `product`. `purchase.ts`: validação, dedupe e nota do vigia, cartão `purchase`.
- `packages/agent/src/capabilities/shopping/`: `product_search` (read, untrusted/web, egress), `record_purchase` (write_internal), `purchase_list` (read, `privateData`, `ownerData: "purchase"`). Uma tool por arquivo; `checkout` (frente C, ver `compras.md`) é a quarta tool da mesma capacidade: `createShoppingCapability({ checkout })` só a oferece com cartão salvo (o worker só monta `checkout` com dono presente, Redis e chave).
- `packages/search`: `fetchPageHtml` devolve o HTML bruto com SSRF por salto, robots.txt, limite por domínio e de bytes.
- `apps/worker/src/v4-adapters/shopping.ts`: adaptador real (página, cartões, compra no db). No run de agenda a capacidade perde a agenda: gravar compra ali não cria vigia em cadeia.
- `packages/db`: model `Purchase` (migration aditiva `20261217000000_purchases`), escopo por `userId` em toda consulta, dedupe por loja + pedido.
- `apps/api`: `GET /v1/purchases` e `GET /v1/purchases/:id` (404 para alheio).
- Vigia de entrega: `watch` na agenda do preset, a cada 12 h, até ~30 dias, nota com pedido e rastreio, `untrustedRead` herdado do run; termina com `done` quando entregue.
- `apps/web/components/ai-elements/shopping/`: `ProductCard`, `PurchaseCard`, `SafeImage`.

## Riscos
- Loja sem JSON-LD nem OpenGraph: a tool diz isso e o bot oferece olhar na loja (a leitura por navegador é da F8).
- Deploy com versões mistas: tabela e eventos novos são aditivos; um web antigo ignora cartão de papel desconhecido.
- Registro falso por injeção: pequeno (dado do próprio dono, com cartão visível), e o vigia nasce marcado como contaminado.

## Custo
`shopping` é lazy: "Bom dia" ganha só uma linha do índice (teste em `guards/economy.test.ts`). `product_search` lê no máximo 6 páginas por chamada, sem corte de conteúdo.

## Como testar
`pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/agent test`, `cd packages/db && pnpm test:db`, api e worker (comandos em `50-testes.md`), `cd apps/web && pnpm test`, `pnpm eval matrix --engines v4 --simulate`, prévias em `apps/web/e2e/compras-previews.spec.ts`.
