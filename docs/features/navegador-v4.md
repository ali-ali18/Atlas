# Navegador no Motor v4 (capacidade `browser`)

- **Status:** em andamento (F8.1 e F8.1a entregues na frente B; falta a ponte real da VM, da frente A, e a rodada real do `browser-bench`, que depende do ok do dono)
- **Data:** 2026-11-09
- **Issues/PRs:** #165 (mãe), #167 (frente B)

## O que é
O bot abre uma página na VM do dono, vê o mapa dela (seções e o tamanho de cada lista) e lê só o que precisa, em partes, sem nunca receber uma lista de mil itens de uma vez e sem perder nada em silêncio.

## Problema
Um vídeo com 1.000 comentários, um feed infinito, uma tabela enorme. Ou o bot recebe tudo e a janela estoura (ou a leitura corta escondido e ele responde com 40 de 1.000 como se fosse o todo), ou ele não vê nada. Decisão do dono (05/11): **ver a página inteira, nunca enxugar escondido**.

## Por que existe
Mapa primeiro, partes sob demanda, busca na VM, carregar mais explícito e volume grande lido por ajudantes dão ao bot a página inteira com a janela leve. O princípio é o da árvore de acessibilidade com refs (ADR 0005, o mesmo do `agent-browser` da Vercel Labs e do Playwright MCP).

## Alternativas descartadas
- **Mandar a página inteira ao modelo:** a lista de 1.000 comentários do teste passa de 24 mil tokens; a janela e o custo não aguentam, e páginas maiores nem cabem.
- **Cortar a lista e avisar "resumido":** é o que o dono proibiu. Toda parte aqui diz onde está e quanto falta.
- **Resumir na VM com regras fixas:** esconde o que a pergunta pode precisar. O resumo é feito por ajudante, com a pergunta na mão.
- **Adotar o `agent-browser` sem medir:** a escolha sai do `browser-bench`, pelo que acerta mais (ver "Custo").

## Como funciona

### Tools (uma por arquivo em `packages/agent/src/capabilities/browser/`)
| Tool | Para quê | Efeito |
|---|---|---|
| `browser_open` | abre uma URL pública | `read` (`egress`) |
| `browser_map` | seções + tamanho de cada lista ("comentários: ~1.000, 40 carregados") | `read` |
| `browser_read` | uma parte numerada (`from`, `count`, `itemChars`), com refs; diz onde está e quanto falta | `read` |
| `browser_find` | busca na VM sobre tudo o que está carregado; devolve trechos com ref e o total de batidas | `read` |
| `browser_load_more` | clica "ver mais" ou rola o feed; diz quantos já estão carregados e se acabou | `read` |
| `browser_export` | salva a seção inteira num arquivo da VM (`/home/atlas/work/exports/`), carregando tudo se pedido | `read` |
| `browser_digest` | exporta e dá o arquivo, em blocos, a ajudantes com memória própria; volta só o que a pergunta pede, por número | `read` |
| `browser_act` | clica, digita, marca, escolhe numa ref | `read` ou `write_external` pelo `intent` |
| `browser_wait`, `browser_tabs` | espera uma condição; lista, troca e fecha abas | `read` |
| `browser_screenshot` | captura + modelo de visão, só se a árvore é pobre ou o pedido é visual | `read` |

Todas declaram `trust: "untrusted"`, `source: "web"`: o texto da página é dado, nunca instrução, e vira taint do run.

### Protocolo com a VM (`kind`s da porta `Sandbox`)
Definido em `protocol.ts` (zod; o mesmo formato nos três lados): `browser.open`, `browser.map`, `browser.read`, `browser.find`, `browser.act`, `browser.load_more`, `browser.wait`, `browser.tabs`, `browser.screenshot`, `browser.export`. Itens numerados de 1 em diante, na ordem em que a página os tem carregados.

- Control server (`docker/agent-sandbox/control/`): `POST /browser/v4` com `{ kind, params }` → `browser-v4.mjs` (despacho), `browser-map.mjs`, `browser-chunks.mjs`, `browser-search.mjs`, `browser-act-guard.mjs` e `browser-inpage.mjs` (roda dentro da página). Reaproveita `browser-refs` (refs e `browserAct`), `browser-session` (abas) e `browser-actions` (navegação).
- Worker: `apps/worker/src/v4-adapters/browser-actions.ts` valida cada kind (campo desconhecido falha, URL pública, ids de seção/ref/export), escopa pelo `userId` do run e traduz a resposta. **O adaptador `Sandbox` (frente A, `v4-adapters/sandbox.ts`) registra estes handlers por kind**; a integração também passa `browser: true` ao preset quando a VM real existir. O bloqueio de SSRF de verdade (DNS, IP privado, redirecionamento) fica no adaptador e na VM da frente A; aqui há só a defesa em profundidade (`checkPublicHttpUrl`).

### Leitura da página
- **Seções:** o mapa acha as listas pelo que se repete (filhos com a mesma estrutura), as tabelas, os formulários, os controles soltos e o texto que sobra. O total vem do que a **página declara** (cabeçalho "1.000 comentários", `aria-rowcount`/`aria-setsize`); se a página não diz, o mapa diz "não informa o total".
- **Carregar mais:** botão com nome de "ver mais" no escopo da lista; senão, rolagem. O resultado traz antes, depois e `reachedEnd`.
- **Partes:** até 200 itens e 24.000 caracteres por parte (a janela de leitura, não economia). Item maior que `itemChars` diz quantos caracteres ficaram de fora. A parte que enche a janela termina antes e diz de onde seguir.
- **Busca:** todas as palavras, sem acento nem caixa, em todos os itens carregados; o total vem sempre, os trechos até `limit`.
- **Arquivo + ajudantes (`browser_digest`):** a seção vai inteira para um arquivo da VM; cada bloco de leitura vai a um ajudante (porta `Helpers`, sem ferramentas) com o conteúdo como dado não confiável; a mãe recebe só o que cada bloco achou, por número, e a linha "todos os itens (1-1000) foram lidos" ou onde continuar. Bloco que falha aparece como NOT READ.
- **Visão:** `browser_screenshot` manda a imagem ao papel `vision` com uma pergunta; só texto volta ao bot principal.

### Segurança e efeitos
- **Navegar e ler = `read`.** URLs passam por `checkPublicHttpUrl` (e de novo no worker).
- **Clicar e digitar:** o modelo declara `intent: "browse" | "submit"`. `browse` (abrir, expandir, trocar de aba, paginar, preencher sem enviar) é `read`. `submit` (enviar formulário, postar, comprar, assinar, apagar no site) é `write_external` e exige `what` (uma frase, mostrada ao dono no cartão). Como o run leu conteúdo não confiável, o `decide` pede o dono; **sem dono (agenda), a ação some**; no run de agenda a capacidade nem tem `browser_act`.
- **A VM confere o contrário, pela estrutura (nunca pelo texto):** botão que envia um formulário que escreve (`action` ou `POST`) declarado como `browse` é recusado com o código `SUBMIT_INTENT_REQUIRED`; Enter num campo desse formulário também. Botão de JavaScript sem formulário não tem sinal estrutural: vale o `intent` declarado (limite conhecido).
- **Senha, código de uso único e captcha:** o bot não digita nem vê o valor. A VM devolve `needsOwner` e a tool manda pedir ao dono; o campo aparece na leitura como "(hidden: only the owner fills this)".
- **Pagamento** continua só pelo `checkout`/`card_fill` (frente A).
- **Run de agenda:** `browser_open/map/read/find/load_more/wait/screenshot/export/digest`, sem `browser_act` nem abas.

### Preset
`CapabilityId` `browser` no preset `full`, lazy ("Bom dia" não ganha nenhuma tool `browser_*`; "abre o site X e me diz Y" carrega no passo 1). Entra só com `PresetDeps.browser: true`.

## Riscos
- **Lista virtualizada** (só uma janela de itens no DOM): o mapa mostra o que está no DOM e o total declarado, mas o carregado nunca chega ao total. O resultado de `browser_load_more`/`browser_export` diz `stalled`; o bot informa em vez de afirmar que viu tudo.
- **Total declarado errado ou ausente:** o mapa só repete o que a página diz; sem ele, o texto avisa que o total é desconhecido.
- **Detecção de "ver mais" por nome** (pt, en, es, fr, de): lista sem botão cai na rolagem; se nada novo aparece, `reachedEnd`.
- **Ids de seção** (`s1`...) valem até a página mudar muito; seção que sumiu falha com a dica de mapear de novo.
- **Contrato com a frente A:** os handlers existem, mas o adaptador `Sandbox` real e o escopo usuário + conversa são da frente A; até lá o worker usa `unavailableSandbox` e as tools falham com o motivo real.
- **Versões mistas no deploy:** a rota `/browser/v4` é nova e aditiva; imagem antiga da VM responde 404 e a tool devolve o erro real.

## Custo
Números medidos no teste dos 1.000 comentários (estimativa de tokens = caracteres / 4, `FakeBrowser` + LLM roteirizado):

| | tokens |
|---|---|
| Lista inteira (1.000 comentários) | ~24.444 |
| Maior pedido ao modelo, caminho busca + carregar mais | ~4.056 |
| Maior pedido ao modelo, caminho arquivo + ajudantes | ~4.109 |

No Chromium real (control server), mapa de 1.000 comentários: menos de 2.500 caracteres. O gasto dos ajudantes do `browser_digest` entra no teto do dono.

### `browser-bench` (F8.1b preparada; **nada foi rodado com modelo real**)
Compara o navegador atual (ADR 0005) com o `agent-browser` (Vercel Labs, Apache-2.0) usado pelo shell da VM, nas mesmas tarefas do `eval:web` (fixture LMS, tarefa nova **T11**: código no comentário nº 870 de 1.000, fora do `--tasks all`). Fica o que **acerta mais**; custo só desempata.

```bash
# só a conta, sem rodar nada
pnpm --filter @workspace/agent-runtime eval:browser-bench -- --estimate
# roteirizado, sem Docker, sem modelo, sem chave (valida o harness)
NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm --filter @workspace/agent-runtime eval:browser-bench -- --dry
# rodada real (SÓ com o ok do dono; exige as três travas)
ATLAS_BENCH_OWNER_OK=1 pnpm --filter @workspace/agent-runtime eval:browser-bench -- --real --max-cost 2 --reps 3 --tasks T11 --models anthropic/claude-haiku-5.5 --env-file <.env> --fixture-host <ip da bridge>
```

Estimativa proposta: 2 braços × T11 × 3 repetições = 6 runs, ~25 passos de ~12 mil tokens de entrada e 300 de saída por run, modelo da classe Haiku (US$ 1/M entrada, US$ 5/M saída, sem cache): **~US$ 0,34 por run, ~US$ 2,03 no total** (teto `--max-cost 2`). O saldo do orçamento é de ~US$ 6,74 (US$ 10 menos ~US$ 3,26 usados). Se empatar no acerto, uma segunda rodada com T7 (iframe e shadow DOM) e T10 (canvas) custaria ~US$ 4 a mais; só vale com novo ok. Antes da rodada real: instalar o `agent-browser` na imagem da VM de teste (`agent-browser --version` é conferido) e confirmar a sintaxe do CLI (`agent-browser --help`), que o sufixo do pedido assume (`open`, `snapshot`, `click @ref`).

## Como testar
```bash
pnpm --filter @workspace/agent exec vitest run src/capabilities/browser src/guards src/presets
cd docker/agent-sandbox/control && node --test browser-*.test.mjs        # Chromium real: ATLAS_TEST_CHROMIUM=/usr/bin/google-chrome
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/browser-actions.test.ts
pnpm --filter @workspace/evals exec tsx src/cli.ts run --mock --scenarios seed-navegador-1000-comentarios-no-870
pnpm --filter @workspace/evals exec tsx src/cli.ts matrix --simulate --engines v4 --scenarios seed-navegador-1000-comentarios-no-870 --models anthropic/claude-sonnet-4-5
```
Previews: a capacidade não tem card novo (o texto sai no chat); nada a mostrar em desktop ou celular nesta frente.
