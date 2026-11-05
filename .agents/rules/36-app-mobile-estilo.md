# App mobile: guia de estilo (decisões do dono)

Vale para toda tela, folha e componente de `apps/mobile`. Complementa a seção "App mobile: pele e peças" de
`35-componentes.md` (tokens e peças). Decisões tomadas pelo dono em 11/2026; mude só com pedido dele.

## Cor e fundo
- **Fundo único de tela no escuro: `#1a1a1a`** (`screen`/`background` em `lib/surfaces.ts` e `lib/color-tokens.ts`). Vale para
  TODAS as telas, inclusive Configurações, Conta, Uso e Aparência. Nada de tom próprio por tela.
- Folhas e gavetas usam o token `sheet`; cartões e grupos `surface` + `surfaceEdge`; chrome `chromeFill`/`chromeEdge`.
- Hex só em `lib/surfaces.ts` e `lib/color-tokens.ts`; o resto lê `useSurfaces()` ou o tema. Mudou o fundo? Reequilibre
  `bubble`, `chatCard`, `chatCardControl` e o chrome junto, mantendo a distância entre eles.
- Splash nativo e abertura animada ficam em `#09090b` até o próximo APK (o splash só muda com build).

## Cascas (cartões com borda)
- Cartão e grupo de linhas = `SurfaceCard`/`SurfaceGroup`, sempre com contorno `surfaceEdge` e raio `SURFACE_RADIUS` (21).
- Linha pressionável = `SurfaceRow`: altura mínima 56 (`min-h-14`), `px-5`, gap 16 entre ícone e texto, texto `text-control`,
  divisor automático de ponta a ponta. Lista de opções com ✓ = `SurfaceRow radio={{ checked }}` + `CheckIcon`.
- Rótulo de seção pequeno e `muted` acima do grupo ("Bot", "App"). Ação destrutiva (Sair) em grupo próprio, texto `destructive`.

## Botões
- Voltar, fechar, "+", "…", compartilhar = `ChromeButton` (redondo, com borda `chromeEdge`). Tamanhos fixos
  `CHROME_BUTTON_SIZE`: `lg` 47, `md` 44, `sm` 36, `xs` 30. Não recrie botão redondo com `View`.
- Botão dentro de gaveta (Salvar, Cancelar, Entendi) = `SheetButton`: altura 56, `px-5`, `gap-2`, texto `text-control`,
  raio `SURFACE_RADIUS`, largura cheia (Cancelar de cabeçalho pode ser `w-auto` com a mesma altura).
- Pílulas (bot no topo, chips) = `ChromePill`. Interruptor = `ToggleSwitch` (único; nunca `Switch` do RN).

## Cabeçalhos flutuantes (padrão até o dono pedir o contrário)
- Botões do topo e a busca/composer **flutuam sobre o conteúdo**: posição absoluta com área segura e conteúdo rolando por
  baixo. **Nunca** faixa opaca cortando o conteúdo.
- **Home e Configurações (Conta, Uso, Aparência) flutuam com `Fade curve="linear"`** (decisão do dono, 05/11, revista: sem
  degradê ficou estranho): atrás do cabeçalho (avatar + "+") e do `FloatingHeaderScroll`, 2 stops
  (opaco na borda → transparente, uniforme), com altura do cabeçalho + 24. **O rodapé da home (grade + Buscar) fica SEM
  degradê** (decisão do dono, 05/11): o `Fade` quebrava em celulares com barra de navegação inferior. O **chat mantém o `Fade` padrão** (segura
  opacidade até 55%) no topo e no composer. Stops em `lib/fade-stops.ts`.
- Peça: `FloatingHeaderScroll` (Configurações, Conta, Uso, Aparência) e o mesmo padrão na home. Padding do conteúdo
  medido por `onLayout`.
- Subtela de Configurações: `ScreenHeader align="left"` (voltar + título à esquerda). Tela principal: só o X.

## Gaveta única
- **Toda gaveta de baixo usa `DraggableSheet`**, a mesma do menu de mensagem pressionada: fundo `sheet`, `rounded-t-panel`,
  alça, fundo escurecido, arrastar para fechar, sobe com o teclado (sem espaçador manual).
- Conteúdo da gaveta = `SurfaceGroup`/`SurfaceRow` e `SheetButton`. Variação nova vira prop da base, nunca outro `Modal`.
- Guarda: `lib/visual-base-guard.test.ts` só aceita `Modal` do RN na base e nos menus ancorados (lista fixa) e proíbe
  `animationType="slide"`.

## Campos
- Campos lado a lado (ex.: Nome e E-mail) usam a **mesma peça** (`ChromeInput`), com a mesma altura, raio, borda e fonte.
  Campo não editável = `readOnly`, mesma aparência (sem cursor, sem opacidade).

## Status do avatar (home)
- Bolinha no canto de baixo à direita do avatar (`StatusDot`, medidas do web: 26% do corpo, entre 10 e 16, anel na cor do fundo).
- **Prioridade: trabalhando > precisa de você > não lida.** Uma bolinha só; a estrela do bot principal só aparece sem bolinha.
- **Cores** (tokens em `lib/surfaces.ts`): trabalhando = verde `statusWorking` (`#22c55e`, igual ao web); precisa de você = **amarelo**, token de estado `warning` do tema (`statusNeeds`, o mesmo do selo "Precisa de você" dos cards); não lida = azul `statusUnread` (`#2496e8`, igual ao web). Decisão do dono, 05/11. Nunca hex solto em tela.
- Fonte do dado: `working` de `/v1/bots` + avisos `run` do hub (`lib/bot-waiting.ts`); "precisa de você" = run `waiting_user` ou última mensagem é card pendente legível (`lib/avatar-status.ts`).

## Chat
- Card novo = `ChatCard` (variantes `card`/`activity`), largura do balão (`BUBBLE_WIDTH_CLASS`).
- Anexos no composer: tiles quadrados de 88 pt, raio 14, X branco no canto; erro com borda `destructive` e motivo embaixo.
- Barra de voz e composer usam a mesma lógica de empilhar (`useStackedLayout`): uma linha = pílula; quebrou = texto em cima
  com largura toda e botões na base.
- Cor de destaque (Configurações › Aparência): `accent` "neutral" (botões em foreground) ou "bot" (cor do bot; padrão),
  via `useAccentColors`. Avatares dos bots sempre na cor deles.

## Identidade
- Ícone do app, abertura e mascote vêm do **motor de avatar real** (`packages/shared/src/avatar`), forma `squircle` branca,
  pose da lista. Abertura: giro feliz `Rotation_A` no tamanho do splash, sem crescer, saída só com fade; respeita
  "reduzir animações".

## Segurança de entrega (OTA)
- `app/_layout.tsx` raiz precisa do `export default`; não mexa nele sem rodar o smoke web (export + Playwright abrindo `/`
  e as rotas novas, sem `pageerror`). Nunca chame `Appearance.setColorScheme` (recria a Activity no Android).
- Mudança visível: prévia ao dono antes de publicar; publique só com o ok dele.
