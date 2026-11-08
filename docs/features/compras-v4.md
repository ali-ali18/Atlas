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
- `confirm` sempre em `record_purchase`: seria ruído sem conteúdo de fora. Valia, mas a auditoria da F6 achou o registro falso por injeção; agora é `when_untrusted` (como memória) e o run de agenda nem tem a tool.

## Como funciona
- `packages/shared/src/product.ts`: `parseProductPage` (JSON-LD `Product`/`Offer`/`AggregateRating`, OpenGraph e meta description), `offerTotal`, `compareOffers`, cartão `product`. `purchase.ts`: validação, dedupe e nota do vigia, cartão `purchase`.
- `packages/agent/src/capabilities/shopping/`: `product_search` (read, untrusted/web, egress), `record_purchase`, `purchase_update` e `purchase_delete` (write_internal, `confirm: "when_untrusted"`), `purchase_list` (read, `privateData`, `ownerData: "purchase"`). Uma tool por arquivo; `checkout` (frente C, ver `compras.md`) é a quarta tool da mesma capacidade: `createShoppingCapability({ checkout })` só a oferece com cartão salvo (o worker só monta `checkout` com dono presente, Redis e chave).
- `packages/search`: `fetchPageHtml` devolve o HTML bruto com SSRF por salto, robots.txt, limite por domínio e de bytes.
- `apps/worker/src/v4-adapters/shopping.ts`: adaptador real (página, cartões, compra no db). No run de agenda a capacidade fica só com `product_search` (`readOnly`): nenhuma tool de escrita de compra existe ali.
- `packages/db`: model `Purchase` (migration aditiva `20261217000000_purchases`), escopo por `userId` em toda consulta, dedupe por loja normalizada + pedido + moeda (sem pedido: loja + itens + total + moeda + dia no fuso do dono); o mesmo pedido de novo mescla rastreio, link e número que faltavam.
- `apps/api`: `GET /v1/purchases` e `GET /v1/purchases/:id` (404 para alheio).
- Vigia de entrega: `watch` na agenda do preset, a cada 12 h, até ~30 dias, nota com pedido e rastreio, `untrustedRead` herdado do run; termina com `done` quando entregue.
- `apps/web/components/ai-elements/shopping/`: `ProductCard`, `PurchaseCard`, `SafeImage`.

## Riscos
- Loja sem JSON-LD nem OpenGraph: a tool diz isso e o bot oferece olhar na loja (a leitura por navegador é da F8).
- Deploy com versões mistas: tabela e eventos novos são aditivos; um web antigo ignora cartão de papel desconhecido.
- Registro falso por injeção: depois de ler conteúdo de fora o dono confirma (com opção de ignorar), o run de agenda não tem a tool, a instrução manda registrar só compra que o dono fez ou confirmou e `purchase_update`/`purchase_delete` corrigem ou apagam (apagar encerra o vigia). O vigia ainda nasce marcado como contaminado.
- **Cada vigia ocupa 1 dos 20 itens ativos da agenda por até 30 dias** (acaba antes ao entregar). Quem compra muito enche a agenda e o vigia novo não nasce (a tool diz). Decisão: não mudar agora; se virar problema, um teto próprio para vigias ou intervalo maior.
- A nota do vigia é montada na compra: rastreio que chega depois por mescla ou `purchase_update` não reescreve a nota de um vigia que já roda (o vigia busca pela loja e pelo pedido). Compras gravadas antes da auditoria mantêm a chave de dedupe antiga.
- Preço ambíguo ("1.299") sem moeda que resolva é preço desconhecido; foto só em https público; frete escolhido pelo país do dono (região do idioma do bot) e "não entrega" fora do ranking.

## Custo
`shopping` é lazy: "Bom dia" ganha só uma linha do índice (teste em `guards/economy.test.ts`). `product_search` lê no máximo 6 páginas por chamada, sem corte de conteúdo.

## Como testar
`pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/agent test`, `cd packages/db && pnpm test:db`, api e worker (comandos em `50-testes.md`), `cd apps/web && pnpm test`, `pnpm eval matrix --engines v4 --simulate`, prévias em `apps/web/e2e/compras-previews.spec.ts`.
