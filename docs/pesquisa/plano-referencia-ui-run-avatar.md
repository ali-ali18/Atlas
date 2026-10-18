# Plano: UI, run e UX dos avatares (referência Grok Bot) + correção do motor de avatar

Análise de 12/10/2026 sobre o app desktop de referência (pacote interno `sand`, versão 0.68.1, construído pela Anysphere para a SpaceXAI), feita com o MCP `rea` e a extração do `app.asar`. Complementa `PLANO-FRONT.md` e `Motor-de-Avatares-GrokBot.md`.

Legenda: **[visto]** = lido no código; **[deduzido]** = inferido de nomes, catálogos de erro ou estrutura.

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
