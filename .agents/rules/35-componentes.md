# Componentes: o que existe e quando usar

Antes de criar componente, procure aqui. Se existe algo 80% igual, estenda (prop, variante) em vez de copiar.

## `packages/ui/src/components` — primitivos (só React/estilo)
- **Ações e entrada:** `button` (variantes via `cva`), `button-group` (botões colados; as pontas contam só filhos com `data-slot`), `input`, `input-group`, `textarea`, `select`, `switch`, `field`, `label`.
- **Sobreposições:** `dialog` (fecha com Esc e prende o foco), `alert-dialog`/`confirm-alert` (confirmação destrutiva), `sheet` (gaveta, padrão no celular), `popover`, `dropdown-menu`, `context-menu`, `hover-card`, `tooltip`, `overlay-dismiss`.
- **Estrutura:** `collapsible` (seções recolhíveis), `tabs`, `separator`, `sidebar`, `item`, `empty` (estado vazio), `skeleton`, `toaster`.
- **Identidade:** `avatar`, `gradient-avatar`, `badge`, `marker`, `model-capability-badges`.
- **Conteúdo de IA:** `bubble` (balão do chat), `attachment`, `code-block`, `plan-card`, `questionnaire`, `request-card`, `chart` (render de `ChartSpec`).
- Não recrie botão, modal, menu ou anexo com `div`. Primitivos usam Base UI por baixo: o menu aberto injeta spans (focus guards, `aria-owns`) ao redor do gatilho, então não dependa de `:first-child`/`:last-child` ao estilizar irmãos.

## `packages/ui/src/charts` — gráficos (Bklit UI, ver `LICENSE-bklit-ui`)
- Famílias prontas: `line-chart`, `area-chart`, `bar-chart` (vertical/horizontal), `pie-chart`/`ring-chart`, `composed-chart`, `radar-chart`, `funnel-chart`, `gauge`, `scatter-chart`, `heatmap`, `sankey`, `sunburst-chart`, `candlestick-chart`, `live-line-chart`, `choropleth`.
- Acessórios: `chart-legend`, `tooltip`, `reference-area` (meta), `projection-line` (previsão), `markers`, `chart-brush`, `trend-line`.
- Cores só por paleta (`chart-palettes.ts`: primary, monochrome, ocean, sunset, grove, vivid, custom). Para o usuário, nomes de exibição (`CHART_PALETTE_LABELS`).
- Quem gera gráfico (modelo, rotina, painel) usa `ChartSpec` de `packages/shared/src/chart-spec.ts` (line, area, bar com `orientation`, pie, composed, radar, funnel, gauge). Campo desconhecido = erro. Não monte gráfico solto com dados ad hoc na UI.

## `apps/web/components/ai-elements` — blocos de IA reaproveitáveis
- `pages/` — **Painéis**: `page-view.tsx` renderiza a árvore v2 de `packages/shared/src/page-spec.ts`. Nós: section, grid, stack, card, tabs/tab, divider, stat, chart, bar_list, table, progress, badge, callout, timeline, kanban, list, text, heading (tons neutral/positive/warning/critical/accent). Componentes em `pages/components/` (layout, stat, bars, chart, table, collections, feedback, text). Componente novo de painel = nó novo no spec (shared) + componente aqui + validação + teste.
- `chart/`, `files/`, `images/`, `share/` (copiar/baixar imagem, link público), `routines/`, `subagents/`, `confirm/`, `login/`, `connectors/`, `skills/`, `bots/`, `bot-messages/`, `email/`, `dev-session/`, `run-inspector/`, `tool-budget/`, `model-selector.tsx`, `attachments.tsx`, `chain-of-thought.tsx`.

## `apps/web/components/ui/templates/template-4` — telas
- `chat-thread/`: `message-row` (escolhe o card pelo `kind`), `assistant-message`, `revised-draft` (não renderizado: a conversa esconde o rascunho revisado), `chat-composer` (+ `composer-scroll`, `mention-popup`, anexos), `chat-add-menu` (gaveta no celular) / `chat-add-dropdown` (menu compacto no desktop), cards de `task-list`, `code-run`, `compaction`, `questionnaire`, `email-received`.
- `chat-context-panel/`: painel lateral do bot. Abas Biblioteca · Computador · E-mail. Biblioteca = seções recolhíveis (`library-section`) de Painéis (`pages-library`, `page-group-block`), Documentos e Rotinas (`routines-section`, `routine-group-block`, `routine-card`). Engrenagem = `agent-settings` (Geral + Sobre; sem abas de Memória/Lições).
- `chat-sidebar/`, `marketplace/`, `autonomy/`, `agent-avatar`, `group-avatar`, `live-agent-avatar`.
- Tela com mais de ~250 linhas: extraia subcomponentes na mesma pasta.

## Cards do chat
- Cada card é um evento do runtime persistido como mensagem com `role` próprio (chart, page, file, routine, task-list, subagents, revised-draft, compaction…), parseado em `packages/shared` e restaurado por `use-atlas-chat.ts`.
- Identidade estável entre ao vivo e persistido (`chartId`, `pageId`, `routineId` + run) e dedupe em `apps/web/lib/thread-merge.ts`. Card novo = tipo em shared + persistência no db + chave de dedupe + teste do merge.
- Card de escrita (rotina, painel, arquivo, perfil) mostra resultado visível; card de leitura não precisa.

## Estado e dados no front
- Servidor só por `lib/atlas-api.ts` e `use-atlas-chat.ts`; eventos tipados em `packages/shared`. Nada de `fetch` solto em componente.
- Estilo: Tailwind + `cn`, variantes com `cva`. Ícones de marca: SVG com `fill="currentColor"`. Botão de ícone tem `aria-label`.
