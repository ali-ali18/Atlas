# Plano: UI, run e UX dos avatares (referência Grok Bot) + correção do motor de avatar

Análise de 12/10/2026 sobre o app desktop de referência (pacote interno `sand`, versão 0.68.1, construído pela Anysphere para a SpaceXAI), feita com o MCP `rea` e a extração do `app.asar`. Complementa `PLANO-FRONT.md` e `Motor-de-Avatares-GrokBot.md`.

Legenda: **[visto]** = lido no código; **[deduzido]** = inferido de nomes, catálogos de erro ou estrutura.

---

## 0. Revisão de 13/10/2026: "ainda não ficou 3D"

### 0.1 O que já foi feito
C1–C7 estão nos commits `bed5c7b` → `d9dedfd`: cutout, yaw/pitch, esfera, sólidos (revolução, extrusão, almofada), olhos na superfície, enquadramento, clipes com bolsa e morph de indicador. **O motor 3D funciona.** Renderizando `stillFrame` com orientação forçada, a silhueta muda e os olhos encurtam na superfície:

```
            yaw 0     yaw 25    yaw -25/p10   yaw 45/p-15   yaw 70
blob        ( oo )    ( oo)     (oo  )        (  °°)        (    |)
hex         ⬡ frente  gira      gira          perspectiva   vira "fatia"
egg/gem/…   idem: silhueta e olhos mudam com o giro
```
(Prancha gerada pelo script da seção 0.5.)

### 0.2 Por que na tela parece 2D (medido)
Simulação de 20 s no estado `idle`, `seed = "bot-123"` (`createAvatarEngine` + `advance(33)`):

| tamanho | `breathe` | maior yaw | maior pitch | tempo girado > 3° |
|---|---|---|---|---|
| 36 / 52 px | `false` | **0°** | **0°** | **0%** |
| 72 px | `false` | 23° | 8° | 15% (só as olhadas) |
| 36 px | `true` | 8,7° | 1° | 43% (clipe compacto `Idle_B`) |
| 52 / 72 px | `true` | 150° | 34° | 71–73% |

**Causa raiz:** o repouso só toca clipes quando o avatar é "vivo", e o componente desliga isso por padrão:

- `components/avatar/avatar.tsx:115`: `breathe = false`.
- `model/behavior.ts:261`: `const parado = this.resting || (this.isAmbient() && !this.liveRequested);` faz o `idle` chamar `stopClip()`.
- Resultado: orientação `{0, 0, 0}`, então `isFrontal(m)` é verdadeiro e `projectBody` devolve o **mesmo path do 2D**. Toda a geometria 3D é pulada.

Onde isso acontece hoje:

| Local | Tamanho | `breathe` | Resultado |
|---|---|---|---|
| `chat-sidebar/agent-avatars.tsx` | 52 | não | parado, 100% de frente (só gira no hover) |
| `chat-sidebar/pinned-bot-button.tsx` | 72 | não | só olhadas ocasionais |
| `notification-avatar.tsx` | – | não | parado |
| `chat-thread.tsx:450` e `working-indicator.tsx:61` | 36 | sim | clipe compacto: no máximo ±8,7°, quase imperceptível em 36 px |

Na referência, o `idle` **sempre** toca `Idle_B / Idle_D / Idle_A` [visto: `isPlaying` vale `true` por padrão e `isResting = !isPlaying`]. Só abaixo de 48 px ela usa o compacto (`ui = 48`). Ela também é **chapada**: o sombreamento por face (`proof`, Lambert com `ambient = 0.18`) só existe no modo de prova (`isProof`), não no app normal. O "3D" da referência vem **do movimento**, não da cor.

### 0.3 Correções (em ordem)

#### D1: idle vivo por padrão (esforço S, resolve 80%)
`packages/ui/src/components/avatar/avatar.tsx`:
```tsx
export function Avatar({
	animated = true,
	ariaLabel,
	breathe = true, // era false: sem isso o idle nunca gira e o 3D não aparece
```
Atualize o comentário da prop:
```tsx
	/** Repouso vivo (clipes Idle com giro 3D). Desligue só em listas enormes. */
	breathe?: boolean;
```
A CPU continua sob controle: o ticker já pausa fora da tela (IntersectionObserver), roda a 30 fps no ambiente e tem o orçamento de 40 avatares (`d9dedfd`). Em listas longas (seletor de personagem, histórico), passe `breathe={false}` de propósito.

#### D2: compacto que ainda gira (esforço S)
Em 36 px o `Idle_B` (±8,7°) não se vê. Duas opções:

**a) (recomendado)** Baixar o limite do compacto para 32 px. O chat (36 px) passa a usar `Idle_A/D` (±30–35°):
```ts
// model/behavior.ts → BEHAVIOR_TUNING
/** Abaixo disto (px) só toca o clipe discreto (`compactClips`). */
compactClipsBelowPx: 32, // era 48 (valor da referência); em 36 px o Idle_B some
```

**b)** Manter 48 e amplificar o giro do clipe compacto em tamanhos pequenos. Em `character.ts`, onde a pose do clipe vira orientação:
```ts
// pose.rot = [pitch, yaw, roll] do clipe
const amp = this.compactAmp; // 1 normal; 1.8 quando compacto (setCompactAmp no StateMachine)
const rot: [number, number, number] = [pose.rot[0] * amp, pose.rot[1] * amp, pose.rot[2]];
const orientation = this.orientation(rot, gaze, spin);
```

#### D3: teste que impede a regressão (esforço S)
`packages/ui/src/lib/avatar/model/alive.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createAvatarEngine } from "../engine";

const wrap = (a: number) => ((((a % 360) + 540) % 360) - 180);

function maxTurn(opts: Parameters<typeof createAvatarEngine>[0]) {
	const engine = createAvatarEngine(opts);
	engine.setState("idle");
	let max = 0;
	for (let t = 0; t < 12_000; t += 33) {
		const { yaw, pitch } = engine.advance(33).orientation;
		max = Math.max(max, Math.abs(wrap(yaw)), Math.abs(wrap(pitch)));
	}
	return max;
}

describe("repouso vivo", () => {
	it.each([36, 52, 72])("gira em 3D no idle com %ipx", (size) => {
		expect(maxTurn({ shape: "hex", seed: "bot-123", size })).toBeGreaterThan(15);
	});
	it("parado quando breathe=false (lista longa)", () => {
		expect(maxTurn({ shape: "hex", seed: "bot-123", size: 52, breathe: false })).toBe(0);
	});
});
```
Em `components/avatar/avatar.test.tsx`, garanta o padrão do componente:
```tsx
it("idle vivo por padrão", () => {
	// espiona createAvatarEngine e confere breathe !== false quando a prop não vem
});
```

#### D4: volume na cor (opcional, vai além da referência)
Só se, depois de D1, você ainda quiser mais "corpo". É um gradiente radial suave com a luz fixa no alto à esquerda. Dá volume à esfera e aos sólidos e é barato, porque é um `<radialGradient>` por avatar e nada muda por quadro.

`render/shade.ts`:
```ts
import { BODY_RADIUS_PX, CENTER } from "../geometry/shapes";

function mix(hex: string, target: number, t: number): string {
	const n = Number.parseInt(hex.slice(1), 16);
	const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - t) + target * t);
	return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

/** Gradiente de volume (luz no alto à esquerda); `null` para cores não-hex. */
export function shadeGradient(id: string, color: string): string | null {
	if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
	const r = BODY_RADIUS_PX;
	return (
		`<radialGradient id="${id}-shade" gradientUnits="userSpaceOnUse" ` +
		`cx="${CENTER - 0.35 * r}" cy="${CENTER - 0.45 * r}" r="${1.6 * r}">` +
		`<stop offset="0" stop-color="${mix(color, 255, 0.18)}"/>` +
		`<stop offset="0.5" stop-color="${color}"/>` +
		`<stop offset="1" stop-color="${mix(color, 0, 0.22)}"/>` +
		`</radialGradient>`
	);
}
```
No `avatar.tsx`, dentro de `<defs>`, e no `fill` do corpo:
```tsx
<radialGradient id={`${uid}-shade`} gradientUnits="userSpaceOnUse"
	cx={CENTER - 0.35 * BODY_RADIUS_PX} cy={CENTER - 0.45 * BODY_RADIUS_PX} r={1.6 * BODY_RADIUS_PX}>
	<stop offset="0" stopColor={lighten(bodyColor, 0.18)} />
	<stop offset="0.5" stopColor={bodyColor} />
	<stop offset="1" stopColor={darken(bodyColor, 0.22)} />
</radialGradient>
…
<path d={markup.body} fill={shaded ? `url(#${uid}-shade)` : bodyColor} ref={bodyRef} />
```
- Coloque o gradiente **fora** do `<g transform>` se quiser a luz fixa na tela (mais realista ao girar). Dentro, a luz acompanha o roll.
- O cutout continua igual: a máscara recorta o corpo, não o fill.
- Exponha como prop `shading?: "flat" | "soft"`, com padrão `"flat"` (igual à referência).

#### D5: serrilhado em giro extremo (opcional)
Em yaw ≥ 60°, `hex` e `star` mostram degraus porque os sólidos usam 48 pontos (`SOLID_STRIDE = 2` em `render/project.ts:39`). Use o contorno inteiro em avatares grandes:
```ts
export function prepare(frame: Frame, stride = SOLID_STRIDE): Prepared { … worldOutline(frame.body, stride) … }
// createProjector(size): stride = size >= 64 ? 1 : 2
```

### 0.4 Ordem
**D1 → D2a → D3 → (olhar no app) → D4 se quiser → D5.** D1 sozinho já faz a barra lateral (52 px) girar como na referência. O caso de 36 px do teste D3 só passa depois de D2a.

### 0.5 Prancha de verificação (playground rápido)
Salve como `packages/ui/scripts/avatar-sheet.ts` e rode `pnpm --filter web exec tsx ../../packages/ui/scripts/avatar-sheet.ts sheet.html`:
```ts
import { writeFileSync } from "node:fs";
import { stillFrame } from "../src/lib/avatar/render/still";
import { renderFrame } from "../src/lib/avatar/render/svg";

const shapes = ["blob", "hex", "egg", "squircle", "star", "heart", "capsule", "gem"] as const;
const poses: [number, number][] = [[0, 0], [25, 0], [-25, 10], [45, -15], [70, 0]];
let html = `<body style="background:#1b1b1f;color:#aaa;font:12px sans-serif"><table>`;
for (const s of shapes) {
	html += `<tr><td>${s}</td>`;
	for (const [yaw, pitch] of poses) {
		const f = { ...stillFrame(s, "neutral"), orientation: { yaw, pitch, roll: 0 } };
		html += `<td>${renderFrame(f, { size: 110, color: "#7c6cf0", id: `${s}${yaw}${pitch}`.replace(/-/g, "m") })}</td>`;
	}
	html += "</tr>";
}
writeFileSync(process.argv[2] ?? "sheet.html", `${html}</table></body>`);
```
Se a prancha mostra 3D e o app não, o problema está no **acionamento** (estado, `breathe`, tamanho), não na geometria.

---

## 1. Por que os avatares do Atlas não ficaram iguais (diagnóstico)

O motor do Atlas (`packages/ui/src/lib/avatar/`) acertou a parte 2D: 25 formas, contorno com N pontos fixos, morph, tabela de olhos, seed, ticker que dorme. A diferença está em **quatro pontos de renderização e animação**:

| # | Referência [visto] | Atlas hoje | Efeito visível |
|---|---|---|---|
| 1 | **O personagem é 3D.** Cada frame tem uma orientação (`quat`, quatérnio). O `blob` é uma **esfera** com renderizador próprio; as outras formas são **sólidos extrudados** projetados (o corpo vira várias paths da mesma cor: frente, fundo e faces laterais) | Tudo 2D. `character.ts` desloca os olhos (`gazeX: 6`, `gazeY: 5`) e gira o corpo **no plano** (`rotation`, `offsetX`) | Na referência o avatar **vira de lado** (o quadrado "inclinado" do print é rotação 3D, não 2D) e ganha espessura. No Atlas ele só desliza |
| 2 | **Olhos colados na superfície.** Na esfera, cada ponto do olho é mapeado na superfície (mapa exponencial `sin(x)/x`) e girado com o corpo; nos sólidos, os olhos seguem a mesma matriz da face da frente. Ao olhar para o lado, os olhos **encurtam em perspectiva** e chegam à borda | Olhos são cápsulas 2D transladadas por cima do corpo | Olhar do Atlas parece "adesivo deslizando"; na referência parece cabeça girando |
| 3 | **Olhos recortados (cutout) por padrão.** `cutout: true` vira `<mask>` com buracos: o olho mostra o **fundo** atrás do avatar. Quando há cor de olho, ela é **recortada para dentro do corpo** (`mask`/`clip-path`) | Olho pintado `#0a0a0c` por cima, sem máscara (`render/svg.ts`) | No tema escuro fica parecido, mas o olho não acompanha o fundo (item selecionado, hover, tema claro) e pode "vazar" da borda em poses extremas |
| 4 | **Animação por clipes.** Uma máquina de estados toca **clipes de keyframes** (`Idle_A..D`, `Streaming_A..C`, `Done_A..C`, `Blocked_A..C`, `Rotation_A/C`...) sorteados por seed **sem repetir**, com versões compactas para avatares pequenos (< 48 px) | Movimento procedural (seno de respiração, balanço, bob) | Referência tem "atuação" (gestos distintos); Atlas fica com movimento uniforme e repetitivo |

Itens menores:
- A referência **enquadra cada forma pelo pior ponto do contorno** (calcula a maior distância ao centro e reduz a escala), para nenhuma forma parecer maior que outra. O Atlas normaliza pelo maior lado (`FIT = 228.44`), que deixa estrela e coração visualmente menores ou maiores.
- Em lista, a referência usa só o clipe compacto (`compactClips`) e pausa avatares fora da tela; o Atlas já pausa, mas não tem variante compacta de animação.

> Atenção: `geometry/eyes.ts` diz que os valores "vêm do ajuste visual do app de referência" e eles são idênticos aos da referência. Isso contradiz a regra do próprio `PLANO-FRONT.md` ("não copiamos tabelas de proporção"). Para uso pessoal o risco é baixo, mas se o Atlas for publicado, reajuste a tabela no playground.

---

## 2. Correção do motor de avatar (plano)

### C1 — Orientação 3D (esforço M)
- [ ] `geometry/math.ts`: quatérnio mínimo (`fromYawPitch`, `slerp`, `rotate(v)`), ou só dois ângulos `yaw`/`pitch` com limite de ±25°.
- [ ] `character.ts`: trocar `gx/gy` (deslocamento dos olhos) por **molas de `yaw` e `pitch`**. O olhar passa a **girar o corpo**; os olhos ganham só um resíduo pequeno (≤ 1,5 unidade) para dar vida.
- [ ] `Frame` ganha `orientation: { yaw, pitch, roll }`. `rotation` 2D continua só para giro de comemoração.

### C2 — Corpo como sólido (esforço M/L)
- [ ] **Blob = esfera.** Silhueta é sempre uma elipse (squash) do raio; o volume aparece só pelos olhos e pela sombra opcional.
- [ ] **Demais formas = extrusão.** Profundidade `d` (~18% do tamanho). Para orientação `R`:
  1. projetar o contorno da frente (`z = +d/2`) e o de trás (`z = −d/2`) com projeção ortográfica;
  2. para cada aresta `i → i+1`, gerar o quadrilátero lateral;
  3. desenhar **tudo com a mesma cor** num `<g>` (frente, trás e laterais). A união das paths dá a silhueta correta, inclusive em formas côncavas (coração, trevo).
- [ ] Opcional: faces laterais 6–10% mais escuras para dar espessura (a referência só faz isso no modo de prova; o visual normal é chapado).
- [ ] Cache por forma das arestas; com 96 pontos são 96 quads, barato.

### C3 — Olhos na superfície (esforço M)
- [ ] **Esfera:** cada ponto `(u, v)` do olho, em unidades de raio, vira um vetor na esfera por mapa exponencial: `θ = |(u,v)|`, `p = cos θ · frente + (sin θ / θ) · (u · direita + v · cima)`; depois aplicar `R` e projetar. Descartar pontos com `z < 0` (olho saiu da face visível).
- [ ] **Sólidos:** olhos na face da frente (`z = +d/2`), transformados pela mesma `R` (encurtam com o giro).
- [ ] Manter `EYE_FIT` (gap, shiftY, width, height) como posição base na face.

### C4 — Olhos recortados (esforço S)
- [ ] `render/svg.ts`: modo padrão `eyes: "cutout"`:
  ```svg
  <defs>
    <mask id="{id}-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="250" height="250">
      <rect width="250" height="250" fill="#fff"/>
      <path d="{olhos}" fill="#000"/>
    </mask>
  </defs>
  <g mask="url(#{id}-holes)">{corpo}</g>
  ```
- [ ] Modo `eyes: "paint"` (cor própria): pintar os olhos **dentro** de `<mask id="{id}-inside"><use href="#{id}-body" fill="#fff"/></mask>`.
- [ ] `id` único por instância (`useId` sanitizado), como já previsto no `PLANO-FRONT`.
- [ ] Remover `eyeColor="#0a0a0c"` fixo de `chat-sidebar.tsx:306` e `chat-thread.tsx:375`; usar cutout.

### C5 — Clipes de animação (esforço M)
- [ ] `model/clips.ts`: clipe = lista de keyframes `{ t, yaw, pitch, roll, squashX, squashY, lift, face? }` com easing. Interpolação por spline ou easing por segmento.
- [ ] Biblioteca própria (crie os seus): `idle` ×3, `streaming` ×3, `done` ×3, `blocked` ×3, `spin` ×2, `bounce`, `nod`.
- [ ] **Bolsa sem repetição:** embaralhar a lista do estado com o RNG da seed e consumir; nunca tocar o mesmo clipe duas vezes seguidas.
- [ ] Fase inicial aleatória por seed para avatares lado a lado não sincronizarem.
- [ ] `compactClips`: abaixo de 48 px, só um idle discreto.

### C6 — Máquina de estados com morph de indicador (esforço M)
Ver seção 3.2. O corpo pode **virar um indicador** (anel de progresso, radar, órbita) e voltar.

### C7 — Enquadramento por pior ponto (esforço S)
- [ ] Para cada forma: `r = max |p − centro|` do contorno; escala `= alvo / r`. Cache por forma. Ajustar `EYE_FIT` depois.

### Testes
- [ ] Projeção: com `yaw = 0`, sólido renderiza igual ao 2D atual (snapshot).
- [ ] Olhos nunca fora da silhueta em `yaw/pitch` ∈ ±25° (estende o teste de contenção existente).
- [ ] Cutout: SVG contém `mask` com id único; dois avatares na mesma página não colidem ids.
- [ ] Clipes: mesma seed ⇒ mesma sequência; nunca repete consecutivo.
- [ ] Orçamento: 40 avatares assentados ⇒ 0 rAF (já existe; repetir com 3D).

**Ordem sugerida:** C4 → C1 → C3 (esfera) → C2 → C3 (sólidos) → C7 → C5 → C6.
C4 sozinho já aproxima bastante no tema escuro; C1 + C3 é o que dá o "jeito" da referência.

---

## 3. UX dos avatares (como a referência usa)

### 3.1 Onde o avatar aparece [visto]
| Lugar | Comportamento |
|---|---|
| **Rail esquerdo** | Avatares em coluna, separadores entre grupos, item selecionado com fundo arredondado, badge (ex.: estrela laranja), `+` no fim. Vivos, mas compactos |
| **Painel do agente** | Avatar grande; olhos seguem o mouse **sempre** (`isFollowingPointer` quando não pausado) |
| **Editor** | Grade forma × cor com prévia animada; abas "gerar" (imagem por IA) e upload com recorte circular + zoom |
| **Cartão de compartilhamento / template** | SVG estático por padrão (`isPaused: true`); ganha vida quando o cartão está "ao vivo" (`isMarkLive`) |
| **Onboarding** | "Elenco" de personagens animados (`onboarding__cast`) apresentando o produto |
| **Mensagens entre bots / membros** | Chip pequeno com o avatar |

### 3.2 Estados do personagem [visto]
Tabela de estados → `{ clipes, rosto, morph, próximo, duração }`:

| Grupo | Estados | O que acontece |
|---|---|---|
| Repouso | `idle`, `sleeping`, `bored`, `shy` | clipes idle sorteados; `sleeping` com rosto sonolento |
| Conversa | `listening` (rosto calmo), `thinking` (morph "thinking"), `streaming` (3 clipes de fala) | o avatar "fala" enquanto o texto chega |
| Trabalho | `reading`, `working`, `coding`, `running`, `computing`, `controlling` | um estado compartilhado de trabalho |
| Indicadores | `searching` → **radar**, `waiting` → **órbita**, `loading`/`progress` → **anel de progresso**, `spawning` | **o corpo vira o indicador** (discos e anéis com arco), em vez de um spinner separado |
| Resultado | `finished` (rosto feliz → volta a `idle`), `failed` (→ `idle`), `blocked` (→ `drowsy` após um tempo) | reação curta e retorno automático |
| Emoções | `happy`, `excited`, `laughing`, `proud`, `curious`, `playful`, `surprised`, `suspicious`, `angry`, `confused`, `sad`, `scared` | clipe + rosto |
| Comemoração | `celebrate` (giro + feliz), `approving` (giro curto → `idle`), `waking` (surpreso 1,6 s → `idle`) | |

Eventos da UI → estado [visto]: `publish-succeeded → happy`, `publish-failed → idle`, `celebrate-ended → idle`. `spinSignal` (contador) dispara um giro sempre que muda.

### 3.3 Regras de UX
- **Movimento reflete o run**: o usuário sabe o que o agente está fazendo olhando o avatar (radar = buscando, anel = carregando, fala = streaming).
- **Pequeno = calmo**: abaixo de 48 px só idle discreto; nada de giro em lista.
- **Pausar quando não importa**: aba oculta, fora da tela, cartão estático, `prefers-reduced-motion`.
- **Reações curtas e com retorno**: todo estado de resultado tem `next` e/ou `holdSeconds`; o avatar nunca fica preso em "feliz".
- **Seed por agente**: cada bot tem "personalidade" de tempo própria.
- **Interação**: cutucar (clique) faz squash e olhar para o ponto; hover no rail ativa o olhar.

### 3.4 Plano de UX para o Atlas
- [ ] `apps/web/lib/bot-activity.ts`: evoluir de "trabalhando sim/não" para o **estado da tabela** acima, derivado dos eventos do run (`tool_call` de busca → `searching`, stream de texto → `streaming`, run terminou → `finished`, erro → `failed`, aguardando aprovação → `waiting`).
- [ ] `LiveAvatar` aceita `state` e `spinSignal`; o rail usa variante compacta.
- [ ] Substituir o `WorkingIndicator` (poses antigas) pelo avatar com morph de indicador.
- [ ] Comemorar marcos: rotina criada, bot publicado, primeira tarefa concluída → `celebrate`.
- [ ] Cartões de template e compartilhamento: SVG estático (`render/still.ts`), vivo só quando em foco.

---

## 4. UI da referência (resumo) [visto]

| Camada | Escolha |
|---|---|
| Shell | Electron + React + Vite, código dividido em chunks lazy; 4 pacotes eager com `modulepreload` |
| Estilo | StyleX (classes atômicas `sand-*`, `ui-*`) |
| Componentes | Base UI (headless) + Floating UI |
| Dados | TanStack Query |
| Composer | Tiptap com menções e sugestões |
| Conteúdo | react-markdown + GFM + KaTeX + Mermaid (lazy) + destaque de código por linguagem |
| Visualizadores | pdf.js, xlsx, mammoth (docx) |
| Interação | dnd-kit, motion, react-hotkeys-hook |
| i18n | Lingui |
| Segurança | CSP rígida; iframes isolados por protocolo (`sand-html-preview:`, `sand-canvas:`, `sand-mcp-app:`); mídia por `sand-media:` e `sand-avatar:` |
| Boot | "boot shell" vazio na hora; restauração da sessão em etapas com "Retry" se travar |

Layout: rail de avatares → chat central → painéis (arquivo, diff, documento, canvas, prévia HTML, apps MCP, tela do computador remoto via VNC).

---

## 5. Como funciona o run da referência

### Processos locais [visto]
```
Electron main       janelas, protocolos, updates, crash guard, watchdog de boot
 ├─ Renderer        UI React
 ├─ node-agent-coordinator   processo Node por conta (estado, sync, WebAuthn, troca de conta via MessagePort)
 ├─ local-exec-daemon        processo destacado que executa ações na máquina do usuário
 └─ sand-webauthn-signer.exe assinatura nativa
```

### Agente na nuvem [deduzido do catálogo de erros]
- O agente roda numa **box** (pod que hiberna, com desktop próprio). A UI conecta por **gateway** com fluxo de eventos; watchdog derruba e reconecta fluxo silencioso.
- Tela da box via VNC, com detecção de "tela congelada".

### Canal reverso local-exec [visto]
- A box pede ações na máquina do usuário; o daemon aceita só: `ls`, `read`, `redactedRead`, `shellStream`, shell em segundo plano, `writeShellStdin`.
- Cada computador registra `machineId` e manda heartbeat; pedido ambíguo (vários PCs sem `machineId`) é recusado.
- `tree-sitter-bash` empacotado [visto]; uso provável: classificar comandos antes de executar [deduzido].

### Ciclo do turno [deduzido]
1. Turno vai ao backend via Connect-RPC + Protobuf, resposta em stream.
2. Falhas classificadas com estratégia própria: `providerOverloaded` (backoff), `firstTokenStall` (prazo do primeiro token), `streamIdleStall` (silêncio no meio), `backendCapacityDeferred` (dorme o `retry-after`), `contextWindowOverflow` (resumir, não repetir), `conversationTooLarge` (GC antes de aceitar), `botBlock` (detecção de Cloudflare/captcha na navegação).
3. Memória: evidência → proposta → **verificação** → aplica; refaz se os arquivos mudaram.

### Observabilidade [visto]
Sentry, OpenTelemetry, Statsig e catálogo `SAND-E0xxx` (código, domínio, retentável, resumo).

### O que vale trazer para o Atlas
- [ ] Catálogo de erros tipado do run (código + domínio + retentável) em `packages/shared`.
- [ ] Watchdogs de primeiro token e de silêncio no stream no worker.
- [ ] Mapear cada erro/evento do run para um **estado do avatar** (seção 3.4).
- [ ] Executor local com lista fechada de operações + classificação de comandos (se/quando houver execução local).
