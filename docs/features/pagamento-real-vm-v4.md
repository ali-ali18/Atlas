# Pagamento real na VM e ponte da VM no Motor v4 (F8.0)

- **Status:** em andamento (frente A da F8; ainda desligado junto com o v4)
- **Data:** 2026-11-09
- **Issues/PRs:** #165 (mãe), #168 (frente A)

## O que é
O bot passa a pagar de verdade: com o cartão salvo e o CVV que você digitou na aprovação, ele preenche o formulário da loja no computador (a VM) e confirma só se a loja e o valor forem exatamente os que você aprovou. Se a loja pedir 3D Secure, o app do banco ou um captcha, o bot para e você conclui na tela da VM.

## Problema
Até a F7 o `card_fill` respondia "computador indisponível" e nada era pago. O adaptador da porta `Sandbox` não existia no worker, e o Chromium da VM alcançava a rede interna (metadata de nuvem, loopback, rede Docker).

## Por que existe
`amount` e `merchant` chegam do modelo. A aprovação do dono vale para aquele valor naquela loja; só olhar a página FINAL antes de clicar em "pagar" garante que o que cobra é o que foi aprovado (contrato em `packages/agent/src/ports/payment.ts`).

## Alternativas descartadas
- Confiar no `amount` do modelo: uma loja (ou página injetada) cobraria outro valor.
- Tirar screenshot ou usar a árvore de acessibilidade para achar os campos: o número do cartão preenchido iria ao modelo ou ao diff pós-ação. O preenchimento usa seletores e `autocomplete` (`cc-number`, `cc-exp`, `cc-csc`, `cc-name`), inclusive em iframes de gateway, e só devolve estado.
- Aceitar subdomínio da loja (`pay.loja.com` para `loja.com`): o contrato diz host igual ao normalizado; relaxar é decisão do dono.
- `no-new-privileges` e `CapDrop: ALL` no container: quebrariam o `sudo atlas-install` e o entrypoint (docs/features/vm-instalacoes.md). Ficou `CapDrop: NET_RAW, MKNOD` e `PidsLimit`.
- Proxy de egress separado: mais uma peça no compose. A rota do Playwright cobre navegação, subrecurso e redirecionamento do Chromium sem peça nova.

## Como funciona
- **Adaptador** (`apps/worker/src/v4-adapters/sandbox.ts`): um por run, com dono, run e conversa vindos do run (nunca da ação). Resolve a VM da conversa por `createSandboxManager(config, userId).resolveSession(conversationId)` (a mesma do v2: volumes e perfil do Chrome por usuário + conversa), reaproveita a sessão entre ações e recusa `userId` de outro dono. `release` solta a sessão; só a VM criada sem conversa é destruída (a da conversa continua ligada para o dono concluir um 3DS). Sem `SANDBOX_ENABLED` (0/false) o motor segue com `unavailableSandbox` e o erro honesto.
- **Registro de `kind`s:** `defaultSandboxHandlers` (uma linha por `kind`). Esta frente define só `card_fill`; as capacidades `browser` e `code` registram os seus recebendo `{ userId, runId, sessionId, manager, signal }`.
- **`card_fill`:** `sandbox-card-fill.ts` valida o pedido, chama `manager.execCardFill` (`POST /card-fill` no control server, 150 s) e reconstrói o resultado campo a campo (estado, tipo de desafio, referência do pedido, motivo), redigindo qualquer texto livre. Queda no meio do pagamento vira `failed` com "pode ter sido cobrado, confira o pedido", nunca `unavailable`.
- **Control server** (`docker/agent-sandbox/control/card-fill.mjs`, `card-fill-driver.mjs`):
  1. abre a URL e confere o host (igual ao normalizado da loja aprovada); host diferente = `declined`, nada digitado;
  2. captcha visível antes de preencher = `challenge`;
  3. preenche número, validade (campo único ou mês/ano), CVV, titular e endereço por seletores genéricos, em todos os quadros; se faltar número, validade ou CVV = `failed` sem pagar e os campos são limpos;
  4. relê o host e os trechos "Total ..." da página (centavos e moeda); qualquer valor diferente = `declined`; ilegível = `failed`; nenhum = não paga;
  5. grava a trava da compra (url + loja + valor + moeda, 30 min) ANTES de clicar em pagar;
  6. espera até 45 s: 3DS/app do banco/captcha/redirecionamento para outro site = `challenge`; recusa = `declined` (libera nova tentativa); confirmação = `paid` com a referência; sem sinal = `failed` ("pode ter sido cobrado").
  Repetir a ação depois do clique só observa a página; nunca clica de novo.
- **Segredos:** número, CVV, titular e endereço não vão a log, erro, resultado, journal nem trace. Mensagens do Playwright (o call log inclui o valor digitado) nunca são repassadas: só frases fixas. Sem screenshot e sem árvore de acessibilidade no preenchimento. O viewer noVNC do dono continua vendo a tela (é o dono).
- **Egress do Chromium** (`egress-guard.mjs`, ligado em `browser-session.mjs` por `onContext`): toda requisição passa por `context.route`; bloqueia metadata (169.254.0.0/16), loopback, RFC1918 (inclui a rede Docker 172.16/12), CGNAT, multicast/reservado, IPv6 que não é unicast global (e v4 embutido em v6, NAT64, 6to4), nomes internos (`localhost`, `.internal`, `.local`, nomes sem ponto como `redis`) e credenciais na URL. DNS resolvido a cada salto (cache de 5 s) e qualquer endereço interno barra; falha ao conferir aborta. `SANDBOX_EGRESS_GUARD=0` desliga (só depuração).
- **Container** (`docker-manager.ts`): `CapDrop: [NET_RAW, MKNOD]` e `PidsLimit` 4096 (`SANDBOX_PIDS_LIMIT`, 0 desliga).

## Riscos
- DNS rebinding: o Chromium resolve o nome por conta própria depois da checagem. O guarda reduz (cache curto, checagem por salto), mas a barreira completa é a regra de rede do host/Docker (rede da VM sem rota para a rede interna). Pendência de infraestrutura.
- Navegação manual do dono antes de o Playwright conectar não passa pelo guarda (o guarda entra ao conectar; o bot só age depois de conectar).
- Seletores genéricos não cobrem toda loja: sem campos achados o bot responde "não consegui preencher, nada foi pago" e oferece o link.
- Leitura do total é heurística (trechos curtos com "Total"): na dúvida não paga. Pode recusar lojas com resumo fora do padrão.
- Versões mistas no deploy: a imagem da VM precisa do `/card-fill`; imagem antiga responde 404, que o handler trata como "nada foi pago".

## Custo
Sem chamada de modelo. O adaptador não sobe a VM antes da primeira ação.

## Como testar
- `node --test docker/agent-sandbox/control/card-fill*.test.mjs docker/agent-sandbox/control/egress-guard.test.mjs` (driver falso e DNS falso).
- `pnpm --filter @workspace/sandbox test` (cliente, manager e config gerada).
- `cd apps/worker && ... pnpm exec tsx --test src/v4-adapters/sandbox.test.ts` (escopo por dono, challenge sem repetir, varredura de segredo).
- Não há teste com loja real nem Docker real: a validação ponta a ponta fica para o piloto do dono.
