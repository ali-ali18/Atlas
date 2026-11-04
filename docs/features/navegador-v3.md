# Navegador do motor v3 (4 tools)

- **Status:** em andamento (atrás da flag `engine: "v3"`)
- **Data:** 2026-11-04
- **Issues/PRs:** harness v3, PR6

## O que é
O bot passa a usar o navegador da VM com quatro ferramentas simples (abrir, ver, agir, abas) em vez de uma dúzia, e cada resposta diz em que estado a página está (carregando, pedindo login, aviso de cookies, verificação humana, erro ou normal).

## Problema
Hoje o modelo recebe ~12 tools de navegador (`navigate`, `browser_snapshot`, `browser_read`, `browser_find`, `browser_act`, `browser_wait`, `screenshot`, `click`, `type`, `key`, `scroll`, `browser_tabs`), ~8 mil caracteres de schema só para isso. Modelo fraco escolhe a errada, e esconder parte delas deu o incidente "Tool click was not loaded". Cada ação é uma chamada: formulário de 4 campos = 5 a 6 idas ao modelo.

## Por que existe
Desenho do harness v3 (seção 5): `browser_navigate`, `browser_snapshot(view: tree|text|find|screenshot)`, `browser_act(actions[])` e `browser_tabs`, wrapper sobre os MESMOS endpoints da VM (a imagem atual funciona). Lote de até 10 ações por ref corta passos; `page_state` calculado de forma determinística (sem LLM) tira do modelo a adivinhação de "isto é um muro de login?".

## Alternativas descartadas
- Adotar o Browser Use (Python, laço próprio, nuvem paga): o laço do Atlas é próprio (D1) e a VM já tem árvore de acessibilidade com refs. Só estudamos o serializador de DOM.
- Trocar o motor de refs `aN` por índices do DOM: o `aN` (ADR 0005) resolve por papel e nome, sobrevive a re-render e é testado por incidentes.
- Ler o `page_state` pelo LLM (juiz do OpenClaw): custo por passo e não determinístico.

## Como funciona
- `packages/agent-runtime/src/tools/browser-v3/`: as 4 tools (`defineTool`), `page-state.ts` (cálculo no runtime para VM antiga), `ref-memory.ts` (campos de senha/código do último snapshot, fail-closed). O v3 troca as tools de navegador de hoje por estas no PREPARE (`swapBrowserTools`) e executa os handlers delas por um mapa próprio do run (os nomes `browser_snapshot`/`browser_act`/`browser_tabs` seguem no registro global do v1/v2, que não muda).
- VM (`docker/agent-sandbox/control/`): `page-state.mjs` acrescenta `pageState` a `/navigate`, `/browser/snapshot` e `/browser/act` (aditivo); `upload-path.mjs` valida o caminho da ação `upload`.
- `browser_act`: valida o lote inteiro antes de rodar; para na primeira falha dizendo o que rodou e o que não; timeout = "a ação pode ter acontecido, inspecione antes de repetir"; campo de senha/código recusa texto do modelo; `wait` é uma ação do lote (esperar a resposta de um chat antes de ler).
- `page_state` ∈ `loading | login_wall | consent | challenge | error | ok`, por sinais do DOM: senha/código visível, iframe de captcha visível, status HTTP, `readyState`/`aria-busy`/`progressbar`, diálogo de cookies sobre a página. Só aparece para o modelo quando não é `ok`.
- Screenshot sozinho só por sinal estrutural (árvore vazia ou `challenge`), no máximo um por passo e nunca em tela de login.

### O que se aproveitou do serializador do Browser Use (MIT, estudado, nada copiado como código)
- **Copiado como ideia:** visibilidade por caixa real (área > 0, `visibility`/`display`) na detecção de senha, consentimento e ocupado; percorrer shadow DOM aberto; iframes pelo URL (captcha) em vez de entrar no frame de outra origem; deixar `<input type=file>` oculto contar como alvo (aqui, no `upload`); campo de senha sem valor.
- **Já tínhamos, melhor para nós:** poda da árvore (`ax-prune`), "+N similares", refs estáveis por papel e nome, diff pós-ação, marca de elemento novo.
- **Não copiado:** índice numérico por `backend_node_id` (quebra em re-render, Atlas usa `aN`); heurística de "clicável" por `cursor: pointer`, listeners JS e elemento de ícone 10-50px (a árvore de acessibilidade já diz o que é acionável e a `screenshot` com marcas cobre ícone sem nome); remoção por ordem de pintura (`PaintOrderRemover`) e por contenção de caixa (0,99): custo alto em CDP e a sonda de recorte do Atlas cobre o mesmo caso; atributo `data-browser-use-exclude`.

## Segurança de senha e envio de arquivo
- Barreira na VM (`secret-field.mjs`): `type`, `select` e `press` resolvem o alvo EFETIVO (label → controle associado, descendente de label → controle) e recusam senha/código; recusam alvo que não aceita texto; `press` só em alvo de entrada que de fato recebe o foco, e o `activeElement` profundo (shadow DOM e iframes legíveis) é conferido antes e depois de focar; checagem de novo logo antes do Enter do `submit` e depois da ação (campo que virou senha tem o valor apagado).
- Upload (`upload-path.mjs`): `O_NOFOLLOW|O_NONBLOCK`, caminho real do descritor (`/proc/self/fd`) conferido contra `/home/atlas/work`, `fstat` regular, leitura em laço até 25 MB; o navegador recebe o conteúdo.
- Limitação: no runtime, em VM antiga sem a barreira, "ref visto" vem de texto de snapshot e uma página pode forjá-lo; atualizar a imagem fecha isso.

## Riscos
- Contrato SSE: só nomes de tool novos nos eventos `tool_call`/`tool_result` (teste em `engine-v3/browser.test.ts` passa o stream pelo `parseSseBlock`).
- v1/v2 intocados: o registro global e o catálogo deles não mudam; `browser_navigate` é a única tool nova no metadado global (efeito `read`).
- Imagem antiga da VM: sem `pageState` (o runtime calcula) e sem `upload` (a VM responde "action inválida"; o modelo recebe o erro).
- `upload` envia arquivo do modelo a um site: caminho restrito a `/home/atlas/work`, sem oculto/link que saia, 25 MB.
- Conversa v3 já em andamento com núcleo congelado de antes do PR6 (só dev): nomes antigos somem do catálogo; o `tool_call` com nome antigo volta "Unknown tool" com sugestões.

## Custo
Schema do navegador: 12 tools / 8.018 caracteres (6 no núcleo = 4.850) → 4 tools / 4.755 caracteres. Bench (roteiro, 8 tarefas): tokens de entrada 111.884 → 63.572, passos do modelo 47 → 41, chamadas de tool 39 → 33 (8/8 tarefas nos dois). Números do modelo real: ver o relatório do bench.

## Como testar
`pnpm --filter @workspace/agent-runtime test` (tools, lote, timeout, fail-closed, contrato SSE), `node --test docker/agent-sandbox/control/page-state.test.mjs docker/agent-sandbox/control/upload-path.test.mjs`, e o bench: `pnpm --filter @workspace/evals run eval -- navegador` (ver README do pacote).
