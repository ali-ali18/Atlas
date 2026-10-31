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
- `login_fill` e o login automático do muro de login usam o item do próprio dono (`userId` do run), no chat e em rotina, **só quando o item tem o site salvo** e a página atual casa com ele.
- **Casar pelo nome nunca digita.** Item sem site salvo (ex.: "Painel - Kodea"): no chat o bot pede UMA vez, com um cartão "Usar o login do Cofre <item> em <host>?" (Sim / Agora não); o "Sim" grava o hostname exato no item (escopado ao dono; nunca sobrescreve site já salvo) e dali em diante é automático, no chat e na rotina. O cartão tem id próprio por item e host; enquanto há um cartão do Cofre aberto, um 2º `login_fill` de vínculo é recusado (não troca o host que o dono vê); só o BOTÃO do cartão vincula (um "sim" digitado, mesmo entendido pelo Jev, vai ao modelo como fala comum); e se o nome do item não tem relação com o site o cartão avisa "Este site (<host>) não parece ser o de <item>". Em rotina, item sem site não é digitado: o run termina com UMA mensagem pedindo para vincular o site, sem cartão e sem login pendente.
- **Casamento de domínio: só o host exato.** `www.` e o domínio sem `www.` são o mesmo site; qualquer outro subdomínio é outro site (item `google.com` não vale para `sites.google.com`, onde qualquer pessoa publica página; item `panel.kodea.com.br` não vale para `x.panel.kodea.com.br`, `admin.kodea.com.br`, `kodea.com.br` nem `kodea.xyz`). Em localhost e IP a porta também conta (`localhost:3000` ≠ `localhost:9999`). https sempre, http só em localhost. Para o nome do item sem site (`nameMatchesSite`) segue a Public Suffix List (`tldts`).
- **2FA nunca é digitado pelo bot** (`totp` recusado em chat e rotina); código de e-mail/SMS continua pelo cartão de código ou pela busca no e-mail.
- **Campos:** a senha é sempre achada pelo runtime (`password_selector`/`totp_selector` são recusados); só o usuário aceita seletor próprio. O control server (`/browser/type` com `guard`) confere, DENTRO da página e no mesmo `evaluate` que olha o campo (`loginFieldVerdict`), que: a origem da aba é a validada; o campo é visível de verdade (caixa > 1px dentro da página, sem `display:none`, `visibility` oculta, opacidade 0 nem corte por ancestral); o formulário dele só envia para a própria origem (`action`, `formaction` e `<base>`); a senha vai em `input[type=password]` do documento principal; o usuário vai em campo de texto/e-mail/telefone do mesmo formulário de uma senha visível, ou, quando ainda não há campo de senha (1ª tela de um login em duas telas), só em input de e-mail ou com `autocomplete=username`/nome ou id com user, login ou email. Entre vários campos que casam o seletor, vale o primeiro que passa (isca oculta antes do campo real é ignorada) e o preenchimento usa o MESMO elemento, sem reprocurar pelo seletor; a origem é reconferida antes do Enter. O runtime relê a URL do frame principal imediatamente antes de CADA digitação; se mudou de site, aborta. Só o frame principal é alcançado (iframe nunca recebe).
- **Login em duas telas:** sem campo de senha na página a trava responde em ~3 s "Não achei o campo de senha" (campo ausente, não recusa); o runtime digita o usuário, envia e preenche a senha na tela seguinte. Só mensagens que começam com "Recusado" ou falam em troca de site são relançadas como vieram.
- **Código do e-mail:** só é digitado se a aba continua no site do item e passa pela trava (`kind: "code"`: campo de código visível, formulário da própria origem).
- Mais de um item serve à página: o runtime não chuta, o modelo recebe os nomes e pergunta qual usar.
- Rotina que encontra login sem item no Cofre (ou com passo humano) termina com uma mensagem clara ao dono, sem cartão e sem login pendente.
- Mensagem do dono num run com login pendente sempre chega ao modelo (inclusive fala já consumida). Só o botão do cartão ou uma confirmação curta ("pronto", "terminei", "done", "listo"…) conta como "terminei o login"; com a tela de login ainda aparecendo a frase fixa sai uma vez e o cartão segue pendente.
- A senha nunca vai ao modelo, log, SSE, `tool_result` ou erro. O registro discreto no chat ("Entrei em <site> com o login do Cofre <item>") leva só nome, rótulo e domínio do item.
- Código: `packages/shared/src/vault.ts` (`domainMatches`, `pickVaultLoginForPage`), `packages/shared/src/login-wall.ts` (`isLoginConfirmationText`), `packages/agent-runtime/src/tools/vault-tools.ts`, `vault-login-offer.ts`, `computer-use.ts`, `apps/api/src/chat/confirmed-action.ts` (`applyVaultUseApproval`), `docker/agent-sandbox/control/browser-actions.mjs`, `apps/web/components/ai-elements/login/login-card.tsx`.

## Riscos
- Passa a existir uso do login sem clique: a trilha de auditoria do item ("usado", com bot e conversa) continua gravada.
- Login que passa por outro domínio ou subdomínio (ex.: chatgpt.com → auth.openai.com; google.com → accounts.google.com) não é digitado no segundo host: cai no cartão humano. O item precisa ter salvo o site onde fica a tela de login.
- Fora do escopo desta entrega: marcadores `{{login:x.password}}`/`{{login:x.totp}}` em `sandbox_shell`, `shell`, `write_file` e `edit_file` (política `inject`, `secrets/session.ts`) são resolvidos sem vínculo de domínio e sem aprovação por uso (só o dono do run e a redação da saída); a tratar à parte.
- A trava do campo vive no control server: a imagem `docker/agent-sandbox` precisa ser reconstruída junto com o deploy (imagem antiga ignora o `guard`; a revalidação de URL do runtime continua valendo).
- Cartões "Entrar" antigos ainda pendentes continuam funcionando (caminho `useVault` mantido).

## Custo
Sem custo extra de LLM: a nota ao modelo só entra quando há login pendente e fala do dono.

## Como testar
`pnpm --filter @workspace/agent-runtime test` (`computer-use.vault-login.test.ts`, `computer-use.vault.test.ts`, `tools/vault-login-offer.test.ts`), `pnpm --filter @workspace/shared test`, `apps/web` (`request-cards.test.tsx`), `apps/api` (`confirmed-action.vault-link-card.test.ts`) e a trava do campo num Chromium real: `cd docker/agent-sandbox/control && node --test browser-actions.test.mjs` (usa `PLAYWRIGHT_BROWSERS_PATH` ou `ATLAS_TEST_CHROMIUM`; sem navegador os testes do campo são pulados em silêncio).
