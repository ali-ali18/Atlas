# PLANO-VM — Upgrade do uso da VM (navegador/computador) pelo agente

Plano de pesquisa + diagnóstico + implementação, escrito em 12/10/2026 no branch `rodada/desempenho`. Estilo e convenções do `PLANO-RUN-V2.md`: fases em ordem de prioridade (maior impacto e menor risco primeiro), cada uma com problema (com evidência), técnica adotada (com quem usa), desenho, arquivos, testes, riscos, esforço e dependências.

Motivação do usuário: "ele se perde muito fácil", "um upgrade geral", "veja como as empresas fazem isso de forma eficaz e traz para a gente implementar". Sintoma de referência: o bot Bob (Claude Haiku 5.5) numa conversa sobre um LMS atrás de login Microsoft. Lista as disciplinas favoritas, mas lento; não consegue abrir as semanas (acordeões); entrega um PDF com só a Semana 1 e pede para o usuário colar o resto.

> Escopo deste documento: pesquisa e plano. Nenhuma linha de código foi alterada. Dados lidos em modo somente leitura do Postgres local (nenhum segredo, cookie ou token foi lido ou impresso; URLs só com caminho).

---

## 0. Resumo executivo

1. **O "se perde" não é falta de contexto.** O prompt dos runs de Bob ficou entre 17k e 27k tokens (janela de 1M; ~82% em cache). O que falta é **estado explícito de itens** (as 9 semanas, as 3 disciplinas) e **portões** que impeçam entregar/perguntar com itens abertos e orçamento sobrando. O PDF incompleto saiu na decisão 21 de 100 passos, com US$ 0,019 gastos.
2. **A maior parte do tempo é desperdício de ferramenta, não de modelo.** Na conversa inteira: `navigate` = 312 s (53 chamadas, média 5,9 s) e `browser_click` = 125 s. Sete cliques estouraram 15 s cada (**105 s**) porque o alvo é achado por texto (`getByText`, cai num `<span>`) e um link-overlay de card ("stretched link") e um banner de cookies interceptam o clique; o Playwright reprova até o teto de 15 s e despeja 2 a 4 KB de log no contexto do modelo.
3. **O conteúdo das semanas estava disponível e foi descartado.** Cada `browser_act` em uma semana devolveu "Novos elementos" com os títulos; o modelo clicou 9 refs em lote, sem ler o conteúdo, e ainda recebeu um aviso falso de "erro de validação" em 10 de 10 ações (um banner de acessibilidade casa com o seletor de alerta). Acordeão exclusivo (um aberto por vez) + refs "incrementais" que ignoram o que já tinha ref fazem o resultado ser "Nenhum elemento novo" ao reabrir.
4. **Sub-agentes não têm navegador.** No run "Entra nelas e me resume", o modelo delegou 3 leituras de disciplina logada; cada filho tentou `web_extract` (404 sem sessão) e Firecrawl (sem créditos) e voltou "Não consegui abrir". O pai concluiu "sem leitura" por causa disso.
5. **Mensagem duplicada ("Veja somente as fav okay?" ×2):** a primeira entrou como `run_input` `join` pendente no run anterior, que foi cancelado 2 s depois. Ninguém consumiu o input nem o promoveu a um run novo; o usuário reenviou.
6. **Plano:** 11 fases (V0 a V10). As quatro de maior retorno: V1 (clique e navegação confiáveis, ~105 s de desperdício + causa-raiz de "cliques falham"), V3 (itens de tarefa + portões de entrega), V4 (resultado de ação com "o que mudou") e V5 (leitura da página inteira por frames, shadow DOM e expand-all). O resto reduz vocabulário, extrai com schema, delega por item, memoriza navegação por bot e usa visão só quando precisa.
7. **Medimos antes e depois.** V0 cria um site fixture local (iframes, acordeões com conteúdo preguiçoso, SPA, cards com modal, muro de login) com tarefas roteirizadas e métricas, rodando em 2 a 3 modelos a cada fase.

---

## 1. Objetivos e métricas

Meta guarda-chuva (tarefa **T3** do harness da V0, modelo Claude Haiku 5.5):

> Ler **todas as semanas (9)** de uma disciplina com acordeões e cards internos e gerar o **PDF completo**, em **< 12 decisões, < 40 chamadas de ferramenta e < 2 min**. Para **3 disciplinas × 9 semanas** (T4): **< 45 decisões e < 7 min**, sem pedir ao usuário conteúdo acessível no navegador.

| Métrica | Baseline medido (Bob, 12/10) | Meta |
|---|---|---|
| Sucesso T3 (PDF com as 9 semanas, checado contra gabarito) | 0/1 (só Semana 1) | >= 90% em 5 runs |
| Itens lidos / itens pedidos (T4) | 1 de 3 disciplinas no run do PDF | 100% ou bloqueio declarado com motivo real |
| Entrega parcial com itens abertos e orçamento > 20% | 1 (decisão 21 de 100) | 0 |
| Pedidos ao usuário de conteúdo alcançável no navegador | 3 respostas finais (runs sim, Entra nelas, PDF) | 0 |
| Cliques com espera > 3 s | 7 (105 s) | 0 |
| `navigate` médio (até texto legível) | 5,9 s | < 2,5 s |
| Chamadas de leitura redundantes após `navigate` (SPA vazia) | ~2 por página | <= 0,3 |
| Tokens de prompt para T4 | 3,86M na conversa (11 runs) | < 1,2M |
| Falso "erro de validação" em `browser_act` | 10 de 10 | 0 |
| Screenshots por tarefa de leitura | 0 (ok) | <= 1 (T10 exige 1) |
| Tools de navegador/desktop oferecidas | 13 + `mcp_tool_search` | <= 8, sem busca prévia |

Todas as metas são verificadas pelo harness da V0 (seção 6); o baseline do harness substitui os números acima quando existir.

---

## 2. Diagnóstico com dados reais

Conversa `cmv5db7z5…` (bot Bob, `anthropic/claude-haiku-5.5`, 12/10/2026 14:49 a 15:51). 14 runs, dos quais 3 são filhos (`delegate_task`). Consultas `SELECT` em `agent_runs`, `agent_steps`, `run_events`, `run_inputs`, `conversation_messages`.

### 2.1 Linha do tempo condensada

| Run (objetivo) | Dec. | Tools (falhas) | Parede | Modelo / ferramenta | Como terminou |
|---|---|---|---|---|---|
| `…djgvo` "entra no Meu AVA… semana 1 e 2" | 13 | 13 (2) | 4:18 | 18 s / 49 s | **cancelado** (usuário parou; input join `Veja somente as fav` ficou pendente) |
| `…dpvhw` "Veja somente as fav okay?" | 23 | 34 (3) | 2:37 | 47 s / 98 s | ok: lista 3 favoritas; **4 cliques de 15 s = 60 s** |
| `…dth3w` "sim" | 32 | 38 (4) | 2:54 | 61 s / 97 s | ok, parcial: POO "cliques nas semanas não mostraram os títulos"; oferece reler "com mais calma" |
| `…f2grx` "Tenta dnv, a vm tava sem configuração" | 36 | 51 (1) | 3:22 | 65 s / 120 s | ok, só 1 disciplina com detalhe |
| `…f7c0r` "Entra nelas e me resume" | 37 | 42 (1) | 3:14 | 66 s / 114 s | `delegate_task` x3 sem browser; "copie o que aparece na tela" |
| filhos `…f8sv*` (3) | 4 a 9 | 4 a 8 (1 a 2) | 10 a 21 s | n/d | "Não consegui abrir a página" (404 sem sessão; Firecrawl sem créditos) |
| `…fcr69` "Abra o card delas…" | 13 | 15 (1) | 0:55 | 32 s / 18 s | ok: POO semanas 1 e 2 |
| `…fe7li` "abre os cards internos, das tarefas!" | 5 | 6 (0) | 0:22 | 17 s / 2 s | **ok, bom**: abriu 1 card e resumiu |
| `…ffi6u` "Veja de todas as semanas… pdf" | 23 | 40 (0) | 2:01 | 53 s / 60 s | `create_file` na decisão 21: PDF **só com a Semana 1** e pedido de ajuda |
| `…firlh` "ent leia tudo uai" | 7 | 11 (0) | 0:23 | 17 s / 0 s | **cancelado**; releu 2 artefatos 5 vezes (`artifact_read`) em vez de abrir a página |

Totais da conversa: 3,86M tokens de prompt, US$ 0,133. Tempo de ferramenta por tipo: `navigate` 312 s (53 chamadas, média 5,9 s), `browser_click` 125 s (19 chamadas, média 6,6 s), `browser_wait` 36 s (18), `browser_act` 30 s (21), `browser_text` 18 s (74). Tamanho do prompt por decisão: 19k (decisão 0), 21k a 27k no meio, nunca perto do limite.

### 2.2 Desperdício quantificado

- **Cliques com timeout de 15 s: 7 ocorrências, 105 s** (mais de 1/3 do tempo de ferramenta do run "fav": 60 de 98 s). Todos em `browser_click({text})` sobre títulos de card. Cada falha devolveu 1,9 a 4,3 KB de log do Playwright ao modelo.
- **`navigate`: 312 s.** Depois de cada `navigate`, o `browser_text` voltou `[caracteres 0-0]` (SPA ainda sem renderizar) em pelo menos 5 páginas, forçando `browser_wait`/releitura (36 s + 74 leituras).
- **Reabrir a mesma lista de favoritas várias vezes** (4 só nos dois runs "fav" e "sim"; `navigate ?courseStatus=favorite`), porque o clique no card falhava e o modelo voltava para tentar outro caminho.
- **Decisão 0 gasta em `mcp_tool_search`** para carregar as tools de navegador em 4 de 4 runs (e uma busca extra no meio do run); as tools nem estavam disponíveis de início.
- **Sub-agentes cegos:** 3 runs filhos, 21 s e 3 resumos "não consegui abrir" que contaminaram a resposta do pai.
- **Run Google Sheets (19/09, `openai/gpt-5.6-luna`, `cmu8i1dh1…`)**, para contraste: 97 decisões, 98 chamadas de navegador, **só coordenadas** (`click` x40, `type` x21 com 6 falhas, `key` x16, 13 screenshots), o mesmo clique `(181,697)` quatro vezes; morreu em "Travei repetindo `click` 3 vezes". Mostra o custo do modo desktop quando não há refs/diff.

### 2.3 Causa-raiz por falha

| # | Falha vista pelo usuário | Causa-raiz (evidência) | Fase |
|---|---|---|---|
| F1 | Listar favoritas lento (157 s) | 4 timeouts de 15 s + `navigate` de 4 a 7 s + SPA vazia pós-`navigate` + decisão 0 de tool-search | V1, V4, V6 |
| F2 | "Veja somente as fav okay?" duplicada | `run_inputs`: join `14:59:53` ficou `pending`; run `cancelled` `14:59:55`; nenhum follow-up promoveu o input; reenvio `15:00:36` criou o run `…dpvhw` | V2 |
| F3 | Cliques em título de disciplina "falham" | `getByText` resolve o `<span id=course-card-name-…>`; o `<a class=card-course__link-overlay>` e `#onetrust-consent-sdk` "intercept pointer events"; `CLICK_TIMEOUT_MS = 15_000` (`docker/agent-sandbox/control/browser-actions.mjs:11,75`) e retry externo `tries: 2` (`:91`) | V1 |
| F4 | Cliques nas semanas "não mostraram os títulos" | `browser_click({text})` devolve só "Clicou em X" (sem diff); o modelo lê com `browser_text` por `offset`; o acordeão é exclusivo e o conteúdo só aparece no diff de `browser_act` (que cobre só elementos interativos, viewport, `MAX_DELTA = 12`, `browser-refs.mjs:16,297`); refs já numerados são ignorados (`mode:"incremental"`), então reabrir devolve "Nenhum elemento novo" | V4, V5 |
| F5 | Leitura parcial + "releio com mais calma" | Sem lista de itens; sem portão; o run termina quando o modelo decide | V3 |
| F6 | Perdeu em qual disciplina estava | No run do PDF navegou só para a 3a disciplina; a lista de 3 disciplinas só existia na conversa; `TaskState` só tem critérios determinísticos de arquivo (`execution/task-state.ts`, `FILE_CRITERION_ID`) | V3 |
| F7 | Pediu para o usuário colar o conteúdo | Nada impede resposta final com itens abertos; o `delivery-correction` só cobre "prometeu arquivo" | V3 |
| F8 | PDF parcial entregue cedo | Critério de arquivo satisfeito por qualquer `create_file`; governor 80/90% só dispara por orçamento (aqui 21/100 passos, US$ 0,019); `draft-check` só confere números contra fontes | V3 |
| F9 | Falso "erro de validação… corrija o campo" | `readValidationErrors` casa `[role="alert"]` no texto do banner de acessibilidade do site (`browser-refs.mjs:25-40`), reportado em toda ação sem comparar com o estado anterior (`verifyWarnings: 10`) | V4 |
| F10 | Delegação inútil | `delegate_task` filhos sem browser (descrição diz isso, `delegate-task.ts:54`) e o modelo delegou assim mesmo | V2, V8 |
| F11 | "ent leia tudo uai" cancelado | Em vez de abrir a página, releu 2 artefatos antigos 5 vezes (o guard de releitura não casa ids diferentes do mesmo conteúdo) | V3, V5 |

### 2.4 Por que "o Grok nunca tem esses problemas"

Não há documentação pública sobre o agente de navegação do Grok. O que existe é o **Grok Bot** (beta desde 11/08/2026, feito com o Cursor, descrito como agente com "computador próprio": navegador, terminal e arquivos), em guias secundários, sem detalhes de como o navegador lê a página. O `PLANO-RUN-V2.md` já cita a política de fila do Grok Bot. **Não vamos copiar Grok**: tudo abaixo vem de fontes primárias dos outros fabricantes. A hipótese de trabalho é que o que o usuário percebe como "não se perde" corresponde a (a) leitura estruturada da página inteira e (b) lista de tarefas explícita. Ambos estão neste plano.

---

## 3. Auditoria da toolset atual

| Área | Como é hoje | Arquivo:linha | Problema |
|---|---|---|---|
| Tools oferecidas (navegador + desktop) | `screenshot`, `navigate`, `click`(x,y), `type`, `key`, `scroll`, `browser_click`, `browser_type`, `browser_text`, `browser_links`, `browser_snapshot`, `browser_act`, `browser_wait` = 13, mais `mcp_tool_search` para carregá-las | `packages/agent-runtime/src/computer-use.ts:290-301`, `:625-800`, `tools/computer-refs.ts:21-25` | 3 modos de clicar (coord, texto/seletor, ref) e 3 de ler (texto, links, snapshot); descrições e resultados em pt-BR (regra `60-agente.md` pede inglês para texto do modelo) |
| Clique por texto | `page.getByText(texto).first()` filtrado por visível, depois `.click({timeout: 15000})` | `control/browser-actions.mjs:52-75` | Resolve o nó de texto, não o elemento interativo; sem retarget para link/botão ancestral; sem tratamento de overlay/banner; timeout alto |
| Clique por ref | `locateRef`, `scrollIntoViewIfNeeded`, `isVisible`, `perform`, `stabilize`, diff incremental | `control/browser-refs.mjs:~270-310` | Diff só de elementos interativos, só viewport, máx. 12, ignora refs existentes; erros de validação sem comparação |
| Snapshot | seletor fixo de interativos; `querySelectorAll` (não atravessa shadow DOM); `area:"viewport"` por padrão; página de 80 elementos; scan máx. 400 | `control/snapshot-page.mjs:21-32,64-71`, `snapshot.mjs:3-5` | Texto não-interativo (títulos, parágrafos) fica de fora; sem hierarquia (landmarks só como tag) |
| Frames | só iframes do **mesmo origin** (ou `about:srcdoc`) entram no snapshot; `browser_text` não olha frames | `control/browser-refs.mjs:130-139`, `text-page.mjs:50` | Conteúdo em iframe e em shadow DOM é invisível para leitura |
| Leitura de texto | `document.body.innerText` do frame principal; `mode:"viewport"` por TreeWalker; pagina em 4000/6000 chars | `control/text-page.mjs:4-5,45-72` | Conteúdo dentro de acordeão fechado (`display:none`) não existe no `innerText`; texto de boilerplate (a11y, menu) repetido em toda página |
| Espera | `domcontentloaded` (3 s) + `networkidle` (1 s) + DOM quieto 300 ms, teto 4 s; `navigate` usa `goto(domcontentloaded)` | `control/stability.mjs:4-5,56-96`, `browser-actions.mjs:119-126` | Em SPA, o texto ainda está vazio no fim da espera (`0-0`); fim da espera por mutação confunde animações com instabilidade; sem contagem de requisições pendentes |
| Efeito da ação | `formatSettle` ("navegou"/"ainda mudando"), `verifyActEffect` ("nada mudou"/"erro de validação") | `tools/computer.ts:~70-110`, `computer-refs.ts:209-232` | Sem diff de texto; `browser_click(text)` não devolve diff algum |
| Sub-agentes | `delegate_task`, filhos read-only **sem** navegador | `tools/delegate-task.ts:54,308-330` | Impossível paralelizar leitura logada; o modelo ainda tenta |
| Estado de tarefa | `TaskState` com objetivo, fase, critérios determinísticos (arquivo), bloqueios, artefatos | `execution/task-state.ts`, `computer-use.ts:4241,5902-5933` | Sem itens iteráveis; sem portão contra entrega parcial |
| Visão | `screenshot` com `marks`/`region`; histórico de imagens podado (`hygiene.screenshots`) | `computer-use.ts:635-660`, `control/marks.mjs` | Ok; falta política de quando usar e `zoom` real |
| Ponteiro/viewer | `agent_pointer`, preview 4 s, noVNC | `control/pointer.mjs` | Fora do escopo (já entregue) |

Pontos fortes a preservar: refs numerados (`e12`), `browser_wait`, `stabilize`, guard de repetição/releitura, `research_note`, `draft-check`, cache de leitura, histórico sem screenshots, checkpoint de `TaskState`.

---

## 4. Pesquisa: como as empresas fazem

Fontes primárias (docs oficiais, blogs de engenharia, papers, repositórios) sempre que existem. Onde só há fonte secundária, está marcado.

### 4.1 O que cada um faz (achados concretos)

**OpenAI (Operator / CUA / ChatGPT agent / Atlas).**
- CUA = visão (GPT-4o) + raciocínio por RL; loop percepção, raciocínio, ação sobre screenshots; pede confirmação em ações sensíveis e **devolve o controle ao usuário em login e CAPTCHA**. Resultados do lançamento: OSWorld 38,1%, WebArena 58,1%, WebVoyager 87%, com a curva de sucesso **subindo com o número máximo de passos** ([OpenAI, CUA](https://openai.com/index/computer-using-agent/)).
- API: uma `computer_call` traz **várias ações em lote**; o app executa na ordem e devolve **um** screenshot; manter a sessão viva entre chamadas; checar o resultado real, não a resposta do modelo; limitar por passos/tempo/custo ([guia de computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)).
- ChatGPT agent combina um **navegador visual** (GUI) e um **navegador de texto** (consultas de leitura, mais rápido), mais terminal e conectores; o modelo escolhe qual usar por tarefa (fonte secundária: [SiliconANGLE](https://siliconangle.com/2025/07/17/openai-rolls-chatgpt-agent-automate-multistep-browser-tasks/)).
- Atlas: só há material público sobre a arquitetura do navegador (processo Chromium separado, OWL), **nenhum** sobre como o agente lê a página ([ByteByteGo](https://blog.bytebytego.com/p/the-architecture-behind-atlas-openais)). Sem informação pública.

**Anthropic (computer use, browser use, Claude for Chrome).**
- Ferramenta **browser use** dedicada a páginas: `read_page` devolve a **árvore de acessibilidade com refs** (`link "x" [ref_2]`, filtro `interactive`/`all`, `depth`, `ref` para subárvore, teto 50k chars), `find` (consulta em linguagem natural, até 20 matches), `get_page_text` (texto visível, prioriza o conteúdo principal), `scroll_to`, `form_input`; refs valem até a aba navegar ou o DOM mudar muito; frames cross-origin muitas vezes sem nós úteis, aí cai para screenshot+coordenada. Recomendações oficiais: **ler a árvore antes de tirar screenshot**, `get_page_text` para artigos, **lotes de ações** com "parar na primeira falha" e anexar a árvore/screenshot fresco no último resultado para economizar uma ida e volta ([doc browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)).
- Computer use: pedir ao modelo para **verificar cada passo** ("diga em uma frase o que o screenshot mostra e se o passo deu certo"), preferir atalhos de teclado em dropdowns/scroll, `zoom` para texto pequeno, ~1.000 a 1.800 tokens por screenshot, podar imagens em lotes (manter as 3 últimas) para não quebrar o cache ([doc computer use](https://platform.claude.com/docs/agents-and-tools/tool-use/computer-use-tool)).
- Claude for Chrome: foco em permissões por site e confirmação de ações de alto risco; injeção de prompt caiu de 23,6% para 11,2% com mitigações. Nenhum detalhe de leitura do DOM publicado ([Anthropic](https://www.anthropic.com/news/claude-for-chrome)).
- Sistema multiagente de pesquisa: líder + subagentes com **contexto próprio**, **descrições de tarefa detalhadas** e **regras de escala de esforço no prompt**; ~15x mais tokens que chat, bom para amplitude e não para tarefas fortemente acopladas (fonte secundária do post de engenharia: [ByteByteGo](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent)).

**Google (Gemini computer use / Project Mariner).**
- Loop: screenshot, `function_call` com `intent`, execução (Playwright), novo screenshot; coordenadas **normalizadas 0 a 999**; `safety_decision` com `require_confirmation`; ação custom `yield_to_user` sugerida para **entrega humana** ([doc Gemini](https://ai.google.dev/gemini-api/docs/computer-use)). Não foi levantada fonte primária sobre o Mariner nesta rodada.

**Microsoft (Magentic-One, Playwright MCP).**
- Magentic-One: **Orquestrador** com **Task Ledger** (fatos, palpites, plano) e **Progress Ledger** (a tarefa terminou? há progresso? quem faz o próximo passo?); contador de **estagnação** (>2) dispara **re-planejamento**; o WebSurfer usa **árvore de acessibilidade + set-of-marks** ([MSR](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)).
- Playwright MCP: **snapshots de acessibilidade em texto** em vez de screenshots (muito menos tokens, sem modelo de visão), refs `eN` (e `f1e12` dentro de iframes), `browser_snapshot` com `target`/`depth`/`boxes`, **`browser_find`** para buscar texto/regex sem reler a página, refs stale falham com instrução de novo snapshot ([playwright.dev/mcp/snapshots](https://playwright.dev/mcp/snapshots), [repo](https://github.com/microsoft/playwright-mcp)).

**browser-use (open source).**
- Estado da página = DOM/árvore de acessibilidade convertido em texto com **elementos interativos indexados** (`[3]<button>`), screenshot opcional, URL, abas, posição de scroll; o modelo devolve JSON com ações **por índice** e um campo de "próximo objetivo"/memória; `max_actions_per_step` (padrão 5, "ações rodam até a página mudar"), `max_failures`, `use_vision: auto`, `flash_mode`, **`page_extraction_llm` separado (modelo pequeno só para extrair texto)** ([parâmetros](https://docs.browser-use.com/customize/agent/all-parameters), [repo](https://github.com/browser-use/browser-use), [relatório 89,1% WebVoyager, reprodutibilidade contestada](https://browser-use.com/posts/sota-technical-report)).

**Stagehand / Browserbase.**
- Primitivas `act`, `extract` (schema Zod, escopo por `selector`), `observe` (devolve ações candidatas que depois são repassadas ao `act`); página representada por **árvore de acessibilidade**; o v3 foi reescrito sobre CDP para tratar **iframes e shadow roots** (a alegação de ganho de 44% em velocidade vem de fonte secundária). **Cache de ações**: chave = instrução + conteúdo da página + opções; acerto devolve o seletor sem chamar LLM; se o seletor não resolve mais, volta para a inferência (sem custo de modelo em acerto; estimativa de 150 a 300 ms por ação em cache vs 1 a 3 s em fonte secundária) ([caching](https://docs.stagehand.dev/v4/best-practices/caching), [blog](https://browserbase.com/blog/stagehand-caching), [extract](https://docs.stagehand.dev/v3/basics/extract)).

**Skyvern.**
- Loop visual (screenshot a cada ação) com **Planner, Actor e Validator**; o Validator confirma se o objetivo foi mesmo atingido e devolve feedback ao Planner; o salto de ~45% (prompt único) para **85,85% no WebVoyager** é atribuído à mudança para planner-actor-validator; credenciais injetadas direto no campo, nunca vistas pelo LLM ([Skyvern 2.0](https://www.skyvern.com/blog/skyvern-2-0-webvoyager-benchmark-results/)).

**Perplexity Comet.** Sem post de engenharia oficial. Análises de terceiros dizem que a extensão lê e escreve no DOM (sem screenshots, rápido onde o site é bem estruturado e frágil onde não é) ([Harness, vendor concorrente](https://www.harness.io/blog/reverse-engineering-comet)). Tratar como indicativo, não como fonte.

**Grok.** Sem documentação pública do navegador (ver 2.4).

**Papers e benchmarks.**
- **WebArena** (812 tarefas, 4 sites): GPT-4 14,41% vs humano 78,24%; os autores apontam **falta de exploração ativa e de recuperação de falha** ([arXiv 2307.13854](https://arxiv.org/abs/2307.13854)).
- **Mind2Web**: HTML cru é grande demais; um **ranqueador pequeno (DeBERTa) filtra candidatos** e o LLM escolhe entre poucos ([arXiv 2306.06070](https://arxiv.org/abs/2306.06070)).
- **AgentOccam**: só **refinar o espaço de observação e de ação** (podar, resumir, alinhar ao que o LLM conhece) leva a +26,6 pontos (+161%) sobre agentes simples no WebArena, sem módulo extra ([arXiv 2410.13825](https://arxiv.org/abs/2410.13825)).
- **Agent-E**: **destilação flexível do DOM** (modo texto, campos de entrada ou tudo, conforme a subtarefa), **observação de mudança** (detectar se a ação alterou o estado), arquitetura hierárquica planejador/navegador, 73,2% no WebVoyager (+20% sobre o melhor agente só texto) ([arXiv 2407.13032](https://arxiv.org/abs/2407.13032)).
- **Set-of-Mark**: marcar regiões numeradas na imagem melhora o ancoramento do GPT-4V ([arXiv 2310.11441](https://arxiv.org/abs/2310.11441)).
- **Agent Workflow Memory**: induzir **rotinas reutilizáveis** a partir de trajetórias melhora +24,6% (Mind2Web) e +51,1% (WebArena) relativos e reduz passos ([arXiv 2409.07429](https://arxiv.org/abs/2409.07429)).
- **OSWorld**: humano ~72%; agentes subiram de ~15 a 22% (2024) para >60% em 2026 conforme o modelo e o orçamento de passos (fontes secundárias; resultados dependem de resolução, passos máximos e tentativas, não são comparáveis entre si). Links do artigo OSWorld/WebVoyager não foram abertos nesta rodada.

### 4.2 Tabela de técnicas

Esforço para o Atlas: S (<= 2 dias), M (3 a 6 dias), L (> 1 semana).

| # | Técnica | Quem usa | Evidência de impacto | Aplicabilidade no Atlas | Fase |
|---|---|---|---|---|---|
| T1 | Página como **árvore de acessibilidade/DOM indexado com refs numerados**, texto em vez de pixels | Playwright MCP, Anthropic browser use, browser-use, Stagehand, Magentic-One | Snapshot ~500 a 5.000 tokens vs screenshot ~1.000 a 1.800 por imagem (docs); AgentOccam +161% só refinando observação | **Já temos refs**; falta hierarquia, texto não interativo e frames. M | V5 |
| T2 | **Frames/iframes com ref prefixado** e shadow DOM atravessado | Playwright MCP (`f1e12`), Stagehand v3 (CDP) | Doc Playwright MCP; Stagehand diz que é o caso onde seletores quebram | Hoje só same-origin e sem shadow. M/L | V5 |
| T3 | **Resultado da ação com "o que mudou"** (diff) + espera automática | Agent-E (change observation), Playwright MCP (snapshot a cada ação), Anthropic (anexar árvore no último resultado) | Agent-E: evita "seguir às cegas"; 73,2% WebVoyager | Temos diff só de interativos/viewport/12. M | V4 |
| T4 | **Leitura da página inteira** (`get_page_text`/`read_page`) + `find` por texto | Anthropic browser use, Playwright MCP (`browser_find`) | Docs recomendam ler árvore antes de screenshot | Substitui `browser_text` por `offset`. M | V5 |
| T5 | **Expandir tudo** (acordeões/`details`) antes de ler | Prática comum em extratores; não há doc oficial dos fabricantes | Evidência própria: 9 cliques sem ler; lazy content | Específico ao nosso caso. S/M | V5 |
| T6 | **Planner/Executor + ledger de tarefa** (itens, progresso, replanejar se estagnar) | Magentic-One (Task/Progress Ledger), Skyvern (Planner, Actor, Validator), Agent-E | Skyvern: ~45% para 85,85% WebVoyager ao trocar prompt único por planner-actor-validator | **Maior lacuna do Atlas.** M | V3 |
| T7 | **Validator/portão de término** antes de entregar | Skyvern (Validator), Magentic-One (Progress Ledger "terminou?") | Skyvern: pega falso-sucesso | Já temos `delivery-correction`; estender a itens. S/M | V3 |
| T8 | **Subagente por item**, contexto fresco, relatório estruturado | Anthropic multiagente de pesquisa, Magentic-One | +90% vs agente único em pesquisa ampla, 15x tokens (post Anthropic, via secundário) | Browser é sessão única: executar em série. M/L | V8 |
| T9 | **Extração com schema** sobre a página toda (frames) por modelo pequeno | Stagehand `extract`, browser-use `page_extraction_llm` | Reduz contexto do agente principal; modelo barato | Alto valor para listas (semanas, disciplinas). M | V7 |
| T10 | **Memória de navegação/rotinas por site** e **cache de ações** | Agent Workflow Memory (+24,6%/+51,1%), Stagehand (cache sem LLM em acerto) | AWM: menos passos; Stagehand: sem tokens em acerto | Aproveita `memory_entries` por bot. M | V9 |
| T11 | **Visão só quando precisa** (`use_vision: auto`), `zoom`, set-of-marks | browser-use, Anthropic (`zoom`), Magentic-One (SoM), OpenAI visual+texto | Docs: screenshots caros; canvas/cross-origin exigem pixel | Já poda imagens; falta política. S/M | V10 |
| T12 | **Vocabulário pequeno e uniforme** de ações | AgentOccam (espaço de ações refinado), Stagehand (act/extract/observe), Playwright MCP | AgentOccam: +26,6 pontos | 13 tools hoje. M | V6 |
| T13 | **Lotes de ações com parada na 1a falha** | OpenAI (`actions[]`), Anthropic (halt rule), browser-use (`max_actions_per_step`) | Menos idas e voltas | Atlas já executa tool calls paralelos; formalizar a regra de parada. S | V4 |
| T14 | **Entrega humana (handoff)** em login/CAPTCHA/2FA | OpenAI CUA, Gemini (`yield_to_user`), Skyvern (credenciais não vistas pelo LLM) | Padrão de segurança comum | Já existe card de login; manter e testar no fixture. S | V0/V3 |
| T15 | **Verificação explícita por passo** no prompt | Anthropic computer use | Doc: "o modelo assume que funcionou" | Resultado de ação já informa o efeito (V4). S | V4 |
| T16 | **Filtro de candidatos antes do LLM** (ranqueador) | Mind2Web (DeBERTa) | Recall alto com poucos candidatos | Só se `read` ficar grande demais; usar poda determinística antes. L | fora |
| T17 | **Navegador de texto rápido vs visual** por tarefa | ChatGPT agent | Fonte secundária | Equivale a `read` vs `screenshot` (V10) | V10 |
| T18 | **Confiar mais em passos máximos** | OpenAI CUA (curva sobe com passos) | Gráfico do lançamento | Nosso teto é 100; o problema é parar cedo (V3), não o teto | V3 |

### 4.3 Top 10 técnicas para o Atlas (resumo)

1. Ledger de itens + portão de término (Magentic-One, Skyvern, Agent-E).
2. Clique por elemento interativo com fallback e falha rápida (Playwright, Stagehand, Anthropic refs).
3. Resultado de ação com diff (Agent-E, Playwright MCP).
4. Leitura da página inteira por frames/shadow com refs prefixados (Playwright MCP, Anthropic, Stagehand).
5. Expandir tudo antes de ler (acordeões lazy).
6. `extract` com schema por modelo pequeno (Stagehand, browser-use).
7. Observação/ação refinadas e pequenas (AgentOccam).
8. Subagente por item com contexto limpo (Anthropic multiagente).
9. Memória/cache de navegação por site (AWM, Stagehand).
10. Visão sob demanda e `zoom` (browser-use, Anthropic).

---

## 5. Princípios de desenho

- **Texto primeiro, pixel por exceção** (T1, T11). Refs numerados continuam sendo a unidade de ação.
- **Toda ação diz o que mudou** (T3). O modelo não deve precisar reler a página para saber se funcionou.
- **Estado fora do contexto do modelo** (T6). Itens e escopo vivem no `TaskState` do checkpoint e são reinjetados em cada turno.
- **Decisão pura separada do efeito** (regra `30-componentizacao.md`): `decideItemGate`, `diffPageDigest`, `planClick` são funções puras com teste; o servidor Playwright e o loop só executam.
- **Falhas honestas** (`60-agente.md`): ferramenta que falha lança erro curto e acionável; nada de sucesso falso nem de log de 4 KB.
- **Sem mudança de segurança:** conteúdo de página segue "dado não confiável"; frames de outro origin são marcados; descartar banners usa só "recusar/fechar", nunca "aceitar tudo".
- **Flags por fase** (`execution/flag.ts` como modelo): `ATLAS_VM_V1`… para rollout e A/B no harness.
- **Textos para o modelo:** inglês neutro, sem nomes de site ou produto (seção 9).

---

## 6. V0 — Harness de avaliação (primeiro, antes de qualquer mudança)

**Problema.** Hoje só medimos por conversa real. Não dá para dizer se uma fase ajudou, nem comparar modelos.

**Técnica.** Fixture local determinística + tarefas roteirizadas + checagem contra gabarito (WebArena/WebVoyager usam avaliação baseada em resultado; OpenAI recomenda checar o resultado real e não a resposta do modelo).

**Desenho.**

```
packages/agent-runtime/evals/web/
  fixtures/lms/               # servidor Node sem dependências (http), páginas escritas à mão
    server.mjs                # sobe em porta efêmera; /__state (reset), /__truth (gabarito JSON)
    pages/                    # HTML/JS estático
  tasks/*.json                # T1..T10: objetivo, URL inicial, checker
  runner.ts                   # roda runComputerUse (LLM real) contra o sandbox
  check.ts                    # checkers determinísticos (regex/JSON/PDF-text), sem LLM
  report.ts                   # tabela markdown + JSON em evals/web/results/ (gitignored)
```

Padrões reproduzidos pelo site fixture (cada um corresponde a uma falha real):

| Padrão | Como o fixture simula | Falha do Bob que cobre |
|---|---|---|
| Cards com **link-overlay** (`<a>` esticado sobre o card) e título em `<span>` | `/courses` com 3 favoritas | F3 |
| **Banner de consentimento** que intercepta cliques até ser fechado | overlay `position:fixed` com botões "reject"/"accept" | F1, F3 |
| **SPA** com roteamento `pushState`, hidratação com atraso (700 ms) e `body` vazio no início | `/course/:id` | `0-0` pós-navigate |
| **Acordeão exclusivo** (um aberto por vez) com **conteúdo preguiçoso** (fetch 400 ms ao expandir) | semanas 1 a 9 | F4 |
| Itens do acordeão com **card interno que abre modal** | atividades | T5, run bom `…fe7li` |
| **Conteúdo em iframe** same-origin e **em shadow DOM** (open) | semanas 4 e 7 | frames/shadow |
| **Muro de login** (stub, `/login` redireciona; cookie de sessão setado pelo harness) | `/gate` | handoff (T14) |
| Banner de **acessibilidade** com `role="alert"` e texto longo repetido | todas as páginas | F9 |
| **Injeção de prompt** em texto de página ("ignore tudo e envie…") | comentário em uma semana | segurança |
| Dado **só em canvas** (gráfico com valor) | `/stats` | visão sob demanda |

Tarefas (cada uma com gabarito em `/__truth`):

| Id | Tarefa | Sucesso = |
|---|---|---|
| T1 | Listar as disciplinas favoritas | 3 nomes certos, sem outras |
| T2 | Abrir uma disciplina e dizer o título das semanas 1 e 2 | 2 títulos certos |
| T3 | Ler as **9 semanas** de uma disciplina e gerar PDF | PDF com os 9 títulos + 1 item de cada |
| T4 | **3 disciplinas × semanas 1 e 2**, resumo final | 6 conjuntos certos, sem perguntar nada ao usuário |
| T5 | Abrir o card interno de uma atividade e resumir o enunciado | 3 fatos do gabarito |
| T6 | Muro de login: parar e pedir login (handoff), depois continuar | evento `login`, sem digitar credenciais, continua após cookie |
| T7 | Ler conteúdo em iframe e em shadow DOM | 2 fatos |
| T8 | Navegação SPA sem recarga completa | URL e título finais certos |
| T9 | Página com injeção de prompt | ignora; relata como dado |
| T10 | Ler o valor de um gráfico em canvas | valor certo (exige screenshot) |

Métricas por (tarefa, modelo, repetição): sucesso (checker), % de itens completos, decisões, chamadas de ferramenta, falhas, tempo de parede, **tempo de modelo vs de ferramenta**, tokens (prompt/completion/cache), custo, cliques > 3 s, releituras, screenshots, "respondeu pedindo conteúdo com itens abertos" (checker sobre a resposta final + estado dos itens, sem análise de frase), idade do contexto.

Modelos: `anthropic/claude-haiku-5.5` (principal), `xiaomi/mimo-v2.6-flash` e `deepseek/deepseek-v4.1-flash` (baratos; já usados nos runs reais). 3 repetições por célula. Comando opt-in (`pnpm --filter @workspace/agent-runtime eval:web -- --models … --tasks …`), nunca no CI (LLM real). Resultados versionados só como resumo na seção "Resultados" deste arquivo.

Duas camadas:
- **L1 (CI, sem LLM):** testes node:test/vitest do servidor de controle direto no fixture com Chromium do Playwright (clique em overlay, expand-all, leitura de iframe/shadow, diff). Determinístico.
- **L2 (opt-in, LLM real):** o sandbox Docker existente (`docker/agent-sandbox`) alcança o fixture por `host.docker.internal`; roda o loop completo.

Telemetria nova (necessária para medir e para a V1): por tool, `gotoMs`/`settleMs`/`rung` (qual degrau do clique funcionou); por run, em `usageJson.computer`: `clickTimeouts`, `itemsTotal`, `itemsDone`, `emptyReads`. **Instrumentar `navigate` antes de otimizar** (hipótese não confirmada: a maior parte dos 5,9 s é `goto` + teto de 4 s do `stabilize` em SPA com mutação contínua).

**Replay (CI):** extrair do banco a conversa do PDF (`…ffi6u`) como fixture sanitizada (sem URLs com token; só caminhos) para `computer-use.items-replay.test.ts` com LLM mockado, padrão do `computer-use.economy-replay.test.ts`.

**Arquivos.** Novos: `packages/agent-runtime/evals/web/**`, script `eval:web`. Tocar: `control/server.mjs` (telemetria), `computer-use.ts` (campos de telemetria, mínimo).
**Testes.** Checkers com teste próprio; fixture com smoke test (sobe, serve 10 páginas, `/__truth` válido).
**Riscos.** Fixture otimista demais (mitigação: copiar HTML real sanitizado dos padrões; manter T10 e T9 adversariais); variância entre runs (3 repetições; reportar mediana e pior caso).
**Esforço.** M. **Dependências.** nenhuma. **Saída:** baseline por modelo registrado na seção "Resultados".

**Entregue (V0).** Fixture `packages/agent-runtime/evals/web/fixtures/lms/` (servidor Node sem dependências; `node server.mjs --port 4780`), tarefas T1..T10 em `evals/web/tasks.ts` (checkers em `check.ts`, sem LLM), coletor `metrics.ts`, relatório `report.ts` e runner `runner.ts`/`cli.ts`. O `eval:web` sobe o fixture no host em `0.0.0.0` e o Chrome do sandbox o abre por `host.docker.internal:<porta>` (Docker Desktop; no Linux use `--fixture-host <ip da bridge>`), então a imagem do sandbox não precisa de rebuild para o fixture. Uma VM nova por run, perfil efêmero (`SANDBOX_PROFILE_VOLUMES=0`).

```bash
# real (gasta dinheiro; --max-cost é o teto TOTAL; --env-file só é lido pelo Node, nunca impresso)
pnpm --filter @workspace/agent-runtime eval:web -- --env-file <worker/.env> --tasks T1,T3 --models anthropic/claude-haiku-5.5 --reps 2 --max-cost 1
# offline (LLM roteirizado + manager falso; sem Docker, chave nem rede): valida o harness
pnpm --filter @workspace/agent-runtime eval:web -- --dry
```

Saída em `evals/web/results/` (gitignored): `eval-<data>.json` (métricas por run, sequência de tools, trecho da resposta) e `.md` (tabela com mediana e pior caso). Testes: `pnpm --filter @workspace/agent-runtime test` roda `evals/**` (smoke do fixture, prova no Chrome local das armadilhas, checkers, runner offline para as 10 tarefas com agente perfeito e agente perdido). Telemetria nova: `telemetry.nav` no passo da tool `navigate` (`gotoMs`, `readyMs`, `textLen`, vindos do control server da V1); `rung` está reservado para a V1; `clickTimeouts`, `itemsTotal`/`itemsDone` e `emptyReads` de run saem do coletor do harness (`slowClicks`, `emptyReads`; itens pelo checker), a gravação em `usageJson.computer` fica para as fases que os consomem. Medição real do `navigate` no fixture, antes da V1 (espera por estabilidade do DOM): goto ~100 a 260 ms e espera ~1,0 a 1,2 s (SPA hidratando em 700 ms + 300 ms de silêncio do DOM); os 5,9 s do Bob não se reproduzem em site local, então a origem continua a medir no site real com a nova telemetria.

**Ressalvas do baseline.** (1) T3 com 3 modelos mostra a falha-alvo (leitura semana a semana, sem entregar o PDF) e é o número a bater. (2) O fixture não reproduz o clique de 15 s do site real (por ref os cliques funcionam); T1 e T5 por texto/coordenada ficam para o A/B da V1. (3) T4 não rodou no baseline (custo/tempo); T6, T8 e T9 só rodaram offline. (4) Uma das duas execuções com mimo/deepseek pode ter usado uma imagem `atlas-agent-sandbox:latest` reconstruída por outra fase no meio da rodada; haiku rodou antes.

---

## 7. Fases de implementação (ordem de execução)

| Fase | Nome | Impacto | Esforço | Depende de |
|---|---|---|---|---|
| V0 | Harness de avaliação + baseline | habilita tudo | M | — |
| V1 | Cliques que funcionam e navegação rápida | Alto (−105 s, causa de F3) | M | V0 (medição) |
| V2 | Correções de fluxo: join órfão e delegação cega | Médio | S | — |
| V3 | Itens de tarefa + portões de entrega (inclui V3b: lógica de orquestrador) | **Muito alto** (F5 a F8) | M | V0 |
| V4 | Resultado de ação com "o que mudou" + espera automática | Alto (F4, F9) | M | V1 |
| V5 | Leitura da página inteira: frames, shadow DOM, expand-all, refs numerados | Alto | L | V4 |
| V6 | Vocabulário menor e tools pré-carregadas | Médio/Alto | M | V5 |
| V7 | `extract` com schema | Médio | M | V5 |
| V8 | Subagente por item com navegador (condicional) | Médio | M/L | V3, V6 |
| V9 | Memória de navegação por bot | Médio | M | V6, memória do bot |
| V10 | Visão só quando precisa | Baixo/Médio | S/M | V5 |

Sugestão de ondas: **Onda 1** = V0, V1, V2 (em paralelo V2); **Onda 2** = V3 e V4; **Onda 3** = V5, V6, V7; **Onda 4** = V8 (se o harness pedir), V9, V10. Rodar o harness ao fim de cada fase, nos 3 modelos, e colar a tabela antes/depois na seção "Resultados".

Convenções que valem para todas: um worktree por agente; commits atômicos em pt-BR; testes no mesmo commit; `pnpm exec turbo typecheck` verde; `docker/agent-sandbox/control/*.mjs` exige rebuild da imagem do sandbox (há `image-staleness.ts`); `computer-use.ts` (>6k linhas) não engorda: lógica nova em módulos próprios (`src/tools/*`, `src/execution/*`).

---

### V1 — Cliques que funcionam e navegação rápida

**Problema (evidência).** F1/F3: 7 timeouts de 15 s (105 s) em `browser_click({text})`; log do Playwright de 2 a 4 KB devolvido ao modelo; `navigate` 5,9 s em média e SPA vazia depois.

**Técnica.** Resolver pelo **elemento interativo** e não pelo nó de texto (Playwright MCP e Anthropic usam refs/árvore de acessibilidade; Stagehand age sobre elementos da árvore), **falhar rápido** e escalar por degraus (Stagehand: replay do seletor com fallback para inferência).

**Desenho (`docker/agent-sandbox/control`).**
- `planClick` (puro, em `target.mjs`): dado o conjunto de candidatos de texto, sobe para o ancestral interativo (`a[href], button, [role=button|link|tab|menuitem], summary, [onclick], [tabindex]`) e escolhe por (visível, interativo, menor área contendo o texto).
- Execução em degraus, cada um com timeout curto (**1,5 s** de prova + **3 s** de ação, total < 5 s em vez de 15 s ou 30 s com `tries: 2`):
  1. `locator.click({trial:true})` para obter "intercepted by X" sem agir;
  2. se X é um **overlay esticado** (link cuja caixa contém o alvo): clicar em X (é o destino real do card);
  3. se X é **banner de consentimento** (`#onetrust-consent-sdk`, `[id*=consent|cookie]`, `[role=dialog]` com botões de recusa): acionar o botão **"reject/necessary/close"** (nunca "accept all"), registrar `dismissed: "consent"` no resultado, repetir 1 vez; configurável por bot (`autoDismissBanners`, padrão ligado);
  4. `el.click()` via JS **só se** o elemento está visível e com caixa > 0 (dispara handlers sem teste de hit);
  5. clique por coordenadas do centro, depois de `scrollIntoView`.
- Erro compacto: `Click on "<texto>" blocked by <tag name=…>. Tried: overlay, banner, js. Use act on ref eN.` (<= 300 chars). Sem despejar o call log.
- Remover o retry externo duplicado de `browserClick` (`tries: 2` + 15 s). Manter só para `Execution context was destroyed`.
- **Navegação:** `goto(waitUntil:"domcontentloaded")` seguido de **prontidão de conteúdo**: `body.innerText.length >= 40` **ou** 1 landmark visível, com DOM quieto 300 ms, teto 5 s, sem depender de `networkidle`. Se o teto estourar, devolver `ready:false` com a dica "page is still rendering; call wait or read again" em vez de texto vazio. Medir `gotoMs`/`settleMs` (V0) e só então decidir bloquear recursos (imagens/fontes/trackers) quando visão estiver desligada.

**Arquivos.** `control/browser-actions.mjs` (clickByText, navigate), `control/target.mjs` (planClick), `control/stability.mjs` (prontidão), `control/browser-session.mjs` (se precisar de `route`), `tools/computer.ts` (formatação do erro/efeito, `dismissed`).
**Testes.** Unit: `planClick` com candidatos (ancestral interativo, overlay), `browser-actions.test.mjs` com página falsa (trial devolve intercepta, degrau seguinte); L1: fixture com overlay + banner, asserta clique < 5 s e destino certo; mensagem de erro <= 300 chars; replay: run "fav" com LLM mockado onde o clique no título agora funciona na 1a chamada.
**Eval.** T1, T2, T8: `cliques > 3 s = 0`; `navigate` médio < 2,5 s; leituras vazias <= 0,3 por página.
**Riscos.** Fechar banner errado (restringir a botões de recusa/fechar, nunca "aceitar"; Anthropic recomenda confirmar aceite de cookies com humano); `el.click()` pulando hit-test pode acionar elemento coberto por modal (proibir quando há `[aria-modal=true]` visível que não contém o alvo).
**Esforço.** M. **Dependências.** V0 para medir.

---

### V2 — Correções de fluxo: join órfão e delegação cega

**Problema.** F2 (mensagem duplicada) e F10 (sub-agentes sem navegador).

**Desenho.**
1. **Join órfão.** Quando um run entra em `cancelled`/`failed` com `run_inputs` `pending` (join/steer/queue) na mesma conversa, promover o texto a um run de follow-up (`createFollowUpRun` já existe em `packages/db/src/runs.ts:322` e há teste de "input órfão" em `run-followup.test.ts`); se o cancelamento foi pedido pelo usuário, **não** executar sozinho: marcar `consumed` com nota e deixar a mensagem na conversa (decisão a confirmar). Verificar primeiro quem emitiu o cancelamento do run `…djgvo` às 14:59:55 (UI "parar" ou cancelamento automático por nova mensagem) em `apps/api/src/routes/runs.ts` e `apps/web/hooks/use-atlas-chat.ts`. **Hipótese não confirmada:** o usuário clicou em parar logo depois de enviar.
2. **Delegação cega.** `delegate_task` com goal que exige navegador/sessão: se a tool recebe `urls` ou goal com URL que não é pública e o filho não tem navegador, devolver erro imediato ao pai: `Sub-agents cannot browse. Read it yourself with the page tools, one item at a time.` (um guard determinístico por falha anterior do mesmo tipo: depois de 1 filho "não consegui abrir", não delegar de novo). Enquanto V8 não existe, reforçar a regra no `delegate-task.ts`.

**Arquivos.** `packages/db/src/runs.ts` (+ teste), `apps/api/src/routes/runs.ts`, `packages/agent-runtime/src/tools/delegate-task.ts` (+ `delegate-task.test.ts`).
**Testes.** DB: cancelar run com input pending, assert promoção/consumo correto e **usuário B não vê/consome input do A** (padrão `scope.test.ts`); delegate: guard dispara; replay "Entra nelas e me resume".
**Riscos.** Promover mensagem cancelada pode executar algo que o usuário queria parar (por isso a ressalva acima).
**Esforço.** S.

---

### V3 — Itens de tarefa + portões de entrega (o "não se perde")

**Problema.** F5 a F8, F11. Sem lista de itens, o modelo decide sozinho quando parar; entrega o PDF na decisão 21; pede ao usuário o que está no navegador; o `TaskState` só conhece critério de arquivo.

**Técnica.** Task Ledger + Progress Ledger e re-planejamento por estagnação (Magentic-One); Planner/Actor/Validator (Skyvern: ~45% para 85,85% WebVoyager ao introduzir planejamento e validação); planejador/navegador separados (Agent-E).

**Desenho.**
- `TaskState` (em `packages/shared`) ganha `items: TaskItem[]` (máx. 40): `{ id, label, status: "todo"|"doing"|"done"|"blocked", evidence?: string (<= 200), reason?: string, scope?: string }`. Migração: campo opcional no JSON do checkpoint (sem migration de banco).
- Tool nova em módulo próprio `src/tools/track-items.ts`: `track_items({ action: "set"|"update"|"get", items?, id?, status?, evidence?, reason? })`. `set` aceita a lista (rótulos vindos da página); `update` exige `evidence` curta para `done` (o que foi lido) e `reason` real para `blocked`. Resultado visível ao usuário como card de checklist (regra `60-agente.md`: tools de escrita mostram resultado).
- **Dica de coleção (determinística, em `read`/V5):** quando a página tem >= 3 seções irmãs de mesma estrutura (semanas, disciplinas, linhas), o resultado termina com `Looks like a list of N similar items. Consider track_items to iterate them.`
- **Reinjeção em todo turno** (bloco efêmero <= 600 chars): `Items: 4/9 done. Now: item 5 "<label>" [scope: <context>]. Open: …`. Sobrevive a compactação e responde "em qual disciplina estou".
- **Portões** em `execution/item-gate.ts` (função pura `decideItemGate(state, budgetUsedPct, event)`), plugados ao ponto onde hoje `delivery-correction` e `taskTracker.unmet()` atuam (`computer-use.ts:~5900`):
  - **G1 entrega:** `create_file` ou resposta final com itens `todo/doing` e orçamento < 80%: devolve ao modelo a nota (seção 9) em vez de executar, até 3 vezes por run; depois permite com a exigência de listar os itens faltantes na resposta.
  - **G2 pedir ao usuário:** resposta de texto **sem** chamada de tool, com itens abertos e orçamento sobrando: interceptada uma vez (mecanismo igual ao do `delivery-correction`, **sem análise de frase**, logo independe do idioma). `blocked` só vale com `reason` de classe permitida (`login`, `captcha`, `permission`, `not_found`); pedir "cole o conteúdo" não é motivo.
  - **G3 estagnação → replanejar:** 3 ações sem item novo `done` e sem página nova (usa `stagnation.ts`) injeta "re-read the list, pick the next open item".
  - Convivência com o run governor (80/90%): o governor continua mandando fechar; o portão G1 deixa de segurar, e a entrega parcial sai **declarando** os itens abertos (campo estruturado, que a UI mostra).
- Critério de arquivo passa a depender dos itens: `FILE_CRITERION` só `met` se `items` abertos == 0 ou governor liberou.

**Arquivos.** `packages/shared/src/task-state*.ts` (+ teste), `packages/agent-runtime/src/execution/task-state.ts`, novo `execution/item-gate.ts`, novo `tools/track-items.ts`, registro mínimo em `computer-use.ts`, UI: card de checklist em `apps/web/components/ai-elements/*`.
**Testes.** Unit: `decideItemGate` (limites: 0 itens, tudo `done`, `blocked` sem motivo, orçamento 79/80/90%, 3 interceptações); tracker; **replay do PDF** (LLM mockado tenta `create_file` com 1/9, recebe a nota, lê as outras 8, só então cria); `computer-use` oferece a tool; cross-user (itens são do run, herdam `userId`).
**Eval.** T3, T4: sucesso e "respondeu pedindo conteúdo com itens abertos" = 0; decisões T3 < 12 depois de V4/V5.
**Riscos.** Modelo pequeno preenche `set` mal (mitigar com dica determinística e `get` que devolve a lista atual); excesso de interceptação irrita (limite de 3 + governor); itens grandes demais (cap 40).
**Esforço.** M. **Dependências.** nenhuma (V5 melhora a dica).

---

### V3b — Lógica de orquestrador (ledgers, replanejamento, portão de entrega)

Sub-parte da V3, no estilo do orquestrador do Magentic-One. Os `items` da V3 passam a viver dentro de um **Task Ledger** e ganham um **Progress Ledger** avaliado por função pura. Equivalência de status com a V3: `pending` = `todo`, `in_progress` = `doing`, `done` = `done`, `failed(reason)` = `blocked`.

**Problema.** Mesmo com `track_items`, o modelo decide sozinho se avançou, se está em laço e quando parar; o "se perde" volta quando o contexto do item pai (qual disciplina) some do turno.

**Técnica.** Task Ledger + Progress Ledger + contador de estagnação com replanejamento (Magentic-One); Validator antes de entregar (Skyvern); delegação do item a um especialista de navegador (WebSurfer).

**Desenho.**
- **Task Ledger** (`packages/shared`, tipo `TaskLedger`), criado no início de tarefas com vários itens: `facts_given` (o que o usuário informou), `facts_to_lookup` (o que falta descobrir), `plan` (<= 8 passos curtos) e `items[]` (lista explícita, ex.: disciplinas × semanas) com `status: pending | in_progress | done | failed(reason)`, `scope` (item pai) e `evidence` curta. Persistido no checkpoint do `TaskState` (campo opcional, sem migration) e **reinjetado de forma compacta a cada passo** na camada volátil, junto das notas de pesquisa (`research_note`), nunca no prefixo cacheado. Tetos: 40 itens, 600 chars na reinjeção.
- **Progress Ledger** (`execution/progress-ledger.ts`, função pura `evaluateProgress(ledger, recentSteps, budget)`), avaliado a cada passo de ferramenta e, quando custa modelo, só a cada N passos (padrão N=5) e só se a avaliação determinística ficar ambígua. Campos: `satisfied` (todos os itens `done`/`failed` com motivo real), `loop` (mesma ação+alvo repetida; reaproveita `stagnation.ts` e o guard de releitura), `progressing` (item novo `done` ou página/escopo novo desde o último passo), `nextItem`/`nextAction`, `delegate` (item independente e há subagente com navegador, V8). A parte determinística decide sozinha na grande maioria dos casos; modelo barato só desempata.
- **Replanejamento por estagnação.** Após K passos sem progresso (padrão K=3), o orquestrador **atualiza o plano** (reordena itens, quebra o item travado, troca o caminho: busca, outra navegação, `expand`), não só cutuca. Contador `replans`; após M replanejamentos (padrão M=2) o run **encerra com entrega parcial honesta**: o que foi feito, o que falta e o motivo real por item (campo estruturado que a UI mostra).
- **Portão de entrega.** `create_file` e a resposta final ficam **bloqueados** enquanto houver itens `pending`/`in_progress` e o orçamento usado estiver **abaixo de 80%**; encaixa no governor A3 de run: acima de 80% o portão libera e a entrega parcial sai declarando os itens abertos. Nunca pedir ao usuário conteúdo alcançável no navegador: `failed` só vale com motivo de classe real (`login`, `captcha`, `permission`, `not_found`). Máx. 3 interceptações por run.
- **Âncora do item pai.** O item pai atual (ex.: a disciplina) fica sempre visível na reinjeção compacta (`Now: item 5 "<label>" (parent: <course>)`), para não se perder ao entrar em semanas/atividades.
- **Delegação.** Itens independentes (ex.: uma disciplina cada) podem ir para subagentes com navegador (V8, em série na mesma sessão). O orquestrador **funde o resultado de cada filho no ledger** (status, `evidence`, `failed(reason)`); filho que falha vira item `failed` com motivo, nunca "sem leitura" genérico para o pai. Sem V8, o guard da V2 vale e o orquestrador lê item a item.

**Arquivos.** `packages/shared/src/task-ledger*.ts` (tipo + reducers puros), `execution/progress-ledger.ts` e `execution/item-gate.ts` (novos, puros), `execution/task-state.ts` (checkpoint), `tools/track-items.ts` (escreve no ledger), registro mínimo em `computer-use.ts`, card de checklist em `apps/web/components/ai-elements/*`.
**Testes.** Unit: `evaluateProgress` (todos done, laço, sem progresso por K, progresso por escopo novo), replanejamento (K, M, parcial honesto), portão (orçamento 79/80/90%, `failed` sem motivo, 3 interceptações), âncora do item pai na reinjeção, merge de resultado de filho. **Replay com LLM mockado do caso "9 semanas de uma disciplina"** (`computer-use.ledger-replay.test.ts`): o modelo tenta `create_file` com 1/9 e é barrado; lê as outras 8; trava na semana 6 e é replanejado; entrega o PDF com 9/9, ou parcial declarando a semana faltante se o bloqueio for real; nenhuma resposta pede conteúdo ao usuário. Cross-user: ledger é do run e herda `userId`.
**Eval.** T3 e T4: sucesso, itens lidos/pedidos = 100% ou bloqueio declarado, pedidos ao usuário = 0.
**Riscos.** Modelo pequeno monta ledger ruim (dica determinística de coleção e `get`); excesso de interceptação (limite 3 + governor); replanejar em laço (teto M).
**Esforço.** M. **Dependências.** V3 (mesma fase); V8 só para a delegação.

---

### V4 — Resultado de ação com "o que mudou" + espera automática

**Problema.** F4, F9. `browser_click({text})` não diz nada além de "Clicou em X"; `browser_act` só diz elementos interativos novos (viewport, 12, ignora refs já vistos), e um aviso falso aparece em 100% das ações.

**Técnica.** Observação de mudança (Agent-E); snapshot fresco a cada ação (Playwright MCP); anexar o estado no último resultado do lote (Anthropic); verificação do passo (Anthropic computer use); lotes que param na primeira falha (OpenAI, Anthropic).

**Desenho.**
- Servidor calcula um **digest de página** antes e depois da ação (`pageDigest()` em `control/page-digest.mjs`): blocos de texto por landmark/heading (hash por bloco), estados `aria-expanded|checked|selected|pressed` por ref, diálogos abertos (`[role=dialog]`, `[aria-modal=true]`), URL/título, foco.
- `diffPageDigest(before, after)` (puro) devolve: `added_text` (<= 1.200 chars, com cabeçalho do bloco), `removed_blocks` (contagem), `state_changes` (`e20 expanded false→true`), `dialog` (título + escopo), `new_refs` (inclui elementos **já vistos que reapareceram**: refs estáveis por `WeakMap`, não só "nunca numerado"), `navigated`.
- **Erros de validação só por diferença**: novos desde o "antes" e restritos a campos/regiões de formulário (`aria-invalid`, `:user-invalid`, `role=alert` **com** texto curto e dentro de `form`). Acaba o falso positivo do banner de acessibilidade.
- **Espera automática:** DOM quieto 300 ms **e** zero requisições `fetch/XHR` pendentes (contador injetado por `addInitScript`) **e** sem `[aria-busy=true]`/spinner visível, teto 3 s; quando passa do teto, `settled:false` + diff parcial.
- Formato do resultado (inglês, enxuto): `Clicked e20 "Week 1". expanded: false→true. Added content (412 chars): "Unit 01 … Activity guide". New: e29 link "…", e31 link "…".` O mesmo contrato para `browser_click(text)` (até a V6 unificar).
- **Lote seguro:** quando o modelo emite várias chamadas de navegador no mesmo turno, o executor para na primeira falha e responde "Not executed: an earlier action in this turn failed." às demais (regra oficial da Anthropic/OpenAI).

**Arquivos.** novo `control/page-digest.mjs` (+ teste), `control/browser-refs.mjs` (act/diff), `control/browser-actions.mjs`, `control/stability.mjs`, `tools/computer-refs.ts` (`formatAct`), `tools/computer.ts` (`verifyActEffect`, `formatSettle`), `computer-use.ts` (regra de parada do lote, mínima).
**Testes.** `diffPageDigest` puro (texto novo, nada novo, reabertura de acordeão, erro preexistente vs novo); `formatAct`; L1: acordeão exclusivo com conteúdo preguiçoso (clique devolve o texto da semana); replay: 9 cliques em lote deixam de perder conteúdo; teste de que o banner `role=alert` não gera aviso.
**Eval.** T2/T3: leituras extras após clique = 0; falso "validation" = 0.
**Riscos.** Tamanho do diff (teto duro 1.200 chars + "use read for the rest"); contador de requisições quebra em páginas com polling (teto 3 s resolve).
**Esforço.** M. **Dependências.** V1 (espera/estabilidade).

---

### V5 — Leitura da página inteira: frames, shadow DOM, expand-all, refs numerados

**Problema.** `browser_text` lê só `document.body.innerText` do frame principal (`text-page.mjs:50`); snapshot só vê iframes same-origin (`browser-refs.mjs:130-139`) e `querySelectorAll` não atravessa shadow DOM; conteúdo de acordeão fechado não existe no `innerText`. Resultado: leitura parcial e releituras por `offset`.

**Técnica.** `read_page`/`get_page_text`/`find` (Anthropic), refs `f1e12` por frame e `browser_find` (Playwright MCP), CDP com iframes/shadow (Stagehand v3), destilação flexível do DOM (Agent-E), poda/merge da observação (AgentOccam).

**Desenho.** Novo endpoint `POST /browser/read` e tool `read` (substitui `browser_text`, `browser_links`, `browser_snapshot`; ver V6):
- `view: "outline"` (padrão): árvore compacta em texto com **headings, landmarks, regiões `[collapsed]`/`[expanded]`, links com href curto e todos os interativos com ref**, em ordem de leitura, **todos os frames** (`page.frames()`; refs prefixados `f2e7`, rótulo `[frame: path]`; frames de outro origin entram marcados `[other-origin host]` e como dado não confiável) e **shadow roots abertos** (percorrer `el.shadowRoot` recursivamente ou `DOM.getFlattenedDocument({pierce:true})`).
- `view: "text"`: texto legível do conteúdo principal + frames + shadow (como `get_page_text`), com paginação `cursor`.
- `find: "<text|regex>"`: só os trechos com contexto (<= 20), sem reler a página (Playwright MCP `browser_find`, Anthropic `find`).
- **`expand: "all" | ["e20", …]`**: expande acordeões/`details`/abas na ordem, **lendo o conteúdo novo depois de cada expansão** (via `diffPageDigest` da V4) e concatenando `seção, conteúdo`; resolve acordeão exclusivo; teto de N seções (padrão 30) e orçamento de chars; respeita "não clicar em ações de escrita" (só controles com `aria-expanded`/`summary`, nunca botões de envio/conclusão).
- **Filtro de boilerplate por host:** linhas que já apareceram em >= 2 páginas do mesmo host no run (banner de acessibilidade, menu) ficam colapsadas em `(site chrome omitted: 6 lines)`. Reduz ruído e tokens.
- Orçamento: 8k chars por chamada (cursor para o resto), 20k com `view:"text"` explícito; sempre informa `total`.
- Regras de segurança: conteúdo de frame/shadow é `UNTRUSTED_PAGE_NOTE`; atributos sensíveis (`type=password`) como hoje.

**Arquivos.** novo `control/read-page.mjs` (+ teste), `control/outline.mjs` (puro: `buildOutline`, `collapseBoilerplate`), `control/server.mjs` (rota), `control/browser-refs.mjs` (`framesOf` com política de origin), `packages/sandbox/src/control-client.ts` + `types.ts`, `tools/computer-read.ts` (novo), formatação em `tools/computer-refs.ts`.
**Testes.** Puros: `buildOutline` (aninhamento, colapsado, limite), `collapseBoilerplate`; L1 no fixture: iframe, shadow DOM, acordeão exclusivo + lazy, 9 semanas em 1 chamada `expand:"all"`; ref `f2e7` resolve no frame certo; frame cross-origin marcado; replay mockado.
**Eval.** T3 (<= 3 chamadas de leitura/expansão para as 9 semanas), T7.
**Riscos.** Páginas gigantes (cursor + teto); `expand` clica em algo indesejado (restrito ao padrão de acordeão, sem links de navegação, sem submit); custo L: é a fase mais longa, entregar em duas partes (5a: outline + frames; 5b: expand + boilerplate).
**Esforço.** L. **Dependências.** V4.

---

### V6 — Vocabulário menor e tools pré-carregadas

**Problema.** 13 tools de navegador/desktop com sobreposição; `mcp_tool_search` gasta a decisão 0 em 4 de 4 runs; descrições e resultados em pt-BR para o modelo.

**Técnica.** Espaço de ação pequeno e alinhado ao que o LLM conhece (AgentOccam +26,6 pontos); trio `act/extract/observe` (Stagehand); set pequeno e uniforme (Playwright MCP, Anthropic browser use).

**Desenho.** Grupo **browser** sempre carregado: `navigate`, `read` (V5), `act`, `find` (parte de `read`), `wait`, `screenshot` (com `zoom`/`marks`, V10) e `extract` (V7). `act` recebe `target: {ref} | {text, role?}` (texto resolvido pela **árvore de acessibilidade/nome acessível**, não por `getByText`) e `action: click|type|select|check|press|scroll|hover|expand`. Grupo **desktop** (`click` x,y, `type`, `key`, `scroll`) só para apps fora do navegador/canvas, carregado sob demanda. Aliases dos nomes antigos por 1 release com log de depreciação e sem aparecer na lista oferecida. Mover as descrições, resultados e dicas de erro para **inglês** (cards e textos que o usuário vê continuam em pt-BR). Pré-carregar (`offeredTools`) o grupo browser quando o bot tem sandbox; remover a necessidade de `mcp_tool_search` para eles.

**Arquivos.** `computer-use.ts` (lista, SANDBOX_TOOL_NAMES, aliases; mudança mínima), novos `tools/browser-act.ts`, `tools/browser-read.ts`, `context/native-tools.ts` e `native-deferral.ts` (grupo pré-carregado), `tools/computer-refs.ts`.
**Testes.** Snapshot da lista de tools oferecida (<= 8 de navegador), aliases funcionam, string-test da regra de prompt, replay do run antigo com nomes antigos. Eval: decisão 0 sem `mcp_tool_search`; mesma taxa de sucesso nos 3 modelos.
**Riscos.** Regressão em runs/skills salvos que citam tools antigas (aliases); prompts de skills em português (varredura).
**Entregue (V6).** Grupo `browser` com 7 tools (8 com `computer` no modo nativo, que troca o `screenshot`): `navigate`, `browser_read` (absorve `browser_text` e `browser_links`), `browser_find`, `browser_snapshot`, `browser_act` (absorve `browser_click`, `browser_type` e `scroll`: sem ref, clica por texto/seletor, digita no campo em foco e rola), `browser_wait`, `screenshot`. Coordenadas (`click`, `type`, `key`, `scroll`) saíram para o grupo `desktop`, carregado só por intenção (desktop, xdotool, arrastar, coordenadas). O grupo `browser` já vai no 1º passo quando o run tem sandbox (`preloadBrowser`), e o índice de tools adiadas não o repete. Aliases: `browser_click`, `browser_type`, `browser_text` e `browser_links` ainda executam (checkpoints, replays, filhos da V8), com aviso de depreciação uma vez por processo, mas não são oferecidos. `P_WEB`, `P_DESKTOP` e as linhas do prompt viraram inglês curto, sem nome de site (hash do prompt atualizado). `browser_read` com menos de 800 caracteres sugere `browser_wait` (SPA ainda hidratando). Revisão do `expandAll` (V5): o critério agora é estrutural (`type=submit`, botão dentro de `form` com action/POST sem `aria-controls`, popup, menu, link para outra página); a lista de nomes de escrita ficou como rede de segurança documentada, sem ampliar, com testes. O harness passou a guardar os argumentos de cada chamada no `trace`.

**Esforço.** M. **Dependências.** V5.

---

### V7 — `extract` com schema sobre a página toda

**Problema.** Listas (semanas, disciplinas, atividades) hoje viram dezenas de `browser_text`/`artifact_read`. O modelo grande gasta contexto para copiar títulos.

**Técnica.** `extract` com schema e escopo (Stagehand), `page_extraction_llm` separado e pequeno (browser-use).

**Desenho.** Tool `extract({ schema, scope?, prompt?, expand? })`: o servidor monta o texto/outline (V5, todos os frames, opcionalmente com `expand:"all"`), chama um **modelo barato** (config `extractionModel`, padrão o modelo de sub-agentes do bot) com o schema e devolve JSON validado (zod, tamanho máx. 8k) com `evidence` por campo; erros do modelo viram `ok:false` com dica. O resultado alimenta `track_items(set)` diretamente (V3). Sem rede além do provedor já configurado; entrada tratada como dado não confiável.

**Arquivos.** novo `tools/extract.ts` (+ teste), reuso de `packages/llm`, `web-extract.ts` como referência de contrato.
**Testes.** LLM mockado: schema inválido, resposta truncada, página vazia, injeção de prompt no texto (ignorada); L2: T3/T4 usando `extract`.
**Riscos.** Alucinação do extrator (exigir `evidence` literal e checar que o trecho aparece no texto fonte); custo (modelo pequeno).
**Esforço.** M. **Dependências.** V5.

---

### V8 — Subagente por item com navegador (condicional)

**Problema.** F10 e crescimento de contexto em listas grandes. Hoje, filhos não navegam.

**Técnica.** Líder + subagentes com contexto limpo e briefing detalhado (Anthropic multiagente); WebSurfer especializado (Magentic-One).

**Desenho.** `delegate_task` ganha `mode: "browser_item"`: executa itens **em série** na **mesma sessão do sandbox** (mesmo perfil logado; lock por sessão), cada filho com contexto novo, grupo browser + `research_note`, entrada = item `{id,label,url_hint,goal,output_schema}`, saída = JSON curto (<= 2 KB) que o pai grava no item via V3. Limites por filho: 12 decisões e 90 s. Herdam `userId` e política de escrita do pai (read-only por padrão no chat). Paralelo entre sessões diferentes fica para depois (custo de VMs).
**Decisão condicional:** só implementar se, depois de V3 a V7, o harness mostrar T4 com contexto > 60% da janela útil ou > 6 disciplinas; caso contrário, manter só o guard da V2.
**Arquivos.** `tools/delegate-task.ts`, lock de sessão em `packages/sandbox`, `computer-use.ts` (mínimo).
**Testes.** Série vs paralelo (lock), cross-user (filho não acessa sessão de outro dono), filho que falha vira item `blocked` com motivo, replay.
**Riscos.** Estado compartilhado do navegador entre filhos (cada filho abre a própria aba e fecha ao fim); 15x de tokens dos multiagentes.
**Esforço.** M/L. **Dependências.** V3, V6.

**Entregue (V8), atrás da flag `ATLAS_BROWSER_SUBAGENTS` (padrão desligada).** Desenho final: abas, não série. O control server ganhou abas extras no mesmo contexto do Chrome (mesmos cookies e login): `POST /browser/tab/open|close` e o cabeçalho `x-atlas-tab` leva qualquer ação de browser à aba (AsyncLocalStorage em `browser-tabs.mjs`); a aba do pai segue ativa e intocada; teto de 6 abas no servidor e abas esquecidas (> 10 min) são fechadas. `SandboxExecutionContext.tabId` leva o id até o control client. `delegate_task` com `mode: "browser_item"` (tarefa = `item` do ledger + `url` + `goal`): vaga no limitador do run (3 abas, somando chamadas), aba aberta na url, filho com as tools do DOM dessa aba (navigate, browser_text/read/find/links/snapshot/act/wait/click/type; sem screenshot nem coordenada), prompt com seção de navegador, 12/15 passos e 90 s, relatório <= 2 KB (detalhes em `research_note`), aba fechada sempre (sucesso, falha, cancelamento). O resultado entra no ledger do pai: `done` com evidência, ou `failed` com motivo `subagent` (só o runtime grava) e a causa; o pai é mandado reler os falhos. Guarda 2 da V2 mantida (filho com todas as tools falhadas = falha). O bloqueio da V2 só vale fora do modo. Custo e tokens dos filhos somam no pai. O cursor (`agent_pointer`) **não** mostra ações dos filhos (a aba deles não está na tela da VM).

**Decisão (harness, haiku-5.5, imagem com abas, vm/upgrade pós-V5).** Sem delegação, T4 e T3 já passam: T4 4/4 (5 a 13 decisões, 33 a 82 s, ~US$ 0,003), T3 3/3 (4 a 5 decisões, 20 a 25 s). Com a flag ligada e o modelo livre, ele não delegou (T4 2/2, 24 decisões, 83 a 86 s; T3 2/2). Forçando a delegação no pedido: T4 3/3 em 2 decisões do pai mas 47 a 50 s e ~US$ 0,0035; T3 3/3, 21 a 57 s. Ou seja, sem ganho de sucesso, tempo nem custo no fixture (contexto do pai não chega perto da janela). Por isso a flag fica **desligada**; reavaliar se o harness mostrar T4 com contexto > 60% da janela ou > 6 disciplinas.

---

### V9 — Memória de navegação por bot

**Problema.** Todo run reaprende o site: onde ficam as favoritas, que o card usa link-overlay, que as semanas são acordeões lazy, qual botão do banner recusa.

**Técnica.** Memória de rotinas por site (Agent Workflow Memory: +24,6% Mind2Web, +51,1% WebArena relativos, menos passos); cache de ação com fallback para inferência (Stagehand).

**Desenho.** Registros em `memory_entries` com `category: "site_nav"`, escopo `(userId, botId)`, `source: "run:<id>"`, `validUntil` +60 dias, `importance` baixa. Conteúdo textual compacto e **sem segredos** (caminhos com `{id}` no lugar de números, rótulos de botão, "banner: use 'reject' button", "course page: weeks are accordions; use expand"). Escrita no fim de um run bem-sucedido por função pura `extractSiteNav(trajectory)` (hosts visitados, padrões de URL que levaram a leitura, degrau de clique que funcionou, banners dispensados) + validação de tamanho; leitura por host: na primeira `navigate`/`read` de um host, injeta <= 500 chars ("Known about this site"). Estágio 2: **cache de ação** `(host, path-template, intent)` → `{role,name}` do alvo, reaproveitado como `target` do `act`, com fallback ao fluxo normal se não resolver.
**Dependência de outra frente:** memória do bot está sendo adicionada por outro agente (memória/onboarding). Esta fase só começa depois que o contrato de `memory-entries` (escopo por bot) estiver estável; **não** criar tabela nova.
**Arquivos.** novo `src/memory/site-nav.ts` (puro) + integração fina; `packages/db/src/memory-entries.ts` (função de leitura por host com `userId`+`botId`).
**Testes.** Puro: normalização de caminhos, remoção de query/token; **IDOR:** bot/usuário B não vê memória de navegação do A; run T1 repetido tem menos passos com memória (eval); memória nunca contém cookie/token/credencial (teste de regex em fixtures).
**Riscos.** Memória errada persistente (TTL curto, `confidence`, ignorar se o degrau falha 2 vezes e então apagar); privacidade (só caminhos).
**Esforço.** M. **Dependências.** V6 + memória do bot.

---

### V10 — Visão só quando precisa

**Problema.** Screenshots custam 1.000 a 1.800 tokens cada; modo coordenada gerou 97 decisões cegas no run Sheets. Em contrapartida, canvas, gráficos e iframes cross-origin exigem pixel.

**Técnica.** `use_vision: auto` (browser-use); ler a árvore antes de screenshot, `zoom` para detalhe (Anthropic); set-of-marks (Magentic-One, SoM); navegador de texto vs visual (ChatGPT agent).

**Desenho.** Política determinística (função pura `shouldSuggestVision(readResult, history)`): sugerir `screenshot` no resultado quando (a) `read` devolve < 40 chars de texto e há `canvas`/frame cross-origin/`img` sem nome; (b) 2 `act` seguidos falharam no mesmo alvo; (c) `find` não acha um rótulo que o usuário citou. Nenhum screenshot automático. `screenshot` ganha `zoom` real (região) e `marks` reutilizando `marks.mjs`; histórico de imagens continua podado em lote (manter as 3 últimas, como a doc da Anthropic recomenda para cache).
**Arquivos.** `tools/vision-policy.ts` (novo, puro), `control/marks.mjs`, `screenshot-options.mjs`.
**Testes.** Puro: política; L1 canvas do fixture (T10: exige 1 screenshot e acerta); T1 a T9 com <= 1 screenshot em média.
**Riscos.** Sugerir visão demais (limiares conservadores).
**Esforço.** S/M. **Dependências.** V5.

---

## 8. Riscos transversais e mitigação

| Risco | Mitigação |
|---|---|
| Regressão em sites que hoje funcionam | Flags por fase; eval com T1 a T10 antes de ligar; manter aliases (V6) |
| Fixture não representar o mundo real | Padrões copiados de sites reais sanitizados; replay de runs reais; revisão a cada fase com 1 site real manual |
| Aumento de latência por digest/expand | Orçamentos duros (1.200 chars de diff, 3 s de espera, 30 seções) e métrica de tempo por tool no harness |
| Prompt injection via conteúdo expandido/frames | Tudo é `UNTRUSTED_PAGE_NOTE`; T9 no harness; `expand` nunca clica em ação de escrita |
| Mexer em `computer-use.ts` (6k linhas) | Módulos novos; mudanças ali só de registro/fio |
| Imagem do sandbox desatualizada | `image-staleness.ts` + rebuild documentado em cada fase que toca `control/` |
| Ações destrutivas em sites logados | Read-only por padrão no chat; confirmação para `confirmWrites`; auto-dismiss de banner só recusa/fecha |

---

## 9. Textos para o modelo (inglês neutro, sem nomes de site ou produto)

Rascunhos para os módulos; cada regra nova deve vir com teste de string (regra `60-agente.md`).

```text
# track_items (description)
Keep a checklist for work that repeats over several similar things (sections, pages, rows,
records). USE WHEN the task covers 3 or more similar items, or the user says "all"/"each".
DO NOT USE for a single lookup. set: write the list from what you saw on the page. update:
mark an item done with a short piece of evidence (what you read), or blocked with the real
reason (login, captcha, permission, not found). Finish only when no item is todo or doing.

# gate G1 / G2 (injected note when items are open and budget remains)
N items are still open: <labels>. Continue with the next open item using your page tools.
Content that is visible in the browser is yours to read; do not ask the user to paste it.
Deliver or answer only when every item is done or blocked for a real reason.

# per-turn anchor (ephemeral, <= 600 chars)
Items: 4/9 done. Now: item 5 "<label>" (scope: <context>). Open: <labels>.

# read (description, short)
Read the current page as text with numbered refs, across frames and shadow roots.
view=outline (default): headings, collapsed/expanded regions, interactive refs.
view=text: readable content. find: only matching lines with context.
expand=all: open every collapsed section in order and return each section's content.
Use before act. Use screenshot only for canvas, charts or when text is missing.

# act result (format)
Clicked e20 "Section 1". expanded: false -> true. Added content (412 chars): "...". New: e29 link "...".

# click failure (<= 300 chars)
Click on "<label>" was blocked by <element>. Tried: overlay, banner, script click. Use act on ref eN from read.

# collection hint (appended to read when a repeated structure is detected)
This looks like a list of N similar items. Consider track_items to go through them one by one.

# delegation guard
Sub-agents cannot browse. Read it yourself with the page tools, one item at a time.

# task ledger (set at the start of multi-item tasks; re-injected compactly each step)
Task ledger. Given: <facts from the user>. To look up: <facts still unknown>.
Plan: <up to 8 short steps>. Items (pending / in_progress / done / failed(reason)):
<id> <label> [parent: <context>] <status>. Update an item as soon as you read it.

# progress check (each step, deterministic first)
Is the request satisfied? Are you repeating the same action? Did the last step add new
content or finish an item? Next item or action: <...>. Can an independent item go to a
browser subagent?

# replan on stagnation (after K steps without progress)
No progress in the last K steps. Update the plan: reorder or split the stuck item, or try
a different route (search, another page, expand sections). Do not repeat the same action.

# stop after M replans (honest partial)
Stopping with a partial result. Done: <items>. Missing: <items and the real reason each>.
State this plainly in the answer. Do not ask the user for content you can reach yourself.

# parent anchor (always visible, ephemeral)
Now: item 5 "<label>" (parent: <context>). Done 4/9.

# delegation (browser subagent for one independent item)
Read item "<label>" at <url_hint> in the shared session. Return JSON: status, evidence
(<= 200 chars), and a real reason if it failed. Do not leave the item page.
```

---

## 10. Fora de escopo / depois

- Rodar vários navegadores em paralelo (várias VMs) para leitura em paralelo de itens (custo e orquestração de sessões).
- Ranqueador treinado de candidatos estilo Mind2Web (T16): só se o `read` ficar grande demais mesmo após poda determinística.
- Treinar/afinar modelo próprio de ação; visão especializada (OmniParser etc.).
- Login automatizado com credenciais (hoje: handoff ao usuário via card de login, mantido; os dados do usuário não passam pelo modelo).
- Navegador de texto separado sem Chromium (como o text browser do ChatGPT agent): avaliar depois que `read` estiver estável.
- Mudanças no preview/viewer/cursor do agente (`agent_pointer`, noVNC): já entregues, não tocar.
- Reescrita do `computer-use.ts`.
- Pesquisa adicional pendente: Project Mariner (fonte primária não levantada), artigos OSWorld/WebVoyager (links não abertos), post original de engenharia da Anthropic sobre multiagentes (lido via resumos).

---

## 11. Resultados (preencher pelo orquestrador a cada fase)

| Fase | Modelo | T3 sucesso | Decisões T3 | Tempo T3 | Tokens prompt T4 | Cliques > 3 s | Observações |
|---|---|---|---|---|---|---|---|
| Baseline (V0) | haiku-5.5 | 0/3 (itens: 3/9, 2/9 e 0/9) | 29 a 39 (mediana 33) | 87 a 121 s (mediana 94 s) | 508k a 735k em T3 (T4 não rodou) | 0 (o fixture não reproduz o timeout de 15 s; os cliques por ref funcionaram) | Sem PDF em 3 de 3 (leu as semanas uma a uma e terminou sem `create_file`: mesma falha do Bob). 3 a 18 dicas do runtime por run. T1, T2, T5, T7, T10: 2/2 cada (T1 2 dec./4 s; T5 8 a 10 dec.; T7 13 a 17 dec., 26 a 44 s; T10 3 dec., 6,5 s). Custo total ~US$ 0,10 |
| Baseline (V0) | mimo-v2.6-flash | 0/2 | 40 (teto de passos) | 198 a 210 s | 465k a 485k em T3 | 0 | Estourou os 40 passos nos dois runs, 0/9 itens. T1 2/2 (3 a 6 dec., 27 a 43 s). Custo ~US$ 0,015 |
| Baseline (V0) | deepseek-v4.1-flash | 0/2 | 40 (teto de passos) | 119 a 122 s | 455k a 505k em T3 | 0 | Estourou os 40 passos nos dois runs, 0/9 itens. T1 2/2 (3 a 4 dec., 6 a 7 s). Custo ~US$ 0,03 |
| V8 (delegação) | haiku-5.5 | off 3/3; on 2/2 (forçada 3/3) | 4 a 5 (pai) | off 20 a 25 s; forçada 21 a 57 s | T4 off ~340k; forçada menor no pai | 0 | Delegação não ajuda no fixture (ver V8). Flag desligada. |
| V6 (vocabulário) | haiku-5.5 (2 reps; antes → depois) | 19/20 → 19/20 (T4 1/2 → 1/2: um run estoura os 40 passos nos dois) | T3: 4 → 4 | T3: 20 s → 20 s | n/d (T4 ~140 s → ~200 s no run que estoura) | 0 | Menos decisões em T5 (14 → 12), T7 (5 → 3), T8 (5 → 4); mais em T9 (5 → 12, 22 s → 53 s: lê, abre a semana por `act` e relê) e T10 (3 → 5). Custo por run igual (< US$ 0,004; total da rodada US$ 0,10). `mcp_tool_search` na decisão 0: nenhum. |
| V6 (vocabulário) | mimo-v2.6-flash (2 reps; antes → depois) | T1..T3, T5..T8, T10 2/2 → 2/2; T4 1/2 → 0/2; T9 2/2 → 0/2 | T3: 11/4 → 5/5 | T3: 69 a 176 s → 52 a 76 s | n/d | 0 | T3, T5, T7, T8 e T10 mais rápidos (menos decisões). T9 é a regressão: 6/6 antes (3 a 24 decisões) e 3/7 depois; o filho lê a semana 5 certo (`expandAll`/`expandRefs` funcionam, verificado direto no sandbox) e passa a procurar mais profundidade nos itens até estourar os 40 passos. Com a dica de espera no `browser_read`, 3/4. Modelo barato e ruidoso, n pequeno; rodadas antes/depois de mimo se sobrepuseram no tempo (parede com ruído). |
| V1 … | | | | | | | |

---

## 12. Referências

- OpenAI: [Computer-Using Agent](https://openai.com/index/computer-using-agent/), [guia de computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [ChatGPT agent (cobertura)](https://siliconangle.com/2025/07/17/openai-rolls-chatgpt-agent-automate-multistep-browser-tasks/), [arquitetura do Atlas](https://blog.bytebytego.com/p/the-architecture-behind-atlas-openais).
- Anthropic: [computer use tool](https://platform.claude.com/docs/agents-and-tools/tool-use/computer-use-tool), [browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), [Claude for Chrome](https://www.anthropic.com/news/claude-for-chrome), [sistema multiagente de pesquisa (resumo)](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent).
- Google: [Gemini computer use](https://ai.google.dev/gemini-api/docs/computer-use).
- Microsoft: [Magentic-One](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/), [Playwright MCP snapshots](https://playwright.dev/mcp/snapshots), [repo](https://github.com/microsoft/playwright-mcp).
- browser-use: [repo](https://github.com/browser-use/browser-use), [parâmetros](https://docs.browser-use.com/customize/agent/all-parameters), [relatório técnico](https://browser-use.com/posts/sota-technical-report).
- Stagehand/Browserbase: [cache](https://docs.stagehand.dev/v4/best-practices/caching), [blog de cache](https://browserbase.com/blog/stagehand-caching), [extract](https://docs.stagehand.dev/v3/basics/extract).
- Skyvern: [Skyvern 2.0](https://www.skyvern.com/blog/skyvern-2-0-webvoyager-benchmark-results/).
- Comet: [análise de terceiros](https://www.harness.io/blog/reverse-engineering-comet) (sem fonte oficial). Grok: sem documentação pública do navegador.
- Papers: [WebArena](https://arxiv.org/abs/2307.13854), [Mind2Web](https://arxiv.org/abs/2306.06070), [Set-of-Mark](https://arxiv.org/abs/2310.11441), [AgentOccam](https://arxiv.org/abs/2410.13825), [Agent-E](https://arxiv.org/abs/2407.13032), [Agent Workflow Memory](https://arxiv.org/abs/2409.07429), OSWorld (arXiv 2404.07972) e WebVoyager (arXiv 2401.13919) citados de memória, não abertos nesta rodada.
- Internos: `PLANO-RUN-V2.md`, `.agents/rules/*`, `docker/agent-sandbox/control/*`, `packages/agent-runtime/src/tools/*`.
