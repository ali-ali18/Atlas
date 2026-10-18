# Plano: motor de avatares no estilo do Grok Bot

Plano para construir um motor de avatares procedural com a **mesma arquitetura** do "Motion Lab" do Grok Bot (ver `Motor-de-Avatares-GrokBot.md`).

**Regra do projeto:** reproduzir a **arquitetura e a técnica**; formas, paths, proporções dos olhos e cores são **criados por você**.

---

## Visão geral da arquitetura

```
┌───────────────────────────────────────────────────────────────┐
│ <Avatar id shape color state isFollowingPointer size />       │  React (camada 5)
└───────────────┬───────────────────────────────────────────────┘
                │ props → comandos
┌───────────────▼──────────────┐   ┌───────────────────────────┐
│ Ticker (rAF, fps cap,        │──▶│ StateMachine (comportamento│  camada 4
│ IntersectionObserver, sleep) │   │ idle/happy/spin, seed)     │
└───────────────┬──────────────┘   └─────────────┬─────────────┘
                │ advance(dt)                    │ comandos
┌───────────────▼────────────────────────────────▼─────────────┐
│ Character (modelo): body, morph, gaze, blink, expression,    │  camada 3
│ poke → frame()                                               │
└───────────────┬──────────────────────────────────────────────┘
                │ frame
┌───────────────▼──────────────┐   ┌───────────────────────────┐
│ Geometry: shapes → pontos,   │   │ Renderer: pontos → SVG    │  camadas 1 e 2
│ eyes layout, morph blend     │──▶│ string (animado/estático) │
└──────────────────────────────┘   └───────────────────────────┘
```

Princípio central: **o modelo é puro (sem DOM)**. Ele recebe `dt` e devolve um *frame* (dados). O renderer converte o frame em SVG. O React só liga as peças. Isso deixa tudo testável e permite exportar SVG estático com o mesmo código.

---

## Estrutura de pastas

```
avatar-engine/
├─ src/
│  ├─ geometry/
│  │  ├─ shapes.ts        # catálogo de formas → contorno (pontos)
│  │  ├─ eyes.ts          # tabela de ajuste dos olhos por forma
│  │  ├─ morph.ts         # reamostragem + mistura de contornos
│  │  └─ math.ts          # lerp, spring, hash, rng com seed
│  ├─ model/
│  │  ├─ character.ts     # Character: estado + advance(dt) + frame()
│  │  ├─ expressions.ts   # neutral, happy, sleepy... (forma dos olhos)
│  │  └─ behavior.ts      # StateMachine: idle, blink aleatório, spin
│  ├─ render/
│  │  ├─ svg.ts           # frame → string SVG
│  │  └─ still.ts         # exportar SVG estático / data URL
│  ├─ runtime/
│  │  └─ ticker.ts        # rAF, fps cap, pausa, sleep/wake
│  ├─ react/
│  │  └─ Avatar.tsx       # componente + ref imperativo
│  ├─ identity.ts         # id → forma/cor/seed (hash)
│  └─ index.ts
├─ playground/            # página de testes (Vite)
└─ tests/
```

Stack sugerida: **TypeScript + Vite + React**. Sem dependências de gráficos.

---

## Fase 1: Geometria (base de tudo)

**Objetivo:** cada forma vira um contorno de **N pontos fixos** (ex.: 64), em uma área normalizada de 0 a 1.

- [ ] `math.ts`: `lerp`, `clamp`, `hash(string)` (FNV-1a), `rng(seed)` (mulberry32).
- [ ] `shapes.ts`: cada forma é uma função `(t: 0..1) → [x, y]` **ou** um path SVG desenhado no Figma.
  - Fórmulas úteis:
    - **Squircle:** superelipse `|x|^n + |y|^n = 1` com `n ≈ 4`.
    - **Blob/pebble/egg:** elipse com raio modulado `r(θ) = 1 + a·sin(kθ + φ)`.
    - **Cloud/flower:** raio com ondas `r(θ) = 1 + 0.12·|sin(5θ)|`.
    - **Hex/gem/wedge/house:** polígono com **cantos arredondados** (fillet).
  - Paths do Figma: amostrar com `SVGPathElement.getPointAtLength()` em N pontos.
- [ ] **Reamostragem uniforme:** todos os contornos com o mesmo N e o ponto 0 no mesmo ângulo (topo). Isso é obrigatório para o morph.
- [ ] `eyes.ts`: tabela `{ [shape]: { width, height, gap, shiftY } }` com valores **seus**, ajustados visualmente no playground.

**Pronto quando:** o playground mostra todas as formas estáticas, com olhos bem posicionados.

---

## Fase 2: Renderer SVG

- [ ] `svg.ts`: `renderFrame(frame, { size, color }) → string`.
  - Corpo: `<path d="M x y L x y … Z" fill="cor"/>`; arredondar para 2 casas.
  - Olhos: duas cápsulas como `<rect rx>` ou como path.
- [ ] Atualizar o DOM **só quando a string mudar** (comparar com a anterior).
- [ ] `still.ts`: `toSvgFile(frame)` e `toDataUrl(frame)` para miniaturas e ícones.
- [ ] Suporte a tema claro/escuro via CSS var no `<style>` do SVG.

**Pronto quando:** `renderFrame` gera o mesmo visual da Fase 1 e o export estático abre em qualquer visualizador.

---

## Fase 3: Modelo do personagem (`Character`)

Classe pura com estado interno e molas (*springs*) para suavidade.

```ts
interface Frame {
  body: [number, number][];        // contorno atual
  eyes: { cx: number; cy: number; w: number; h: number; shape: EyeShape }[];
  scale: number;                   // respiração / squash
  rotation: number;                // spin
}

class Character {
  constructor(opts: { body: Shape; seed: number });
  advance(dt: number): void;       // integra molas, timers
  frame(): Frame;                  // snapshot para o renderer
  get isSettled(): boolean;        // tudo parado → loop pode dormir

  setBody(shape: Shape, opts?: { instant?: boolean }): void; // morph animado
  setMorph(mix: { shape: Shape; weight: number }[]): void;
  setExpression(e: Expression, opts?: { duration?: number }): void;
  setGaze(p: { x: number; y: number } | null): void;
  look(dir: { x: number; y: number }): void;
  blink(): void;
  poke(x: number, y: number): void; // squash + olhar para o ponto
  play(): void; pause(): void; seek(t: number): void;
}
```

- [ ] **Molas:** `posição += velocidade·dt; velocidade += (alvo − posição)·k·dt − velocidade·d·dt`. Use para olhar, escala e morph.
- [ ] **Morph:** interpolar ponto a ponto entre o contorno atual e o alvo.
- [ ] **Piscar:** curva de ~120 ms na altura dos olhos (1 → 0.1 → 1).
- [ ] **Poke:** impulso na escala (squash & stretch) + olhar para o ponto.
- [ ] **Respiração:** `scale = 1 + 0.015·sin(2π·t/3s)`.
- [ ] `isSettled` = todas as molas abaixo de um limiar e nenhuma animação ativa.

---

## Fase 4: Expressões

- [ ] `expressions.ts`: cada expressão define **só os olhos**:

| Expressão    | Olhos                                       |
|--------------|---------------------------------------------|
| `neutral`    | cápsulas verticais                          |
| `happy`      | arcos "^ ^"                                 |
| `surprised`  | maiores e mais redondos                     |
| `sad`        | inclinados para fora, levemente caídos      |
| `sleepy`     | achatados (linhas)                          |
| `squinted`   | achatados com leve curva                    |
| `calm`       | semicerrados                                |
| `inspecting` | um olho menor que o outro                   |
| `confused`   | alturas diferentes                          |

- [ ] Transição entre expressões interpolando largura, altura e curvatura.
- [ ] Apelidos: `smile → happy`, `sleep → sleepy`, `idle → neutral`.

---

## Fase 5: Comportamento (`StateMachine`)

Camada acima do `Character` que decide **o que** ele faz sozinho.

- [ ] Estados: `idle`, `thinking`, `celebrate`, `sleep`.
- [ ] **Idle:** piscar a cada 2 a 6 s; olhadas aleatórias ocasionais; respiração.
- [ ] **Seed por avatar:** `rng(hash(id))` define os tempos, para avatares não ficarem sincronizados.
- [ ] `setEmphasis(bool)`: avatar selecionado fica mais vivo (olhos maiores, respiração maior).
- [ ] `spinSignal`: quando o número muda, dispara um giro de 360°.
- [ ] `setCompact(bool)`: em tamanhos pequenos (< 32 px), reduzir movimentos e detalhes.
- [ ] `setResting(bool)`: fora de foco, só piscadas raras.

---

## Fase 6: Runtime (`Ticker`)

- [ ] Loop `requestAnimationFrame` com **limite de fps** (padrão 60; 30 em listas grandes).
- [ ] `dt` em segundos, limitado (ex.: máx. 0,1 s) para não "pular" ao voltar de outra aba.
- [ ] **Pausar** quando `document.hidden` ou quando o elemento sai da tela (`IntersectionObserver`).
- [ ] **Dormir** quando `character.isSettled` e não há comportamento ativo; `wake()` ao receber qualquer comando.
- [ ] `prefers-reduced-motion`: modo estático (só o primeiro quadro).

---

## Fase 7: Componente React

```tsx
<Avatar
  id="agente-123"            // define forma/cor/seed se não informados
  shape="squircle"
  color="#00C2A8"
  size={48}
  state="idle"
  isFollowingPointer
  isEmphasized={false}
  spinSignal={count}
  ref={avatarRef}            // .blink() .look() .poke() .setExpression()
/>
```

- [ ] Criar `Character` e `StateMachine` uma vez (`useRef`).
- [ ] Repassar mudanças de props com `useEffect` (shape → `setBody`, state → `setState`...).
- [ ] `useImperativeHandle` expondo `blink`, `look`, `poke`, `setExpression`, `restart`.
- [ ] Seguir o mouse: `pointermove` em `window` → converter para coordenadas relativas ao avatar → `setGaze`.
- [ ] Tamanho automático com `ResizeObserver` quando `size` não for número.
- [ ] Escrever o SVG via `innerHTML` em um `<span>` (só quando mudar), evitando re-render do React a cada quadro.

---

## Fase 8: Identidade e editor

- [ ] `identity.ts`: `id → { shape, color, seed }` via hash, para cada avatar sem configuração manual ter visual fixo.
- [ ] Paleta própria (8 a 12 cores com bom contraste para olhos escuros).
- [ ] **Seletor:** grade de formas × cores, com prévia animada.
- [ ] **Opção de foto:** upload → recorte circular em `<canvas>` → salvar como data URL (≤ 1024 px). Corrigir orientação EXIF.

---

## Fase 9: Playground e testes

- [ ] Página com: todas as formas, todas as cores, botões de expressão, slider de morph, toggle de seguir mouse, contador de fps.
- [ ] Teste de performance: 100 avatares na tela a 60 fps.
- [ ] Testes unitários do modelo (puro): `advance` + `frame` determinísticos com seed fixa.
- [ ] Snapshot do SVG estático de cada forma.

---

## Ordem e estimativa

| Fase | Entrega                                   | Esforço |
|------|-------------------------------------------|---------|
| 1    | Formas + olhos estáticos                  | 1–2 dias |
| 2    | Renderer SVG + export estático            | 0,5 dia  |
| 3    | Character (molas, piscar, olhar, morph)   | 1–2 dias |
| 4    | Expressões                                | 1 dia    |
| 5    | Comportamento ocioso                      | 1 dia    |
| 6    | Ticker com economia                       | 0,5 dia  |
| 7    | Componente React                          | 0,5 dia  |
| 8    | Identidade + editor                       | 1 dia    |
| 9    | Playground + testes                       | contínuo |

**MVP (2 a 3 dias):** fases 1, 2, 3 (só piscar e olhar), 6 e 7, com 4 ou 5 formas.

---

## Dicas finais

- Desenhe as formas primeiro no papel ou Figma: a personalidade vem das **proporções dos olhos** em relação ao corpo.
- Olhos pequenos e baixos = fofo; olhos altos e afastados = curioso.
- Mantenha o movimento **sutil**: poucos pixels de olhar, escala de 1 a 2%.
- Use `transform` e apenas reescreva o SVG quando algo mudar.
