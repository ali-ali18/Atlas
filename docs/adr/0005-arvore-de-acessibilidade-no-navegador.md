# ADR 0005: o bot lê e age na página pela árvore de acessibilidade, com refs

- **Status:** aceito (prioridade do dono: "ler a página pela árvore de acessibilidade, como o Playwright MCP e o browser-use")
- **Data:** 2026-11-03

## Contexto

`browser_snapshot` (v1) e `browser_read` varriam o DOM por conta própria: um coletor de elementos interativos com teto (`READ_MAX_REFS` 800, 12 mil nós) e refs `data-atlas-ref`. Em páginas grandes isso falha de formas previsíveis, medidas numa fixture com iframe de outro site, shadow DOM, `aria-hidden`, painel lateral (`aside`) e milhares de comentários:

- com ~1.250 comentários o botão do painel lateral ficava sem ref (o teto de refs acabava antes dele);
- com ~3.750 comentários (caso YouTube, 15 mil nós) o teto de nós cortava a leitura antes de chegar ao painel que tinha a resposta;
- o DOM não diz o que é clicável de verdade (papel, nome acessível, estado), então a heurística errava nome e papel de componentes custom;
- ref `data-atlas-ref` morre quando o framework recria o elemento, e a ação seguinte esperava o timeout inteiro (10 s) para falhar.

O Playwright (>= 1.63) expõe `page.ariaSnapshot({ mode: "ai", boxes: true })`: a árvore de acessibilidade do Chromium em YAML, com `ref` por elemento (inclusive iframes de outro site e shadow DOM) e caixa. É o que o Playwright MCP e o browser-use usam.

## Decisão

- `browser_snapshot` passa a devolver a **árvore de acessibilidade podada**, e `browser_act` age pela **ref** dela (`aria-ref=eN`). É o caminho principal; a flag `ATLAS_AX_SNAPSHOT` vem **ligada**, e `off` (ou `0`, `false`, `dom`) volta ao v1 inteiro.
- **Captura** (`docker/agent-sandbox/control/ax-snapshot.mjs`): `ariaSnapshot({mode:"ai", boxes:true})` com detecção de recurso; `_snapshotForAI` como segunda opção (sem caixas); sem nenhum dos dois ou passando de **4 s**, cai no v1 com uma nota. `playwright-core` fixado em `~1.64.1`.
- **Poda** (`ax-prune.mjs`, puro): achata `generic` sem nome, junta textos, põe `/url` como `[href=…]`, corta nomes em ~200, colapsa irmãos repetidos (2 exemplos + `… +N article similares (eA..eB) — browser_snapshot ref=eX`; limiar 5 para item composto e 10 para folha simples, para não esconder um menu de 6 links).
- **Chunk 1 = o que cruza a janela** (a caixa do iframe é somada em cadeia) mais um rodapé do que ficou de fora. O resto pagina por **caracteres** (`offset`/`limit`, padrão 6000, máximo 20000); `ref=eN` mostra os filhos de um bloco colapsado. `view:"list"` e `scope` continuam no snapshot v1.
- **Sonda de recorte** (`browser-ax.mjs`) só nos nós do chunk emitido: a árvore não respeita `overflow:hidden` nem `left:-9999px`, então um `checkVisibility` + ancestrais cortantes + caixa fora do documento esconde acordeão fechado e o que está fora da tela; `aria-hidden` ganha rótulo.
- **Refs** (`ax-refs.mjs`): tabela por snapshot (`ref → {frame, papel, nome, ordinal, âncora}`). Na ação: `aria-ref` com `count()` curto (~50 ms); se a ref venceu, `getByRole(papel, {name, exact})` nos frames. Um achado: age e avisa em `note`. Vários: erro rápido com as candidatas ("perto de …"), sem adivinhar. `read`/`find` entregam refs do DOM: depois deles a aba resolve pelo DOM (e, se a ref não existir lá, pela última árvore).
- **Diff depois da ação** (`ax-diff.mjs`, puro): só quando o digest viu mudança; nova árvore, chave = ref, ignora `[active]`, na árvore SEM colapso, no máximo 25 linhas, em `changes.tree`.
- **Sem tool nova** (o grupo do navegador está no limite): `browser_snapshot` ganha `view`, `ref`, e `offset`/`limit` em caracteres. As descrições encolheram: o prefixo de "Bom dia" ficou em 40.415 chars (era 40.429; teto 40.500).
- **Segurança:** o valor de um campo só aparece se a sonda provar que não é senha nem código de uso único (campo sem sonda = sem valor; o render é fail-closed). `UNTRUSTED_PAGE_NOTE` e `redactSecrets` no resultado. `lines[]` segue preenchido com o formato do v1, porque o muro de login e `readLoginFields` leem dele.

## Alternativas descartadas

- **CDP `Accessibility.getFullAXTree`:** 5 a 15 MB por página grande, sem refs acionáveis e sem a poda do Playwright.
- **Aumentar os tetos do coletor de DOM:** adia o corte; a ordem do documento continua errada para painéis laterais e o papel/nome continuam heurísticos.
- **Tool nova (`browser_tree`):** o catálogo do navegador está no limite de contexto e o "Bom dia" tem só ~70 chars de folga.
- **Árvore completa sempre:** 350 mil a 1 milhão de caracteres brutos (~1,6 mil podados com comentários colapsados); o modelo precisa do que está na tela, não de tudo.

## Consequências

- O modelo enxerga painel lateral, iframe de outro site e shadow DOM no primeiro chunk (< 2.000 caracteres nas fixtures) e age pela ref sem tentar de novo.
- Custo de tempo: a captura domina (nesta máquina ~1 s para ~6 mil elementos e ~1,8 s para ~17 mil; 60 mil nós passam de 4 s e caem no v1). Poda + render: dezenas de ms. Ver `docs/features/motor-v2.md`.
- **Riscos:** (1) ref reaproveitada pelo framework para outro conteúdo é tratada como válida (a ação mostra o diff, que denuncia); (2) `read`/`find` trocam o espaço de refs da aba para o DOM; (3) imagem do sandbox antiga não tem o recurso: cai no v1 sem ruído; (4) imagem nova com agente antigo: o agente antigo ignora `tree` e lê `lines[]` (o v1 do ponto de vista dele ainda funciona).
- Deploy: a imagem do sandbox faz `npm install` sem lockfile; o `~1.64.1` entra no próximo build da imagem. Nada a migrar no banco.
