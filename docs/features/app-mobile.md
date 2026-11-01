# App mobile (Android e iOS)

- **Status:** em andamento (etapa 0 entregue; login e home da etapa 1 entregues)
- **Data:** 2026-11-01
- **Issues/PRs:** #

## O que é
Um aplicativo do Atlas para o celular, feito com Expo (React Native), que conversa com o mesmo servidor do web: o usuário informa o endereço do seu Atlas, entra com Google ou e-mail, vê as conversas sincronizadas e conversa com o bot ao vivo. Vive em `apps/mobile` (`@workspace/mobile`).

## Problema
Hoje o Atlas só tem o web e o app desktop (Tauri). No celular o usuário depende do navegador: sem notificação push, sem compartilhar texto, foto ou arquivo direto para o bot, sem abrir como app.

## Por que existe
Quem usa o bot no dia a dia (lembretes, rotinas, alertas) está no celular. Um app nativo dá push, "compartilhar com o Atlas" e acesso rápido, reaproveitando o servidor e o código de `packages/shared`.

## Alternativas descartadas
- **PWA do web atual:** push no iOS é limitado, sem "compartilhar para o app" e sem tela nativa de login com Google.
- **Tauri mobile:** imaturo para o que precisamos e não reaproveita o ecossistema React Native.
- **Flutter / nativo puro:** perde o reuso de TypeScript (`packages/shared`) e dobra o custo de manutenção.

## Etapas
0. **Base (esta entrega):** projeto Expo no monorepo, tema e primitivos no mesmo molde do `packages/ui`, `@workspace/shared` rodando no Metro, telas só de interface com dado de mentira (conexão com o servidor, login "em breve", "Sincronizando…"), prévia web para screenshots. Sem login real e sem chat.
1. **Conexão, login Google + e-mail, sincronização e chat ao vivo:** better-auth (Google e código por e-mail) com sessão guardada no `expo-secure-store`, lista de conversas, SSE do chat. Roda no Expo Go. **Login entregue (ver "Login (etapa 1)") e carregamento + home entregues (ver "Carregamento e home (etapa 1b)"); o chat ao vivo fica para a próxima.**
2. **Development build (EAS) com push e compartilhar:** notificações push, "compartilhar com o Atlas", deep links. Sai do Expo Go.
3. **Telas nativas:** biblioteca (painéis, rotinas), arquivos, configurações, cards do chat nativos.

## Como funciona (etapa 0)
- **SDK:** Expo SDK 58 (React Native 0.88, React 19.3), a versão estável mais nova do `expo` no npm (`latest`). Router: `expo-router` 58. Android/iOS e web (só para prévia).
- **Estilo:** NativeWind 4.2.7 + Tailwind 3.4.19 (o par estável; o NativeWind 5 ainda é release candidate e exige Tailwind 4 + `react-native-css`).
- **Tokens:** `lib/theme.ts` porta os tokens de `packages/ui/src/styles/globals.css` (background, foreground, card, muted, primary, secondary, accent, border, input, ring, success, warning, info, destructive e os pares `-foreground`) para claro e escuro, convertidos de oklch para hex. O tema segue o sistema.
- **Componentes (`components/ui/*`):** `Button`, `Input`, `Text`, `Card`, `Spinner`, `Badge` e a família `ChatCard` (`ChatCardHeader`, `Line`, `Details`, `Actions`, `Error`), com os mesmos nomes, props e variantes de `packages/ui`. O vocabulário dos cards vem do próprio `@workspace/ui/lib/chat-card-copy` (nada copiado).
- **`@workspace/shared` no Metro:** `packages/shared/package.json` ganhou a condição de export `"react-native": "./src/index.ts"` (antes de `import`). O `dist` não precisa estar compilado e web/api/worker não mudam (eles não usam essa condição). No `metro.config.js`: a condição também liga no web (só para a prévia) e um resolver tenta `.ts`/`.tsx` quando um import relativo `./x.js` não existe (o shared escreve `.js` em arquivos `.ts`, padrão ESM do Node).
- **pnpm:** instalação isolada padrão, sem `node-linker=hoisted` (não foi necessário). Único ajuste: `react-native-css-interop` entra como dependência direta, porque o runtime JSX do NativeWind o importa e o pnpm não o expõe sem declaração.
- **Conexão:** `lib/server-url.ts` (função pura, testada) valida e normaliza: só `https`; `http` apenas em desenvolvimento e para localhost, `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `*.local`; sem esquema assume `https` (ou `http` para host local em dev); tira barra final, query e fragmento; recusa usuário/senha no endereço. `lib/server-check.ts` chama `GET <url>/api/auth/providers` (timeout 8 s) e confere que a resposta tem `google` e `github` booleanos. O endereço fica no `expo-secure-store`.
- **Scripts:** `typecheck` (tsc), `test` (vitest), `export:web` (`expo export --platform web`). O `turbo typecheck` passa a ter 16 tarefas (15 + mobile).

## Login (etapa 1)

### Fluxo de telas
Sem servidor salvo: Conexão (`/connect`). Com servidor e sem sessão: Login (`/login`). Com sessão: o carregamento com o mascote ("Sincronizando…", `/syncing`) (busca bots e seções com a sessão; 401 encerra a sessão e volta ao Login, falha de rede segue; ver "Carregamento e home (etapa 1b)") e a home (`/`, grupo `app/(app)/index.tsx`, a lista de conversas; o "Sair" fica no menu do avatar do topo). O controle é `AccessGate` em `app/_layout.tsx` sobre `lib/auth-flow.ts` (funções puras). "Sair" e "Trocar servidor" chamam `signOut` (mesmo sem rede o cliente apaga a sessão do aparelho).

### E-mail por código (caminho principal)
Link por e-mail abre no navegador e não volta ao Expo Go sem deep link, então o app usa o plugin `emailOTP` do better-auth: "Enviar código" -> campo `InputOTP` (6 casinhas em dois grupos de 3 com separador, `components/ui/input-otp.tsx`: mesmas partes do InputOTP do shadcn, `TextInput` invisível por baixo com teclado numérico e `oneTimeCode`; entra sozinho ao completar; aceita colar) com "Reenviar" (espera de 30 s, o servidor limita 3 envios por minuto) e "Trocar e-mail". Estado e validação em `lib/login-flow.ts` (reducer puro com `now` injetado, `sanitizeCode`, `friendlyAuthError`). Textos em pt-BR, no tom de `pt-BR/login.ts` do web; erros do servidor viram frases simples, nunca o texto cru.

Servidor (`apps/api/src/auth.ts`, `createAuth`):
- código de 6 dígitos, validade de 300 s, 5 tentativas (`allowedAttempts`), `storeOTP: "hashed"`; o e-mail sai por `@workspace/mail`, o mesmo do magic link;
- só o dono: um hook antes de `/email-otp/send-verification-otp` devolve `{ success: true }` para qualquer outro e-mail sem gravar código nem enviar e-mail (resposta igual, não revela quem é o dono), `sendVerificationOTP` repete a checagem e `databaseHooks.user.create.before` barra qualquer usuário novo que não seja o dono, por qualquer caminho;
- rate limit: o do better-auth (3 envios e 3 entradas por minuto por IP, ligado em produção).

### Sessão: plugin `@better-auth/expo` (não o `bearer`)
Escolhido porque é o plugin oficial para Expo (versão 1.7.6, igual à do `better-auth` instalado): guarda o cookie da sessão no `expo-secure-store` (com cache da sessão para abrir offline), manda `expo-origin` (que o servidor vira em `Origin`) e devolve o cookie no retorno do login social, sem inventar um segundo formato de token. O `requireUser` não mudou: lê a sessão pelo cabeçalho `Cookie`, que é exatamente o que `lib/api-fetch.ts` manda (`getCookie()` do cliente). `apiFetch` só envia o cookie para a origem do servidor salvo (um endereço absoluto de outro host é recusado) e usa `credentials: "omit"`. O `authClient` é criado depois da Conexão, com `baseURL` igual ao endereço salvo (`lib/atlas-session.tsx`). Teste de ponta a ponta no servidor: entrar por código -> `requireUser` com o cookie -> `scopeFor` -> sair derruba a sessão.

### Google
`client.signIn.social({ provider: "google", callbackURL: "/" })`; o plugin troca `"/"` pelo deep link do app e abre o navegador do sistema (`expo-web-browser`, `openAuthSessionAsync`). O botão só aparece se `GET /api/auth/providers` diz `google: true`. Se o retorno não trouxer sessão (cancelou ou o servidor recusou), aparece "Não consegui entrar com o Google. Tente de novo ou use o código por e-mail."

### Origens confiáveis e `ATLAS_TRUST_EXPO_GO`
`trustedOrigins` = origem do web + `atlas://` (sempre) + `exp://` (só com `ATLAS_TRUST_EXPO_GO=1`). Função pura `buildTrustedOrigins`. No Expo Go o retorno chega como `exp://<ip>:<porta>/--/...`, e o esquema `exp://` é de todos os apps abertos no Expo Go: com a env ligada em produção, um app malicioso no mesmo aparelho poderia registrar o retorno do Google (que leva o cookie da sessão na URL) e roubar a sessão do dono. Por isso a env nasce desligada e deve ser ligada só durante o teste no Expo Go e desligada depois; no app instalado (EAS build) o `atlas://` basta. Documentada nos `.env.example` e no `docker-compose.yml`.

### Segurança
- **Deep link e o cookie:** no retorno do Google, o cookie da sessão volta ao app dentro da URL do deep link (`atlas://...?cookie=...`). No Android, outro app instalado pode registrar o mesmo esquema `atlas://` e interceptar o retorno. Antes de publicar na loja, avaliar App Links (Android) / Universal Links (iOS), que são verificados por domínio, ou um esquema menos óbvio. O código por e-mail não usa deep link e não tem esse risco.
- **`NODE_ENV=development`:** nesse modo o próprio plugin `expo` do better-auth já aceita `exp://` como origem confiável, sem a env `ATLAS_TRUST_EXPO_GO`. Nunca rode produção com `NODE_ENV=development`.
- **Proxy e IP:** o limite por IP do better-auth lê `X-Forwarded-For`. O proxy reverso na frente da api precisa **sobrescrever** esse cabeçalho (não repassar o que o cliente mandou); senão quem envia um `X-Forwarded-For` falso foge do limite. O teto por e-mail (5 códigos em 15 min, de qualquer IP) não depende disso, mas fica em memória do processo: com várias instâncias da api vale por instância e reiniciar zera a conta.
- **Tempo de resposta:** o envio do código não é esperado (sem `await`), então a resposta tem o mesmo tempo para o dono e para qualquer outro e-mail; falha de envio vai ao log sem o código.

Nenhum token ou cookie em log; o código nunca é logado pelo app. O `MAIL_URL=log://` (padrão de desenvolvimento) imprime o e-mail inteiro, inclusive o código, no log do servidor: em produção use SMTP ou Resend. A checagem de origem do better-auth fica explícita (`disableOriginCheck: false`) porque em `NODE_ENV=test` ele a desliga sozinho.

### Testes
- api: `apps/api/src/auth.mobile.test.ts` (banco em memória, e-mail capturado): dono recebe código e entra; outro e-mail não recebe nem entra e a resposta é idêntica; código errado, expirado e reutilizado falham; limite de tentativas; código com hash; rate limit; `exp://` barrado sem a env e aceito com ela; `atlas://` aceito; origem de outro site barrada; magic link do web segue; `requireUser` com o cookie.
- mobile: `lib/login-flow.test.ts`, `lib/auth-flow.test.ts`, `lib/api-fetch.test.ts` (vitest).

### Riscos
- **Expo Go e `exp://`:** o teste no Expo Go contra produção exige ligar `ATLAS_TRUST_EXPO_GO=1` (e redeploy); ver acima. Sem isso o envio do código no Expo Go falha com origem inválida.
- **Retorno do Google no Expo Go:** o redirect URI do Google continua o do servidor (`/api/auth/callback/google`); o app só muda o destino final. Não foi testado em aparelho real nesta entrega (sem Google real aqui): validar no Expo Go do Android.
- **Cancelar o Google** mostra a mesma mensagem de falha (o navegador não diz se foi cancelamento).
- **Sessão offline:** o app abre com a sessão em cache; se o servidor a tiver revogado, o `GET /v1/bots` de "Sincronizando…" (401) encerra a sessão.

## Carregamento e home (etapa 1b)

### Fluxo
Com sessão, `AccessGate` leva a `/syncing` (carregamento), que leva à home (`/`, grupo `app/(app)`); tocar num bot ou conversa abre `/chat/[id]` (placeholder "Chat em breve"). Enquanto o app confere o servidor salvo e a sessão do aparelho (`phase: "loading"`), o mascote cobre a tela, então nenhuma tela errada pisca. A tela provisória "Conectado como …" saiu.

### Carregamento
`components/splash-screen.tsx`: fundo `#09090b` (escuro nos dois temas, igual ao splash nativo) e o `Avatar` branco de 92 px no centro, animado e parado (só pisca e olha), sem texto. O splash nativo (`expo-splash-screen` em `app.json`) usa o mesmo fundo e `assets/splash-icon.png` (o mesmo corpo e olhos, gerados do motor `toSvg` do shared) com `imageWidth: 92`; `preventAutoHideAsync` segura o nativo até a primeira camada do app desenhar, para a troca não piscar. `/syncing` fica no mínimo 0,9 s e chama `prepare()` do `HomeDataProvider`: com cache abre na hora e a atualização segue por trás; sem cache espera a rede (10 s). 401 encerra a sessão (volta ao Login); falha de rede sem cache abre a home com o aviso e "Tentar de novo".

### Dados (mesmos endpoints do web)
- `GET /v1/bots`: cada bot traz `pinned/pinOrder`, `sectionId`, `isPrimary`, `memberIds` (grupo), `unreadCount` e `lastMessage` (a conversa de cada bot; não existe lista de conversas à parte, `POST /v1/conversations` só cria).
- `GET /v1/sections`: as seções (`order`, `name`).
Tudo por `lib/api-fetch.ts`, com a sessão. Respostas malformadas são descartadas item a item (`lib/home-sync.ts`), nunca derrubam a lista.

### Home
- **Topo:** foto da conta (a do Google) ou iniciais, que abre um menu com "Sair" e "Trocar servidor"; "+" redondo (por enquanto uma gaveta "Em breve").
- **Fixados:** grade de 3 colunas, avatar com a forma e a cor reais do bot (`resolveShape`/`resolveColor` + o `Avatar` do app, o mesmo motor do web), nome truncado com "…" e a estrelinha laranja no bot principal. A última linha fica centralizada, como na referência.
- **Seções:** recolhíveis ("Codding ⌄"), na ordem de `order`; bots sem seção (ou com seção que não existe) ficam em "Sem sessão", no fim. Fixado nunca aparece numa seção (igual ao web). Linha: avatar, título em negrito, data à direita ("agora", "14:05", "Ontem", "Seg", "5 de out.", "5 de out. de 2025"), prévia limpa de markdown e ícone de envio em "Enviou mensagem para X: título" (o marcador `bot-link` lido por `parseBotLinkCard`). Bola azul + prévia mais forte quando há mensagem não lida.
- **Rodapé:** botão de grade (placeholder "Em breve") e a barra "Buscar" em pílula, que filtra bots e conversas localmente (nome e prévia, sem acento nem caixa); durante a busca as seções ficam abertas e as vazias somem.
- **Puxar para atualizar** (`RefreshControl`).

### Cache
`@react-native-async-storage/async-storage` 2.2.0 (a versão do SDK 58, funciona no Expo Go). Chave `atlas.home.v1:<servidor>|<e-mail>` (nunca mostra a lista de outra conta), validade de 30 dias, formato versionado. Cai no cache se estiver estranho/antigo e a rede segue. Ao sair ou trocar de servidor, o cache da home é apagado (`clearHomeCache`).

### Lógica pura e onde mora
Tudo em `apps/mobile/lib` com teste (vitest): `home-list.ts` (agrupamento, ordenação, busca, prévia, data, iniciais), `home-sync.ts` (busca e validação), `home-cache.ts` (cache com armazenamento injetado). Nada foi extraído para `packages/shared`: no web essa lógica está dentro de componentes e do i18n (`agent-list.tsx`, `chat-sidebar.tsx`, `list-time.ts` com `Intl`/fuso/idioma), e refatorar para dividir teria risco no web sem ganho agora. A data de lista do mobile é fixa em pt-BR (Hermes não garante `Intl` completo). Reaproveitado do shared: `Bot`, `Section`, `parseBotLinkCard`, `sourcePreviewPrefix`, `resolveShape`/`resolveColor`, o motor do avatar. Fica como sugestão extrair para o shared quando o web ganhar o mesmo teste.

### Diferenças em relação à referência do dono
- Fundo `#09090b` (o do tema do app), não o cinza `#121212` do print.
- Mascote do carregamento: olhos retos (quadro de repouso do motor); no print do splash o corpo está girado em 3D.
- Avatares da home: parados, de lado e olhando para cima e para a direita (`lib/avatar-pose.ts`, `LIST_POSE` yaw 26, pitch -18, roll 15 no `Frame.orientation` do motor, o mesmo campo que o web usa). O web não tem pose fixa de lista (parado ele é reto; o 3D vem do olhar, dos clipes de repouso e da cutucada, que chegam a yaw 40, pitch -34 e roll 25), então os valores foram ajustados contra o print e ficam dentro desses limites. Ficam estáticos, sem piscar nem olhar: o web também não anima a lista (só pisca por timer), e dezenas de avatares com valores compartilhados e timers pesariam no celular.
- O avatar do Grok Bot é o do motor (forma do bot), não o abóbora com caule do print, que vem de uma forma que o motor não tem hoje.
- Sem barra de status e sem a pílula de gestos do Android (só existem no aparelho).
- Splash nativo: o mesmo corpo e olhos em PNG; o Android 12+ mostra o ícone dentro da própria área de ícone, então o tamanho exato só se confirma num aparelho (Expo Go não usa esse splash).

### Riscos
- O splash nativo só é validado num development build ou no app instalado, não no Expo Go.
- Foto da conta: vem de `user.image` do better-auth (Google); se a imagem não carrega, vira iniciais.
- O cache guarda só o que a home desenha (id, nome, cor, forma, fixado, seção, membros, principal, não lida, data e prévia de até 140 caracteres; formato v2, o v1 é descartado), sem criptografia; sai ao sair ou trocar de servidor (`signOut` e `changeServer` apagam com `await`). Atualização em voo é abortada ao sair ou trocar de conta e nunca grava depois (`lib/home-sync-controller.ts`).

## Diferenças inevitáveis em relação ao `packages/ui`
- `Text`: no web o texto é `<p>/<span>`; no RN todo texto precisa de `<Text>`. O `Button` passa a cor do rótulo por `TextClassContext` (como no reusables).
- **Tamanho dos controles (decisão do dono; vale só no mobile, `packages/ui` e web não mudam):** um pouco acima do web (`Button` `default` 36 / `lg` 40, texto 14; `Input` 36). No mobile: `Button` `default`/`lg` com 44 de altura, pílula (`rounded-full`) e texto 15 semibold (token `text-control`, só do app); `sm` 36 e `xs` 32, com `hitSlop` até 44. `Input`/`InputGroup` com 44, pílula, `px-5` e texto 15. Ícones dentro de botões e campos têm 18; espaço entre botões e campos nas telas de entrada, 12.
- `Avatar` do login: no desktop (`apps/web/app/login/page.tsx`, `BrandPanel`) as props são `color="#ffffff" id="atlas" shape="blob" size={36}` e todo o resto padrão: `animated`, `follow="off"` (não segue o mouse), `breathe=false` (corpo parado) e `state="idle"`. Com 36px o motor só pisca (olhadas aleatórias só de 64px para cima). No mobile o hero tem 102px, então vale o que o motor faz de 64px para cima: piscada de 2 a 6 s (18% dupla) e olhada a cada 3 a 8 s para um ponto sorteado (x ±0,9, y ±0,5), que dura 0,7 a 1,4 s. Aqui o corpo fica parado e os olhos andam até 9px na horizontal e 5px na vertical, num Svg próprio sobreposto ao corpo e animado por estilo de View (animar o `transform` de um `<G>` com `useAnimatedProps` não funciona no react-native-svg nativo). Props `breathe` (padrão falso, como no web), `look` (padrão verdadeiro) e `mood="happy"` (pulo, para usar uma vez no sucesso do login).
- `Avatar`: no web é o motor animado (loop de quadros, olhar que segue o ponteiro, estados do cérebro, clipes 3D de repouso). No mobile o desenho é o mesmo (`stillFrame` + `projectFrame`), com `react-native-reanimated`: respiração (escala, flutuação e balanço leve em ciclo de 3,6 s) e piscada com os tempos do motor (0,12 s até 10%, a cada 2 a 6 s, 18% de piscada dupla 0,28 s depois), respeitando "reduzir movimento"; `animated={false}` deixa estático. Sem corpo/borda de disco: o branco no tema escuro e `#09090b` no claro. `size` é a caixa do SVG (o corpo ocupa ~70%); no hero das telas de entrada é 102, o que dá um corpo de ~72px.
- `Avatar` `mood="happy"`: olhos "^ ^" (a expressão `happy` do motor, sem a transição de 0,28 s entre expressões) e, a cada 4,6 s, o clipe Done_A do web (3,7 s): três pulos de 0,27 / 0,21 / 0,13 raio de corpo, agachar e esticar ancorado na base e balanço lateral de até ~22°. Fica de fora o pitch/yaw 3D do clipe. Entre os pulos respira e pisca. Escolha: o rosto feliz fica fixo e o pulo se repete, porque no web o estado `finished` (rosto feliz + Done_A/B) é passageiro e nas telas de entrada o dono quer o mascote sempre animado.
- **Teclado:** `Screen` usa `KeyboardAvoidingView` em `padding` (Android e iOS) + `ScrollView` centralizado com `keyboardShouldPersistTaps="handled"`; tocar fora ou arrastar fecha o teclado, e o avatar encolhe para 64 com o teclado aberto (`useKeyboardVisible`). Só JS do RN, roda no Expo Go; `softwareKeyboardLayoutMode` não foi alterado.
- `Button`/`Input`/`Badge`: sem `hover`, `focus-visible`, `aria-invalid` e `svg`. `invalid` no `Input` faz o papel de `aria-invalid`. O `touch-hit` (44 px por pseudo-elemento) vira `hitSlop`.
- `Spinner`: o tamanho é `size` do `ActivityIndicator` (`small`/`large`), não `className="size-4"`; a cor vem de `tone`.
- `Badge`: o rótulo é uma string (a `Text` fica dentro do componente), por causa da cor do texto.
- `ChatCard*`: sem `<section>`; o recolher (`ChatCardDetails`) é estado local + `Pressable` (sem Collapsible/Base UI) e o chevron é o caractere "›". O ícone `leading` é um nó RN (ainda não há ícones; entram com a etapa 1).
- `cn`: clsx + tailwind-merge (padrão do reusables) com os mesmos tokens estendidos (`text-body`/`text-caption`, `rounded-card`/`rounded-panel`); o web usa o pacote `cn`.
- Cores em canais `r g b` (`rgb(var(--x) / <alpha-value>)`) para `bg-muted/60` funcionar; as variáveis do RN são opacas. Por isso `border` e `input` do tema escuro (branco a 10% e 15% no web) estão pré-misturados sobre o fundo (`#222223`, `#2e2e30`).
- `rounded-4xl` (botões e inputs) foi definido no `tailwind.config.js`: o Tailwind 3 não o tem.
- `Card` (formulário/seção das telas) não existe no `packages/ui` (o cartão do chat é o `ChatCard`); é um contêiner simples só do app.
- Sem `shadcn/tailwind-animate` e sem Base UI: nada de DOM.

## Riscos
- **SDK vs. Expo Go:** o Expo Go da loja acompanha o SDK novo com atraso. Se o Expo Go do Android ainda não abrir o SDK 58, usar o SDK 57 (`expo@~57`) ou um development build. Confirmar no aparelho antes da etapa 1.
- **NativeWind 4 + React 19.3/RN 0.88:** funciona no export web e no bundle Android (Hermes) da etapa 0; falta rodar no aparelho. Plano B: NativeWind 5 quando sair do rc.
- **Duas fontes de token:** `lib/theme.ts` precisa acompanhar o `globals.css`. Mitigação futura: script que gera o tema a partir do CSS.
- **`@workspace/shared` inteiro no bundle** (≈1,2 MB no web). Aceitável na base; avaliar subcaminhos de import (`@workspace/shared/...`) se pesar no app.
- **Condição `react-native` também em `./avatar/*`:** necessária para o Avatar do mobile importar o motor (`@workspace/shared/avatar/...`) direto do `src`, sem `dist`. Só o Metro a usa.
- **Condição `react-native` no shared:** quem resolver essa condição (outro bundler RN) passa a ler `src`. Web (Next), api e worker não usam; coberto por `turbo typecheck`.
- **Sessão e segurança (etapa 1):** feito, ver "Login (etapa 1)".
- **API/servidor:** o app depende do contrato de `/api/auth/*` e do SSE; mudanças nesses contratos passam a ter mais um consumidor.

## Custo
Sem custo de infraestrutura nem tokens na etapa 0. EAS Update e Build (etapa 2) têm plano gratuito com cotas.

## Como testar
- `pnpm --filter @workspace/mobile exec vitest run` (URL e checagem do servidor, sem rede real).
- `pnpm exec turbo typecheck`.
- `pnpm --filter @workspace/mobile export:web` e abrir `apps/mobile/dist` (prévias em 390x844, tema escuro e claro).
- No aparelho: `pnpm --filter @workspace/mobile start` e abrir no Expo Go (celular e computador na mesma rede).
