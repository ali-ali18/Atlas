# App mobile (Android e iOS)

- **Status:** em andamento (etapa 0 entregue)
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
1. **Conexão, login Google + e-mail, sincronização e chat ao vivo:** better-auth (Google e link mágico) com sessão guardada no `expo-secure-store`, lista de conversas, SSE do chat. Roda no Expo Go.
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

## Diferenças inevitáveis em relação ao `packages/ui`
- `Text`: no web o texto é `<p>/<span>`; no RN todo texto precisa de `<Text>`. O `Button` passa a cor do rótulo por `TextClassContext` (como no reusables).
- **Tamanho dos controles (decisão do dono, no estilo do app do Grok; vale só no mobile, `packages/ui` e web não mudam):** `Button` `default`/`lg` com 56 de altura, pílula (`rounded-full`) e texto 17 semibold (token `text-control`, só do app); `sm` 44; `xs` 36 mais `hitSlop` até 44. `Input`/`InputGroup` com 56, pílula, `px-5` e texto 17 (também evita o zoom do teclado). Ícones dentro de botões e campos têm 20. No web o padrão é `h-9` e `text-sm`.
- `Avatar`: no web é o motor animado (loop de quadros, olhar que segue o ponteiro, estados do cérebro, clipes 3D de repouso). No mobile o desenho é o mesmo (`stillFrame` + `projectFrame`), com `react-native-reanimated`: respiração (escala, flutuação e balanço leve em ciclo de 3,6 s) e piscada com os tempos do motor (0,12 s até 10%, a cada 2 a 6 s, 18% de piscada dupla 0,28 s depois), respeitando "reduzir movimento"; `animated={false}` deixa estático. Sem corpo/borda de disco: o branco no tema escuro e `#09090b` no claro. `size` é a caixa do SVG (o corpo ocupa ~70%).
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
- **Sessão e segurança (etapa 1):** token só no cofre do aparelho, cookies do better-auth com o `origin` do servidor informado, nunca logar token; só `https` fora de desenvolvimento.
- **API/servidor:** o app depende do contrato de `/api/auth/*` e do SSE; mudanças nesses contratos passam a ter mais um consumidor.

## Custo
Sem custo de infraestrutura nem tokens na etapa 0. EAS Update e Build (etapa 2) têm plano gratuito com cotas.

## Como testar
- `pnpm --filter @workspace/mobile exec vitest run` (URL e checagem do servidor, sem rede real).
- `pnpm exec turbo typecheck`.
- `pnpm --filter @workspace/mobile export:web` e abrir `apps/mobile/dist` (prévias em 390x844, tema escuro e claro).
- No aparelho: `pnpm --filter @workspace/mobile start` e abrir no Expo Go (celular e computador na mesma rede).
