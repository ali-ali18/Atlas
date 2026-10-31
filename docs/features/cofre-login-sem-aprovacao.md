# Login do Cofre sem aprovação

- **Status:** entregue (hotfix 0.3.2-beta.1)
- **Data:** 2026-10-31
- **Issues/PRs:** hotfix `fix/login-pendente`

## O que é
O bot usa o login que o dono salvou no Cofre direto, no chat e nas rotinas, sem cartão de aprovação. Fica só uma linha discreta no chat: "Entrei em <site> com o login do Cofre <item>".

## Problema
Caso real (conversa do bot "Adolfinho"): uma rotina parou na tela de login de `panel.kodea.com.br` e deixou um login pendente. Dali em diante cada mensagem do dono ("o cofre está como: Painel - Kodea", "to te falando que o login está no cofre") era tratada como "Terminei", gerava um cartão falso de "Login concluído" e a mesma frase fixa, e o modelo nunca rodava. O Cofre não era usado porque a rotina não tem quem aprove e o item só tinha nome, sem site.

## Por que existe
O dono cadastrou o login no próprio Cofre. Pedir aprovação a cada uso só atrapalha, e em rotina é impossível. As salvaguardas que importam continuam (abaixo).

## Alternativas descartadas
- Autorização prévia por item para rotinas ("sempre permitir neste bot"): decisão do dono foi tirar a aprovação de vez.
- Deixar a rotina pausada esperando o login: o login pendente sequestra o chat seguinte.

## Como funciona
- `login_fill` e o login automático do muro de login usam o item do próprio dono (`userId` do run) sem aprovação, no chat e em rotina.
- Salvaguardas mantidas: a senha nunca vai ao modelo, log, SSE, `tool_result` ou erro; só é digitada se a página atual casa com o item (domínio registrável salvo; item sem site casa pelo nome com o domínio: `Painel - Kodea` ↔ `panel.kodea.com.br` pela palavra "kodea", `kodea.evil.com` não casa); item de outro dono nunca é enxergado; `secret_request` continua exigindo humano; código 2FA continua pedindo a pessoa.
- Mais de um item serve à página: o runtime não chuta, o modelo recebe os nomes e pergunta qual usar.
- Rotina que encontra login sem item no Cofre (ou que precisa de um passo humano) termina com uma mensagem clara ao dono, sem cartão e sem login pendente.
- Mensagem do dono num run com login pendente sempre chega ao modelo. Só o botão do cartão ou uma confirmação curta ("pronto", "terminei", "done", "listo"…) conta como "terminei o login"; com a tela de login ainda aparecendo a frase fixa sai uma vez e o cartão segue pendente.
- Código: `packages/shared/src/vault.ts` (`pickVaultLoginForPage`), `packages/shared/src/login-wall.ts` (`isLoginConfirmationText`), `packages/agent-runtime/src/tools/vault-tools.ts`, `vault-login-offer.ts`, `computer-use.ts`; linha discreta em `apps/web/components/ai-elements/login/login-card.tsx`.

## Riscos
- Passa a existir uso do login sem clique: a trilha de auditoria do item ("usado", com bot e conversa) continua gravada.
- Itens sem site salvo casam pelo nome; nomes genéricos curtos (menos de 4 letras) nunca casam.
- Cartões "Entrar" antigos ainda pendentes continuam funcionando (caminho `useVault` mantido).

## Custo
Sem custo extra de LLM: a nota ao modelo só entra quando há login pendente e fala do dono.

## Como testar
`pnpm --filter @workspace/agent-runtime test` (`computer-use.vault-login.test.ts`, `computer-use.vault.test.ts`, `tools/vault-login-offer.test.ts`), `pnpm --filter @workspace/shared test`, `apps/web` (`request-cards.test.tsx`).
