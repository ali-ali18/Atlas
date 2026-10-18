# PLANO-FRONT — Front no estilo de referência (Grok Bot)

Mapa: issue #88. Fases: #81 (FR1) a #87 (FR7). Branch de trabalho: `front/grok` (worktree `../atlas-front`).

> **Entrega contínua:** cada fase verde é integrada por **ff-merge em `rodada/desempenho`**, para o usuário acompanhar ao vivo no dev server dele. O diretório principal fica só com arquivos não rastreados dele; nunca há modificação rastreada lá antes do ff.

Referência estudada: `docs/pesquisa/motor-de-avatares.md` (análise do app de referência, 12/10/2026). **Usamos só a técnica** (SVG procedural por quadro, olhos em cápsula com ajuste por forma, semente por avatar, loop que dorme). **Não copiamos** caminhos, tabelas de proporção, paleta nem código: corpos, cores e proporções saem dos nossos `bloub` em `packages/ui`.

## 1. Decisões do usuário

- **Pseudo-3D em SVG, sem three.js:** volume por gradiente radial (luz, brilho, sombra suave) e olhos com profundidade (ponto especular).
- **Comportamentos (todos na FR1):**
  - (a) run ativo: a cabeça balança; ocioso: respira (escala 1 + 0,02·sin) e pisca com sorteio por semente a cada 2 a 6 s (~120 ms);
  - (b) os olhos seguem o mouse (lerp, limitado a poucas unidades): sempre no avatar grande do painel, no hover na barra lateral;
  - (c) clique: squash/bounce e expressão que cicla (happy, surprised, wink);
  - (d) N cutucadas numa janela curta: `angry` (expressão nossa) por alguns segundos, depois decai ao neutro.
- **Layout alvo (fases seguintes):** ver as seções FR2 a FR6.
- **Última fase:** bot fala com bot (FR7), só do mesmo usuário, com teste de IDOR.

## 2. Auditoria da UI atual (arquivo:linha, em 12/10/2026)

| Área | Hoje | Onde |
|---|---|---|
| Casca | `template-4-client.tsx` (1843 linhas) monta `ChatSidebar` (l.1533), `ChatThread` (l.1586) e `ChatContextPanel` (l.1674). Sidebar usa `Sidebar collapsible="icon"` | `apps/web/components/ui/templates/template-4/template-4-client.tsx`, `chat-sidebar/chat-sidebar.tsx:267` |
| Lista/rail | `AgentAvatars` decide o avatar (grupo = até 3 sobrepostos); `PinnedBotButton` (avatar 72); `NotificationAvatar` com dot azul | `chat-sidebar/agent-avatars.tsx`, `pinned-bot-button.tsx`, `notification-avatar.tsx` |
| Chat | `ChatThread` (660 linhas) chama `useAtlasChat` (l.166); `WorkingIndicator` mostra o avatar com expressões durante o run | `chat-thread/chat-thread.tsx:166`, `working-indicator.tsx:57` |
| Composer | ditado com `AudioLinesIcon`/`AnimatedAudioLines` (manter) | `chat-thread/chat-composer.tsx:340,378` |
| Painel direito | `ChatContextPanel` (595 linhas): cartão da VM no topo (`aspect-video`, l.~330), seção Rotinas (l.409-540) com lista de cards + `Switch` (l.481) e `RoutineCreateChooser`; views `settings`/`routine` sobrepõem o conteúdo (l.546-570). Fundo `bg-sidebar/40` com `border-l` | `chat-context-panel/chat-context-panel.tsx` |
| Rotinas (API) | CRUD em `/v1/bots/:botId/routines` (+ `/run`, `/runs`, `rotate-secret`, `routine-runs`) | `apps/api/src/routes/routines.ts:322-570` |
| Sandbox | snapshot em `<img>` + `AgentPointerOverlay`; viewer noVNC em `SandboxViewerDialog` (modal); geometria em `lib/agent-pointer.ts` | `agent-pointer-overlay.tsx:58,148`, `sandbox-viewer-dialog.tsx:14`, `apps/web/lib/agent-pointer.ts` |
| Arquivos | só `GET /v1/files/:id` e `/preview` (por id); **não há listagem por bot/conversa**. Model `Artifact` tem `userId`, `runId`, `conversationId`, `kind`, `uri`, `metaJson` | `apps/api/src/routes/files.ts:30,50`, `packages/db/prisma/schema.prisma:343` |
| Avatar | `bloub` = 8 corpos (`shapes.ts`, viewBox -125..125, centro ~0,0, raio ~100) + 16 poses de olhos (`poses.ts`) animadas por morph (`BloubFace`, 365 linhas) ou SVG pronto (`BloubAvatar`). `AvatarEditor` escolhe forma (8) e cor (12) | `packages/ui/src/components/bloub/*`, `chat-context-panel/avatar-editor.tsx:45` |
| Sinal de run | `useAtlasChat` expõe `sending` e `runStatus`; `ChatThread` deriva `working`/`runActive` (l.~401). O estado **mora dentro do ChatThread**: sidebar e painel não o veem | `apps/web/hooks/use-atlas-chat.ts:865,1857`, `chat-thread.tsx` |
| Rótulo do bot | **não existe**. `Bot` tem `name`, `snippet` (subtítulo da lista), `description` (texto livre usado nas configurações) | `packages/db/prisma/schema.prisma:176-200`, `agent-settings.tsx:159-168` |
| Bot a bot | **não existe** tool nem vínculo de run. Há plano antigo em `PLANO-AGENTE-V2/08-bots-conversam.md` (`ask_bot`) | — |

Conclusões: (1) o sinal "trabalhando" precisa sair do ChatThread (resolvido na FR1 com `lib/bot-activity.ts`); (2) `Bot.label` exige migration (FR2); (3) Biblioteca exige endpoint novo de listagem escopado (FR5); (4) o painel acumula VM + rotinas num único scroll: vira abas na FR2/FR6.

## 3. Motor de avatar: especificação (FR1)

### 3.1 Camadas

```
packages/ui/src/lib/
  avatar-engine.ts      motor puro: estado, física, expressões (sem DOM/React)
  avatar-scene.ts       ajuste de olhos por forma, atributos por quadro, geometria do volume
  avatar-svg.ts         renderAvatarSvg(): string estática (SSR, miniaturas)
  avatar-scheduler.ts   UM rAF + UM pointermove para todos; dorme quando assenta
packages/ui/src/components/bloub/live-avatar.tsx   LiveAvatar (React, escreve via refs)
apps/web/lib/bot-activity.ts                       mapa botId -> trabalhando (useSyncExternalStore)
apps/web/.../template-4/live-agent-avatar.tsx      liga cor dos olhos + "trabalhando"
```

Camadas respeitadas: o motor é TS puro dentro de `packages/ui` (não importa db/api); a web só consome.

### 3.2 API

```ts
createAvatarEngine({ shape, seed, breathe?, random? }): AvatarEngine
engine.advance(dtMs): AvatarFrame      // único jeito de o tempo passar (relógio injetado)
engine.setWorking(bool) / setGaze({x,y}|null) / poke() / blink()
engine.setExpression(e) / setBody(shape) / expression()
engine.isSettled() / nextWakeMs() / frameIntervalMs()
renderAvatarSvg({ shape, bodyColor, eyeColor, size, expression, idPrefix }): string
<LiveAvatar shape bodyColor eyeColor size seed working expression follow breathe interactive pokeOnClick reducedMotion />
```

### 3.3 Máquina de estados

| Estado | Entra por | Efeito | Sai por |
|---|---|---|---|
| idle | padrão | corpo parado (ou respira se `breathe`); piscada sorteada 2-6 s, 120 ms | qualquer estímulo |
| working | `setWorking(true)` | rotação ±3,5° e vai-e-vem 2,5 u (1,6 s), bob 3 u; peso suavizado (τ 260 ms) | `setWorking(false)` |
| gaze | `setGaze(v)` | alvo = v limitado a comprimento 1 × 6,5 u; lerp τ 90 ms; corpo acompanha 0,4× | `setGaze(null)` ou ponteiro sai da janela |
| poke | `poke()` | mola (k 220, c 12) comprime o corpo; expressão cicla happy → surprised → wink por 1,6 s | assenta |
| angry | 5 pokes em 2,5 s | expressão `angry` 4 s (renova a cada poke) | tempo; volta à expressão base |
| sleepy/neutral/... | `setExpression` | só os olhos mudam (altura, largura, inclinação, deslocamento) | outro `setExpression` |

Sementes: `hashSeed(botId)` alimenta um PRNG (mulberry32); o primeiro sorteio dá a fase, o seguinte o intervalo da primeira piscada, então bots diferentes não piscam em uníssono e os testes são reprodutíveis.

### 3.4 Orçamento de desempenho

- **40 avatares na barra lateral sem jank:** avatar assentado não consome quadros. O agendador dorme e acorda por **um** `setTimeout` até a piscada mais próxima. `breathe` fica desligado na lista (só o avatar grande respira, a 30 fps).
- **~0 CPU quando assentado:** `isSettled()` verdadeiro = nenhum rAF agendado, nenhum listener de quadro. Os listeners globais (pointermove, visibilitychange, pointerleave) só existem enquanto há avatar montado.
- Teto de 60 fps (ignora rAF a menos de 15 ms); trabalho/respiração a 30 fps (`ambientFrameMs`); interação a 60 fps.
- `pointermove` é coalescido em um rAF e só toca avatares visíveis com `follow="always"` ou com hover.
- `document.hidden` para o loop e os timers; `IntersectionObserver` por avatar pausa os fora da tela.
- Sem estado do React por quadro: o JSX é renderizado uma vez; o agendador escreve atributos por ref, com cache do último valor (só grava o que mudou).
- Gradientes: `radialGradient` (sem `filter`/blur, que é caro com dezenas de avatares); ids únicos por `useId`.

### 3.5 Acessibilidade

- SVG sempre `aria-hidden`. O rótulo vai no invólucro: `<button aria-label>` quando clicável (painel), `role="img"` quando só ilustrativo, nada quando decorativo.
- `prefers-reduced-motion: reduce` (hook `useSyncExternalStore`): não registra no agendador, então sem piscada, olhar, respiração, balanço nem cutucada; mostra o quadro estático da expressão.
- Clique que cutuca nunca é o único caminho para algo: é só reação visual.

## 4. Fases

Esforço: S (horas a ~1 dia), M (~2 a 4 dias), L (> 1 semana). "Reuso ui" = o que sai de `packages/ui`.

### FR1 — Motor de avatar vivo (#81) — esforço M — **entregue**
- **Arquivos:** `packages/ui/src/lib/avatar-{engine,scene,svg,scheduler}.ts` (+ testes), `packages/ui/src/components/bloub/live-avatar.tsx`, `packages/ui/vitest.config.ts`; web: `lib/bot-activity.ts`, `template-4/live-agent-avatar.tsx`, `notification-avatar.tsx`, `chat-sidebar/{agent-avatars,pinned-bot-button}.tsx`, `chat-thread/chat-thread.tsx` (publica "trabalhando"), `chat-context-panel/chat-context-panel.tsx` (avatar grande no topo).
- **Reuso ui:** corpos `bloubShapes`, `cn`. `BloubFace`/`BloubAvatar` continuam no AvatarEditor, mobile, criação de bot e `WorkingIndicator`.
- **Testes:** motor (piscada determinística e desencontrada por semente, olhar com limite e lerp, ciclo de cutucada, raiva e decaimento, balanço, respiração em ±2%, assentar e acordar), contenção dos olhos dentro do corpo em todas as formas/expressões/olhares, agendador com rAF falso (dorme, 60 fps, aba oculta, fora da tela, hover, listeners), SSR do componente e do export, reduced motion.
- **Aceite:** typecheck verde; suítes verdes; build do web; sidebar/painel mostram o avatar vivo; o avatar balança durante um run e para ao terminar; avatar assentado sem rAF.
- **Riscos:** `BloubFace` (morph das 16 poses) e o avatar vivo coexistem até a FR2/FR3 migrarem o resto; `WorkingIndicator` ainda usa as poses antigas.

### FR2 — Casca do painel direito + abas, Detalhes (#82) — esforço M
- **Layout:** fundo **igual ao do chat** (hoje `bg-sidebar/40`), só um divisor `border-l`; topo com compartilhar/exportar e fechar; avatar grande ao vivo com lápis "Editar avatar" no hover (abre `AvatarEditor`); nome e rótulo editável ("Adicionar um rótulo"). Abas **Detalhes / Biblioteca / Computador**.
- **Detalhes:** rotinas como **cards compactos com toggle e frase-resumo** ("Uma vez · 03/10 às 10:00", "A cada 50 min"), **controladas pelo agente: sem botão "Criar rotina"**. Vazio: "Rotinas são tarefas recorrentes que este Bot executa de acordo com uma programação. Peça a ele no chat para configurar uma." Formulário (`RoutineEditor`) só como fallback recolhido ao abrir um card.
- **Migration:** `Bot.label String?` (rótulo curto; não reutiliza `description`, que alimenta as configurações). **Antes: backup com `pg_dump` dentro do container `atlas-agent-postgres-1` para `C:\Dev\Personal\atlas-backups\`.** `PATCH /v1/bots/:id` aceita `label` (até 40 caracteres, trim), escopado por dono; `packages/shared` ganha o campo no tipo; sem rótulo mostra o placeholder.
- **Arquivos:** `chat-context-panel/*` (extrair `panel-header.tsx`, `panel-tabs.tsx`, `routine-card.tsx`, `routines-section.tsx`; o arquivo de 595 linhas não cresce), `packages/db` (migration + função com `userId`), `apps/api/src/routes/bots.ts`, `packages/shared`.
- **Reuso ui:** `Button`, `Switch`, `Tooltip`, `Separator`, tabs (criar `packages/ui/src/components/tabs.tsx` só se não existir equivalente), `Dialog` do editor de avatar.
- **Testes:** frase-resumo das rotinas (puras em `shared`, já existem os formatadores), SSR do cabeçalho e do estado vazio (sem botão de criar), rota `label` (feliz, tamanho, **usuário B não altera o rótulo do bot de A → 404**), migration aplicada em banco de teste.
- **Aceite:** painel sem seção "Criar rotina"; o toggle liga/desliga pela API existente; rótulo persiste; a aba Computador/Biblioteca existem (conteúdo nas FR5/FR6).
- **Riscos:** migration (backup obrigatório e `prisma generate` no Windows pode dar EPERM); mexe em arquivos de tela do `template-4` que o usuário também edita (conferir `git status` antes de cada fase; nunca formatar arquivo alheio).

### FR3 — Rail esquerdo (#83) — esforço S
- **Layout:** só avatares, separadores (entre fixados e o resto), badges (notificação, rodando), e embaixo "+", marketplace e avatar do usuário. Reaproveita `LiveAvatar` com `follow="hover"` (já feito na FR1).
- **Arquivos:** `chat-sidebar/{chat-sidebar,agent-list,chat-sidebar-footer,pinned-agents-zone}.tsx`.
- **Reuso ui:** `Sidebar` (collapsible icon), `Tooltip`, `Badge`, `Separator`.
- **Testes:** SSR do rail (ordem, badge, rodapé), orçamento: um teste de agendador com 40 avatares montados prova rAF zerado quando assentam (já coberto na FR1, repetir com a lista real).
- **Aceite:** 40 bots no rail sem jank (Performance do navegador: 0 quadros de script com tudo assentado); rail recolhido legível; a11y (cada botão tem `aria-label` com o nome e o estado).
- **Riscos:** `agent-list.tsx` tem 500 linhas; extrair antes de crescer.

### FR4 — Detalhes do chat (#84) — esforço M
- **Layout:** pílula com o nome do bot; separadores de data entre mensagens; pílula "↑ N novas mensagens ✕" quando há mensagens abaixo do scroll (substitui/complementa `scroll-to-bottom.tsx`); fontes inline com globo + nome do site (domínio) nas respostas com citação; **mantém o ditado com `AudioLines`**.
- **Arquivos:** `chat-thread/{chat-thread,message-row,assistant-message,scroll-to-bottom}.tsx`; helpers puros em `apps/web/lib` (`date-separators.ts`, `source-label.ts`) ou `packages/shared` se a API também usar.
- **Reuso ui:** `Badge`, `Bubble`, `Marker`, `Separator`.
- **Testes:** agrupamento por dia (fuso, virada de dia, `now` injetado), contagem de novas mensagens, rótulo da fonte (domínio sem `www`, URL inválida), SSR dos componentes.
- **Aceite:** datas corretas em pt-BR e no fuso do usuário; a pílula some ao chegar ao fim; links externos com `rel="noopener noreferrer"`.
- **Riscos:** `chat-thread.tsx` (660 linhas) e `use-atlas-chat.ts` são quentes; mudanças pequenas e testadas.

### FR5 — Biblioteca (#85) — esforço M
- **Layout:** aba com grade de arquivos, artefatos e imagens do bot, com prévia (reusa `GET /v1/files/:id/preview`, `file-card.ts` e os viewers de `ai-elements/images`).
- **API:** `GET /v1/bots/:botId/library?cursor=` (paginado) escopado pela sessão (`scopeFor`); filtra `Artifact` por `userId` e `conversationId` do bot. Recurso de outro dono: **404**. Sem `userId` vindo de body/query.
- **Arquivos:** `apps/api/src/routes/files.ts` (ou `library.ts`), `packages/db` (listagem com `userId`), `chat-context-panel/library-tab.tsx`, `lib/atlas-api.ts`.
- **Testes (obrigatório):** feliz; paginação; **usuário B não lista a biblioteca do bot de A (404) nem vê artefatos de A**; legado com `userId` nulo só visível ao dono do run.
- **Aceite:** abrir um arquivo da biblioteca mostra a prévia; vazio com texto explicativo; nada de `fetch` solto em componente.
- **Riscos:** artefatos antigos sem `userId` (dono derivado do run): a consulta precisa do `OR` correto, coberto por teste.

### FR6 — Computador (#86) — esforço M
- **Layout:** a VM (snapshot ou noVNC) e o cursor do agente passam para a aba, com o mesmo `AgentPointerLayer`; o modal `SandboxViewerDialog` continua para tela cheia. O cartão do topo do painel sai.
- **Arquivos:** `chat-context-panel/computer-tab.tsx` (extrai o bloco de snapshot/overlay de `chat-context-panel.tsx`), reaproveita `agent-pointer-overlay.tsx` e `lib/agent-pointer.ts`.
- **Testes:** SSR da aba (sem sessão: botão "Iniciar sandbox"; com sessão: imagem + overlay), mapeamento do ponteiro (testes existentes em `lib/agent-pointer.test.ts`), a11y dos botões.
- **Aceite:** sessão ativa mostra o snapshot e o cursor do agente; sem sessão, o avatar vivo no lugar da imagem; botão de abrir a VM com `aria-label`.
- **Riscos:** o snapshot atualiza a cada poucos segundos; manter o `key` por sessão para não piscar.

### FR7 — Bot fala com bot (#87) — esforço L
- **Comportamento:** o agente chama uma tool (`message_bot({ bot, message })`) que cria um run filho **como o bot destino** (identidade, memória, modelo e idioma dele), reaproveitando o caminho de subagentes. No chat: "Enviou mensagem para <bot>" no remetente e "Mensagem de <bot>" no destino, com mini avatar (`LiveAvatar` pequeno, `follow="off"`).
- **Segurança (40-seguranca):** **só bots do mesmo usuário** (resolver por `ownerIds` da sessão do run); nunca confiar em `botId` de body; grupo e o próprio bot não valem; profundidade 1 (sem ping-pong); resultado do bot destino é dado não confiável para o remetente. **Teste de IDOR obrigatório:** usuário B não alcança bot de A (nem por nome nem por id); run filho herda o `userId`.
- **Arquivos:** `packages/agent-runtime/src/tools/message-bot.ts` (módulo próprio; `computer-use.ts` não cresce), `packages/db` (vínculo `parentRunId`/origem, com `userId`), `apps/api` (eventos), `packages/shared` (tipo do evento), web (`ai-elements/bot-message-card.tsx`).
- **Testes:** `computer-use*.test.ts` com LLM mockado (a tool aparece/some, valida args, emite os eventos), IDOR, profundidade, falha do filho não derruba o pai, SSR do card.
- **Aceite:** conversa de ponta a ponta entre dois bots do mesmo usuário; labels e mini avatar corretos nos dois lados; prompt da tool em inglês (60-agente) com teste da string.
- **Riscos:** alto (segurança, custo, loops). Prompt neutro, sem exemplos de nicho; relacionar com `PLANO-AGENTE-V2/08-bots-conversam.md` antes de começar para não duplicar `ask_bot`.

## 5. Ordem e integração

1. FR1 (feito) → ff em `rodada/desempenho`.
2. FR2 → FR3 → FR4 → FR5 → FR6 (FR5 e FR6 podem ir em paralelo depois da FR2).
3. FR7 por último.

Por fase: worktree `../atlas-front` (branch `front/grok`) → testes + `pnpm exec turbo typecheck` + build do web → `git -C <principal> status --porcelain` sem modificação rastreada → `git merge --ff-only front/grok`. Se `rodada/desempenho` andou, rebase de `front/grok` e reroda os testes antes do ff. **Nunca `git push`.**

## 6. Como testar

```bash
pnpm --filter @workspace/ui test                     # motor, agendador, SSR (vitest)
cd apps/web && ../api/node_modules/.bin/tsx --test lib/bot-activity.test.ts "components/**/*.test.tsx"
pnpm --filter @workspace/shared build                # os testes do web importam shared/dist
pnpm exec turbo typecheck
pnpm --filter web build
```
