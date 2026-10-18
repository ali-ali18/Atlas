# Como funciona o motor de avatares do Grok Bot

Análise feita em 12/10/2026 sobre o app desktop **Grok Bot 0.24.0** (instalado em `AppData\Local\Programs\Grok Bot`), usando o MCP **rea** e a extração do `resources\app.asar`.

> Objetivo: entender a **técnica** para criar avatares próprios. Não copie paths, tabelas de proporção ou código do app; crie suas próprias formas, paleta e proporções.

---

## 1. Resumo

Os avatares (os "bichinhos" coloridos com dois olhos) **não são imagens, sprites nem modelos 3D**. Eles são **desenhados por código em SVG, a cada quadro**, por um motor procedural interno chamado **"Motion Lab"**.

- Stack: **Electron + React**.
- Não há three.js, Babylon, Pixi, Live2D, Rive, Lottie nem shaders de avatar.
- O motor fica em `dist/renderer/assets/index.eager-platform-*.js`.
- O editor de avatar (`chunk-agent-avatar-editor-*.js`) e o seletor de personagem (`chunk-agent-character-picker-*.js`) só escolhem forma, cor ou foto.

---

## 2. Anatomia de um avatar

Cada personagem guarda apenas dois campos:

| Campo         | Exemplo    | Observação                                                    |
|---------------|------------|---------------------------------------------------------------|
| `avatarShape` | `"wedge"`  | Se vazio, sorteado por **hash do ID** do agente               |
| `avatarColor` | `"orange"` | Se vazio, também sorteado por hash (visual estável por bot)   |

O desenho final é sempre: **corpo (forma) + cor + dois olhos**.

### 2.1 Formas (25)

```
blob (internamente "sphere"), cloud, square, sparkle, clover, heart, flower,
teardrop, tablet, wedge, house, star, pebble, bean, egg, squircle, capsule,
cylinder, hex, gem, crystal, shield, dome, arch, leaf
```

### 2.2 Paleta (11 cores)

| id      | hex       |
|---------|-----------|
| black   | `#000`    |
| brown   | `#936439` |
| red     | `#FF263C` |
| orange  | `#FF6700` |
| yellow  | `#FF9800` |
| green   | `#00C972` |
| cyan    | `#00BCA6` |
| blue    | `#1084FE` |
| violet  | `#9159FE` |
| magenta | `#FF309B` |
| gray    | `#777777` |

---

## 3. Geometria

1. **Corpo:** cada forma é calculada como uma lista de pontos `[x, y]` e convertida em um path SVG (`M x y L x y … Z`).
   - O `blob` tem um renderizador próprio que simula uma esfera.
   - As outras formas passam por um renderizador genérico.
2. **Olhos:** sempre **duas cápsulas** (retângulos bem arredondados).
   - Para cada forma existe uma tabela de ajuste com `width`, `height`, `gap` (distância entre os olhos) e `shiftY` (deslocamento vertical).
   - Assim o rosto fica bem posicionado em formas muito diferentes (gota, casa, estrela...).
3. **Morph:** o motor mistura dois contornos com pesos (ex.: 70% egg + 30% cloud). Isso permite transições suaves de uma forma para outra.
4. **Exportação estática:** o mesmo desenho pode virar um arquivo SVG completo (data URL), usado em cartões de compartilhamento e miniaturas.

---

## 4. Animação

### 4.1 Loop

- `requestAnimationFrame`, limitado a **60 fps** (`maxFrameRate`).
- A cada quadro: `advance(dt)` → gera o quadro → regenera o SVG, que só é reescrito se mudou.
- **Economia:**
  - pausa quando a aba está oculta (`document.hidden`);
  - pausa quando o avatar sai da tela (`IntersectionObserver`);
  - o loop **dorme** quando o personagem "assenta" e acorda (`wake()`) quando algo muda.

### 4.2 API do personagem

| Método                       | O que faz                                    |
|------------------------------|----------------------------------------------|
| `blink()`                    | pisca                                        |
| `look(dir)`                  | olha para uma direção                        |
| `setGaze(ponto)`             | olhar contínuo (ex.: seguir o mouse)         |
| `poke(x, y)`                 | "cutucada": reage a um toque                 |
| `setExpression(expr)`        | muda a expressão                             |
| `setBody(forma)`             | troca a forma (com transição)                |
| `setMorph(...)`              | mistura formas                               |
| `restart()`                  | reinicia a animação                          |

### 4.3 Expressões (só os olhos mudam)

```
neutral, happy, surprised, sad, sleepy, squinted, calm, inspecting, confused
```

Apelidos internos: `smile → happy`, `sleep → sleepy`, `thinking → sad`, `idle → neutral`, etc.

### 4.4 Estados e comportamento

- **Seguir o mouse:** um listener de `pointermove` calcula a direção do cursor em relação ao centro do avatar e chama `setGaze`.
- **Seed por avatar:** cada personagem tem uma semente aleatória própria, então piscadas e movimentos ociosos **não ficam sincronizados**.
- **Estados de alto nível:** `idle`, `isPaused`, `isEmphasized`, `spinSignal` (girar ao publicar ou comemorar), modo compacto em tamanhos pequenos.

---

## 5. Receita para criar os seus

Dá para fazer só com **React + SVG**, sem biblioteca 3D.

### Passo a passo

1. **Formas.** Desenhe cada forma numa área de 100×100:
   - no Figma ou Illustrator, exportando o atributo `d` do path; ou
   - por fórmula: superelipse (squircle), raio com onda senoidal (cloud e flower), polígono com cantos arredondados (hex, wedge).
2. **Olhos.** Dois `<rect rx>` ou `<ellipse>`. Para cada forma, guarde `{ gap, shiftY, w, h }`.
3. **Piscar.** A cada 2 a 6 s (intervalo aleatório), anime a altura do olho até ~10% e volte, em ~120 ms.
4. **Olhar.** No `pointermove`, calcule o vetor do centro do avatar ao cursor, normalize, limite a poucos pixels e suavize com *lerp*.
5. **Expressões.** Varie só os olhos: arco para cima (happy), achatado (sleepy), maior (surprised), um olho menor (confused).
6. **Respiração.** Escala `1 + 0.02·sin(t)` no corpo.
7. **Identidade.** Use o **hash do ID** para escolher forma, cor e semente das animações.
8. **Performance.** Pause com `IntersectionObserver` e `document.hidden`; pare o loop quando nada estiver se mexendo.

### Esqueleto mínimo (React)

```tsx
import { useEffect, useRef, useState } from "react";

type Shape = "blob" | "squircle" | "drop";

// Paths próprios em área 100x100 (crie os seus)
const SHAPES: Record<Shape, string> = {
  blob: "M50 8 C78 8 92 30 92 55 C92 80 74 94 50 94 C26 94 8 80 8 55 C8 30 22 8 50 8 Z",
  squircle: "M50 6 C88 6 94 12 94 50 C94 88 88 94 50 94 C12 94 6 88 6 50 C6 12 12 6 50 6 Z",
  drop: "M50 4 C62 30 90 46 90 64 C90 84 72 96 50 96 C28 96 10 84 10 64 C10 46 38 30 50 4 Z",
};

// Ajuste de olhos por forma (seus valores)
const EYES: Record<Shape, { gap: number; y: number; w: number; h: number }> = {
  blob: { gap: 22, y: 50, w: 9, h: 18 },
  squircle: { gap: 24, y: 48, w: 9, h: 18 },
  drop: { gap: 20, y: 62, w: 8, h: 16 },
};

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function Avatar({ id, size = 64, shape, color }: {
  id: string; size?: number; shape?: Shape; color?: string;
}) {
  const shapes = Object.keys(SHAPES) as Shape[];
  const palette = ["#22C55E", "#3B82F6", "#F97316", "#A855F7", "#EF4444"];
  const s = shape ?? shapes[hash(id) % shapes.length];
  const fill = color ?? palette[hash(id + "c") % palette.length];
  const e = EYES[s];

  const ref = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(1);
  const target = useRef({ x: 0, y: 0 });

  // Olhos seguem o mouse
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const dx = ev.clientX - (r.left + r.width / 2);
      const dy = ev.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / 200) * 5; // máx. 5 unidades
      target.current = { x: (dx / len) * k, y: (dy / len) * k };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Loop: suavização do olhar + piscar aleatório
  useEffect(() => {
    let raf = 0;
    let nextBlink = performance.now() + 2000 + Math.random() * 4000;
    const tick = (t: number) => {
      setLook((p) => ({
        x: p.x + (target.current.x - p.x) * 0.15,
        y: p.y + (target.current.y - p.y) * 0.15,
      }));
      if (t > nextBlink) {
        const phase = (t - nextBlink) / 120;
        setBlink(phase < 1 ? Math.abs(1 - 2 * phase) * 0.9 + 0.1 : 1);
        if (phase >= 1) nextBlink = t + 2000 + Math.random() * 4000;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const eye = (cx: number) => {
    const h = e.h * blink;
    return (
      <rect
        x={cx - e.w / 2 + look.x}
        y={e.y - h / 2 + look.y}
        width={e.w}
        height={h}
        rx={e.w / 2}
        fill="#111"
      />
    );
  };

  return (
    <svg ref={ref} viewBox="0 0 100 100" width={size} height={size}>
      <path d={SHAPES[s]} fill={fill} />
      {eye(50 - e.gap / 2)}
      {eye(50 + e.gap / 2)}
    </svg>
  );
}
```

### Próximos passos

- Adicionar expressões (`happy`, `sleepy`...) trocando o desenho dos olhos.
- Implementar *morph* interpolando os pontos de dois contornos com o mesmo número de vértices.
- Exportar como SVG estático para ícones e miniaturas.
- Pausar com `IntersectionObserver` quando houver muitos avatares na tela.

---

## 6. Arquivos analisados (referência)

| Arquivo (dentro do `app.asar`)                          | Papel                                          |
|---------------------------------------------------------|------------------------------------------------|
| `dist/renderer/assets/index.eager-platform-*.js`        | Motor "Motion Lab": geometria, olhos, animação |
| `dist/renderer/assets/index.eager-app-*.js`             | Componente que liga o motor ao app             |
| `dist/renderer/assets/chunk-agent-character-picker-*.js`| Seletor de forma e cor                         |
| `dist/renderer/assets/chunk-agent-avatar-editor-*.js`   | Upload, geração por IA e recorte de foto       |
| `dist/electron-preload/preload-avatar-source.cjs`       | Decodifica e redimensiona fotos (máx. 1024 px) |
