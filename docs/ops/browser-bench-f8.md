# browser-bench F8.1b: navegador atual x `agent-browser` (09/11/2026)

**Decisão final (T11 + T7 + T10): fica o navegador atual (ADR 0005). Acertou 9/9 contra 6/9 do `agent-browser`.** A rodada 1 (T11) empatou; a rodada 2 (T7 e T10) está no fim deste arquivo.

Rodada real aprovada pelo dono (teto US$ 2,00; orçamento total US$ 10, ~US$ 3,26 já usados antes). Issues #167 e #165.

## Como foi rodada
- Modelo: `anthropic-direct/claude-haiku-5-5` (Anthropic direta, chave por variável de ambiente; nada gravado).
- Tarefa: **T11** (código de desconto no comentário nº 870 de 1.000, fixture LMS), 3 repetições por braço, até 40 passos.
- Braço `current`: navegador atual (ADR 0005: `browser_snapshot/read/find/act`).
- Braço `agent-browser`: o modelo usa só o CLI no shell da VM (`agent-browser open`, `snapshot`, `click @ref`).
- `agent-browser` **0.41.2** (npm, Apache-2.0, Vercel Labs), instalado numa imagem de teste (`npm i -g` sobre a imagem da VM desta branch) com `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable` e `AGENT_BROWSER_ARGS=--no-sandbox`. A sintaxe assumida pelo bench (`open <url>`, `snapshot`, `click <sel|@ref>`) foi conferida em `agent-browser --help` e está certa.
- Fixture servido no host e acessado pela VM em `172.17.0.1` (gateway da bridge do Docker).

## Resultado

| braço | acertos | passos (média) | tokens de entrada acumulados (média/run) | custo total (3 runs) |
|---|---|---|---|---|
| current | 3/3 | 14,3 (12, 20, 11) | 452.400 | US$ 0,0313 |
| agent-browser | 3/3 | 7 (7, 9, 5) | 156.212 | US$ 0,0093 |

Custo real total gasto: **US$ 0,0462** (US$ 0,0056 num teste de fumaça de 1 run do `agent-browser` + US$ 0,0406 na rodada de 6 runs). Sem falhas de modelo nem de infraestrutura na rodada final. Custo calculado pela tabela do Haiku 5.5 (US$ 0,10/M entrada, 0,50/M saída, cache lido 0,1x, gravado 1,25x); o adaptador direto só devolve tokens.

## Decisão
Regra do dono: fica o braço que **acerta mais**; custo só desempata. Os dois acertaram 3/3 em T11: **empate no acerto, então mantém-se o atual (ADR 0005)**. O `agent-browser` saiu mais barato e com metade dos passos, mas uma única tarefa, de leitura em página longa, não separa os dois no que importa (acerto). Para decidir de fato, uma rodada extra com **T7 (iframe e shadow DOM) e T10 (canvas)**, onde o acerto pode divergir, custaria ~US$ 4 pela estimativa antiga e bem menos pelo preço real (T11 custou US$ 0,05); **só rodar com novo ok do dono**.

Observação: o `pickWinner` do bench desempata por custo e imprime "Fica: agent-browser"; pela regra acima, empate no acerto mantém o atual. Vale ajustar o `pickWinner` para devolver `tie` nesse caso se o dono confirmar a regra.

## O que foi corrigido no caminho
1. O bench só falava com o OpenRouter: criado `evals/web/direct-provider.ts` (Anthropic direta + custo por tabela, com teste).
2. Estimativa padrão assumia US$ 1/5 por milhão (10x o preço real do Haiku 5.5): agora 0,10/0,50.
3. O bench não carregava `env.ts` (faltava `ATLAS_HOOK_PEPPER` fora do vitest).
4. Build da imagem da VM neste container exigiu confiar na CA do proxy de saída (só na imagem de teste, fora do repositório).

## Rodada 2 (T7 iframe e shadow DOM, T10 canvas), com novo ok do dono e teto de US$ 1

Mesmo setup (Haiku 5.5 direto, 3 repetições por braço, `agent-browser` 0.41.2, imagem de teste reconstruída; o daemon Docker do container reiniciou no meio e a imagem foi refeita).

| tarefa | braço | acertos | passos (média) | tokens de entrada acumulados (média/run) | custo (3 runs) |
|---|---|---|---|---|---|
| T11 | current | 3/3 | 14,3 | 452.400 | US$ 0,0313 |
| T11 | agent-browser | 3/3 | 7 | 156.212 | US$ 0,0093 |
| T7 | current | 3/3 | 5 | 88.653 | US$ 0,0084 |
| T7 | agent-browser | 3/3 | 8,7 | 188.766 | US$ 0,0123 |
| T10 | current | 3/3 | 3 | 59.719 | US$ 0,0051 |
| T10 | agent-browser | **0/3** | 6 | 138.748 | US$ 0,0097 |
| **total** | current | **9/9** | | | US$ 0,0448 |
| **total** | agent-browser | **6/9** | | | US$ 0,0313 |

Custo real da rodada 2: **US$ 0,0355**. Custo real acumulado das duas rodadas (com o teste de fumaça): **US$ 0,0817**.

Sobre a T10: o valor do gráfico só existe no canvas e a checagem exige ler um screenshot. O braço `agent-browser` trabalha só por texto no shell e não vê a imagem, então os 0/3 refletem uma limitação desse meio (sem visão), não falha de infraestrutura. Não foi investigado run a run.

### Decisão final
Regra do dono: fica o braço que acerta mais no total das 3 tarefas; custo não desempata. **Navegador atual: 9/9; `agent-browser`: 6/9. Fica o atual (ADR 0005).** Ressalva: o `agent-browser` foi mais barato e com menos passos na T11 (página longa); vale reavaliar só esse caso se o custo de páginas longas virar problema.
