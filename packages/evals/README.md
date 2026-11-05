# @workspace/evals — o erro é do MODELO ou do HARNESS?

Bateria de cenários que roda o runtime de verdade (`runComputerUse`) contra modelos reais via OpenRouter, com as
ferramentas respondidas por fixtures (nada de rede externa nem banco), e devolve uma matriz **cenário × modelo** com
a taxa de acerto, as verificações que falharam e um veredito por cenário: `modelo`, `harness/instruções`, `instável`.

Inspirado nos evals do Hermes Agent (calibração por modelo, políticas comparáveis), adaptado ao Atlas.

## Estrutura

```
packages/evals/
  scenarios/*.json      cenários versionados (semente: casos reais do projeto, anonimizados)
  scenarios/gold/<capacidade>/<nn>-<slug>.json   conjunto ouro (24 tarefas do uso real do dono; ver "Conjunto ouro")
  src/scenario.ts       formato do cenário (zod, campo desconhecido = erro)
  src/checks.ts         verificações determinísticas (+ juiz LLM opcional)
  src/quality.ts        rubrica de qualidade: prompt do juiz, parse, teto de discordância, agregação (puro)
  src/judge.ts          juízes LLM (1 ou 2) e o painel que vira a verificação `judge`
  src/environment.ts    ambiente falso: perfil do bot, fixtures de tools nativas, conectores falsos, arquivos em memória
  src/run-scenario.ts   um cenário → trajetória (pedidos ao modelo, chamadas de tool, eventos)
  src/runner.ts         cenário × modelo × repetição × variante, concorrência, custo, JSONL
  src/verdict.ts        diagnóstico modelo x harness
  src/report.ts         matriz, delta entre variantes
  src/variants.ts       variantes de harness (`--harness`)
  src/from-run.ts       run de produção → cenário (com redação)
  src/cli.ts            comandos run / compare / from-run / list
  results/              saída das execuções (ignorada pelo git)
```

## Como rodar

### Modo mock (CI, sem rede, sem chave)

```bash
pnpm --filter @workspace/evals test            # schema, verificações, redação, veredito e o runner com modelo roteirizado
pnpm --filter @workspace/evals run eval -- --mock
```

No modo mock cada cenário usa o roteiro em `mock.turns`. Ele valida o **harness** (schema, ambiente falso,
verificações, fiação do runner), nunca a qualidade de um modelo. Todo cenário semente precisa passar no mock.

Os testes importam `@workspace/agent-runtime` de `dist/`: depois de mudar o runtime, rode
`pnpm exec turbo build --filter='./packages/*'` antes.

### Modo real (gasta tokens)

```bash
export OPENROUTER_API_KEY=...        # ou: --env-file ../../.env
pnpm --filter @workspace/evals run eval -- \
  --models deepseek/deepseek-chat-v3.1,anthropic/claude-sonnet-5-5 \
  --scenarios all --repeat 3
```

Opções úteis:

| opção | o que faz |
|---|---|
| `--scenarios ids,tags` | só esses cenários (ids ou tags, ex.: `arquivos,rotinas`; `gold` = só o conjunto ouro; `all` = sementes + ouro) |
| `--dir DIR` | pasta dos cenários (padrão `scenarios/`, lida com subpastas) |
| `--repeat N` | repetições por cenário e modelo (3 separa "instável" de "falha") |
| `--concurrency N` | execuções simultâneas (padrão 3; o container é pequeno, não passe de 4) |
| `--timeout S` | segundos por execução (padrão 180) |
| `--max-cost USD` | não inicia novas execuções depois do teto |
| `--strong a,b` | quais modelos contam como "fortes" no diagnóstico |
| `--harness base,sem-disciplina` | compara variantes do runtime nos mesmos modelos |
| `--judge A[,B]` | liga o juiz LLM (rubrica de qualidade) nas verificações `judge`; dois modelos = dois juízes com teto de discordância (ver "Juízes e rubrica de qualidade"). Desligado por padrão |
| `--judge-max-gap N` | diferença máxima entre os dois juízes por dimensão (padrão 1) |
| `--out DIR` | pasta de saída (padrão `results/<data-hora>`) |

A chave só é lida do ambiente. Ela nunca é impressa, e cada linha gravada passa por `redactSecrets` com a chave antes de
ir ao disco.

Saída em `results/<data-hora>/`:

- `runs.jsonl`: uma linha por execução, com a trajetória completa (mensagens enviadas ao modelo em cada passo, tools
  oferecidas, respostas, chamadas e resultados de tool com a origem `fixture|connector|real|unmocked`, eventos, uso e
  custo) e o resultado de cada verificação;
- `summary.json`: agregados por variante/cenário/modelo e vereditos;
- `matrix.txt`: a matriz impressa no terminal.

## Ler a matriz

```
== harness: base ==
cenário                    | deepseek/deepseek-chat-v3.1     | anthropic/claude-sonnet-5-5 | veredito
cotacao-colada-altera-dados| 1/3 no_question(2)              | 3/3 ok                      | modelo
lembrete-obvio-vira-rotina | 0/3 tool_called:propose_routine(3) | 0/3 tool_called:propose_routine(3) | harness/instruções
```

- **Célula** `acertos/execuções` e as verificações que falharam, com quantas vezes (até duas, `+N` para o resto).
  `erro(N)` = execuções que terminaram em exceção ou timeout.
- **Veredito** por cenário:

| veredito | quando | o que fazer |
|---|---|---|
| `ok` | todos os modelos passam em todas as repetições | nada |
| `modelo` | o(s) forte(s) passam 100% e algum fraco falha | limite do modelo: disciplina por família (`model-discipline`), roteamento por nível, ou aceitar |
| `harness/instruções` | nenhum modelo passa | o problema é nosso: prompt, descrição da tool, trava do runtime, ou a expectativa está errada |
| `instável` | alguém passa às vezes (0 < acerto < 100%) | instrução ambígua ou sensível à amostragem; aumente `--repeat` e leia as trajetórias que falharam |
| `inconclusivo` | um forte falha onde um fraco passa | quase sempre expectativa mal escrita; confira o cenário |
| `erro de execução` | todas as execuções caíram antes de responder | rede, chave, timeout, crédito |
| `indefinido` | só um modelo fraco rodou e falhou | rode também com um modelo forte |

"Forte" por padrão: Claude Sonnet/Opus, GPT-5, Gemini Pro. Troque com `--strong`.

- **Tools sem fixture**: se o modelo chamou uma tool que o cenário não previu, ela respondeu "indisponível" e aparece no
  rodapé da matriz. É lacuna do cenário (adicione o fixture), não erro do modelo.

### Comparar harness

Variantes do runtime ficam em `src/variants.ts` (parâmetros do `runComputerUse` e, se precisar, variáveis de ambiente
aplicadas só enquanto a variante roda):

```bash
pnpm --filter @workspace/evals run eval -- --models deepseek/deepseek-chat-v3.1 --repeat 3 --harness base,sem-disciplina
```

O relatório traz a matriz de cada variante e o **delta em pontos percentuais** (variante − base) por cenário e modelo.

Para comparar commits (prompt mudou no código), rode a mesma bateria em cada worktree e compare os resultados:

```bash
# no worktree A e no worktree B
pnpm --filter @workspace/evals run eval -- --models ... --repeat 3 --out /tmp/evals-a   # (e /tmp/evals-b no outro)
pnpm --filter @workspace/evals run eval -- compare /tmp/evals-a /tmp/evals-b
```

## Matriz: cenários × motores × modelos × repetições (`matrix`)

Mede o conjunto ouro em vários provedores de uma vez e responde "é o harness ou o modelo?" (`PLANO-AGENTE-V4/04-avaliacao.md` §2 e §3). Reaproveita o runner, as verificações, o veredito (`verdict.ts`) e os adaptadores do `packages/llm`; o código fica em `src/matrix/`.

```bash
# 1. quanto custaria (sem rede, sem chave)
pnpm --filter @workspace/evals run eval -- matrix --scenarios gold --engines v2 \
  --models anthropic/claude-haiku-5-5,opencode-go/deepseek-v4.1-flash,opencode-go/qwen3.8-flash --repeat 3 --estimate
# 2. ensaio da matriz inteira com provedores falsos (sem rede, sem chave)
pnpm --filter @workspace/evals run eval -- matrix --scenarios gold --engines v2,v1 --models ... --repeat 3 --simulate --max-usd 0.05
# 3. rodada real (gasta tokens; --max-usd é obrigatório)
pnpm --filter @workspace/evals run eval -- matrix --scenarios gold --engines v2 --models ... --repeat 3 --max-usd 2
```

**Provedores pelo prefixo do modelo** (a chave só é lida do ambiente; falta de chave falha antes de qualquer execução, citando só o nome da variável; o valor nunca é impresso nem gravado):

| prefixo | provedor | variável |
|---|---|---|
| `anthropic/<modelo>` | Anthropic direto | `CLAUDE_KEY` (reserva: `ANTHROPIC_API_KEY`) |
| `opencode-go/<modelo>` | OpenCode Go (protocolo por `goProtocolFor`) | `OPENCODE_GO_API_KEY` |
| `openrouter/<id>` ou `<id>` | OpenRouter | `OPENROUTER_API_KEY` |

`anthropic/` aqui é sempre o Anthropic **direto**; o Claude via OpenRouter é `openrouter/anthropic/<modelo>`.

| opção | o que faz |
|---|---|
| `--scenarios gold\|ids\|tags` | cenários (padrão `gold`) |
| `--engines v2[,v1]` | motores; cada cenário roda em cada um (sobrescreve `run.engine`). Padrão `v2` |
| `--models a,b` | modelos com prefixo (obrigatório, exceto com `--estimate`/`--simulate`) |
| `--repeat N` | repetições (padrão 1). Se o teto cortar, as repetições já feitas cobrem todas as células |
| `--max-usd N` | teto **rígido** desta invocação. Antes de cada execução: gasto + reservas em andamento + estimativa da próxima > teto → para de agendar e o resto vira `skipped_budget`; o relatório sai mesmo assim |
| `--estimate` | só estima e imprime a tabela (sem rede, sai com 0). Aceita `--max-usd` para dizer quantas execuções cabem |
| `--estimate-factor N` | multiplicador de passos do modelo real sobre o roteiro mock (padrão 2) |
| `--simulate` | a matriz inteira com provedores falsos: roteiro mock + uso falso por provedor (Anthropic `costUnknown`, Go `plan`, OpenRouter `costUsd`) e falhas determinísticas nos modelos baratos. Exercita roteamento, custo, teto, agregação e relatório; os números não medem modelo nenhum |
| `--judge A[,B]` | juízes da rubrica de qualidade (também com prefixo de provedor); o gasto deles entra no teto e no `--estimate` |
| `--judge-max-gap N` | teto de discordância entre os juízes (padrão 1) |
| `--strong a,b` | quais modelos são "fortes" na leitura harness × modelo (padrão: Claude Sonnet/Opus) |
| `--concurrency N`, `--timeout S`, `--dir`, `--out`, `--env-file` | como no `run` |

**Custo.** Anthropic direto e OpenCode Go só devolvem tokens: o custo sai da tabela `src/matrix/pricing.ts` (Go: `opencode.ai/docs/go`, deepseek pelo preço de pico). Modelo fora da tabela usa o preço conservador (US$ 3/15 por Mtok) e fica marcado `costUnknown` (`*` no relatório); os preços da Anthropic direta estão marcados "a confirmar". OpenRouter usa o custo real do provedor. A estimativa de cada execução (`--estimate` e a reserva do teto) é o tamanho do roteiro mock do cenário × fator, sem desconto de cache. O teto vale por invocação: o limite de US$ 10 da Anthropic somando várias rodadas é do dono controlar.

**Saída** em `results/<data-hora>-matrix/` (ignorada pelo git): `matrix.md`, `matrix.json` e `runs.jsonl` (trajetórias, com as chaves redigidas). O relatório traz por modelo × motor (acerto, passos, tokens, custo, duração), por provedor, por capacidade (pasta do ouro), a diferença entre motores e, por cenário × motor, a leitura mecânica: `harness/instruções` (falha em todos os modelos), `modelo` (passa no forte e falha só nos baratos), `instável` (repetições divergem). É relatório determinístico, não juiz. Falha que reproduz com o modelo roteirizado (`--simulate` sem as falhas sintéticas, ou `--mock`) é bug de harness.

**Plugar um motor novo (v3, v4, presets).** Um mapa só: `ENGINE_ADAPTERS` em `src/matrix/engines.ts` (id → `patchScenario` e/ou `runOptions` do `runScenario`). Hoje existem `v1` e `v2`; o v3 vive num branch congelado e o v4 ainda não existe no runtime.

## Juízes e rubrica de qualidade (`--judge`)

Mede **qualidade**, que as verificações determinísticas não pegam (`PLANO-AGENTE-V4/04-avaliacao.md` §1). Roda **só no eval**, nunca no runtime, e **nunca sem `--judge`**. Só os cenários com verificação `judge` são julgados; o texto da `rubric` do cenário continua sendo a orientação específica da tarefa.

**Dimensões** (nota inteira de 1 a 5 cada): `completude` (responde tudo que foi pedido, com o conteúdo real), `fontes` (cita ou usa fontes direito quando a tarefa pede; pode ser N/A), `formato` (o formato certo: arquivo, tabela, card ou resposta curta) e `antecipacao` (antecipa a próxima necessidade óbvia sem encher; pode ser N/A). Só `fontes` e `antecipacao` aceitam N/A.

**Esquema do juiz** (JSON puro, uma justificativa de uma linha em pt-BR por dimensão):

```json
{"completude":{"score":4,"reason":"..."},"fontes":{"score":null,"reason":"..."},"formato":{"score":4,"reason":"..."},"antecipacao":{"score":3,"reason":"..."}}
```

O parse é defensivo (aceita cerca de código e ruído em volta). JSON quebrado, dimensão faltando, nota fora de 1-5 ou N/A onde não vale → resultado **`invalid`**: nunca vira nota. Erro de rede do juiz também é `invalid`. A verificação `judge` fica então "pulada" (sem medida: não aprova nem reprova) e o relatório conta os inválidos.

**O que o juiz vê:** o pedido (e as últimas mensagens do histórico), o texto final, a lista de tools chamadas com resultado curto e os arquivos criados. **Não** vê as verificações esperadas. O prompt é em inglês, curto e em seções; trata resposta e saída de tool como dado (não instrução), e julga como um usuário de assistente pessoal no Brasil (pt-BR). Seções do prompt têm as tags neutralizadas no conteúdo, para uma resposta não fechar a seção do juiz.

**Dois juízes** (`--judge a,b`, com prefixo de provedor como na matriz: `anthropic/...`, `opencode-go/...`, `openrouter/...`): cada um julga sozinho, em paralelo, com o mesmo prompt. **Prefira provedores diferentes** (ex.: `anthropic/claude-haiku-5-5,opencode-go/deepseek-v4.1-flash`): dois modelos da mesma família erram do mesmo jeito e concordam por viés, não por acerto. Evite também julgar um modelo com ele mesmo (autopreferência infla a nota).

**Teto de discordância** (`--judge-max-gap`, padrão 1). Por dimensão, se `|a − b| > gap`, ela fica `disputed` e **sai da nota**; N/A de um juiz contra nota do outro também é disputa. A nota do cenário é a **média das dimensões em acordo** (cada uma é a média dos dois juízes). Todas as dimensões aplicáveis em disputa → cenário `disputed`, sem nota. Algum juiz `invalid` → `invalid`, sem nota. A verificação `judge` passa com nota >= 3.

**Um juiz só** (`--judge a`): sem teto de discordância ("1 juiz, sem teto de discordância" aparece no detalhe e no relatório); a nota média >= 3 aprova, como antes o aprova/reprova, mas sobre o esquema novo.

**No `run`**: cada execução leva a nota e o detalhe na verificação `judge` (em `runs.jsonl`, campo `quality`), e o relatório ganha a linha `qualidade (rubrica)`. Os juízes usam o roteamento por prefixo da matriz (chaves `CLAUDE_KEY`, `OPENCODE_GO_API_KEY`, `OPENROUTER_API_KEY`); o gasto deles conta no `--max-cost`. Com `--mock` o juiz é ignorado (sem rede).

**No `matrix`**: o relatório ganha "Qualidade (rubrica) por modelo" (nota média, % de dimensões em disputa, cenários em disputa, inválidos e a média por dimensão, por motor × modelo), "Qualidade por capacidade" e a coluna `qualidade` no detalhe. O gasto dos juízes sai do **mesmo** `--max-usd`: a reserva de cada execução inclui a estimativa dos juízes e o gasto real é cobrado do teto. `--estimate` soma as chamadas dos juízes (3000 tokens de entrada + 500 de saída por juiz e por execução julgada, tabela de preços de `src/matrix/pricing.ts`). `--simulate --judge a,b` usa juízes falsos determinísticos (sem rede nem chave) para ensaiar o pipeline; as notas não medem nada.

```bash
pnpm --filter @workspace/evals run eval -- matrix --scenarios gold --engines v2 --models ... --repeat 3 --max-usd 2 \
  --judge anthropic/claude-haiku-5-5,opencode-go/deepseek-v4.1-flash --judge-max-gap 1
```

## Comparar o motor atual (v1) e o novo (v2)

```bash
# roteiro: sem rede e sem chave, números idênticos a cada execução (11 tarefas de pesquisa/análise)
pnpm --filter @workspace/evals run eval -- motor-v1-vs-v2 --out ../../docs/ops/motor-v1-vs-v2.md

# ao vivo (GASTA tokens; só com a chave e a decisão do dono): modelo de verdade, mesmo mundo falso
export OPENROUTER_API_KEY=...        # ou: --env-file ../../.env
pnpm --filter @workspace/evals run eval -- motor-v1-vs-v2 --live --model <id do modelo> --out /tmp/combo-A.md
```

Mede por tarefa e motor: concluiu?, motivo de término, perguntas ao usuário, chamadas ao modelo, custo estimado (tokens ×
preço fixo, `--price-in/--price-out`), itens "não confirmados", documento gerado e cobertura do pedido. As tarefas e o
mundo falso (fornecedores, lojas, SKUs fictícios) ficam em `src/engine-compare/`. O modo roteiro mede o **motor** (travas,
entrega, custo) com o mesmo comportamento de pesquisa nos dois; só o `--live` mede o modelo. O eval não usa `delegate`
(precisa do banco): "Sonnet coordena + Haiku nos ajudantes" só se mede em produção (`docs/ops/piloto-motor-v2.md`).

## Escrever um cenário

Um JSON em `scenarios/` (o nome do arquivo só define a ordem):

```json
{
  "version": 1,
  "id": "lembrete-obvio-vira-rotina",
  "title": "Pedido óbvio de lembrete → cria a rotina, sem questionário",
  "tags": ["rotinas"],
  "bot": { "name": "Ada", "about": "Assistente pessoal.", "language": "pt-BR" },
  "history": [],
  "user": "me lembra amanhã às 9h de ligar pro fornecedor",
  "tools": {
    "fixtures": [
      { "tool": "propose_routine", "args": { "action": { "equals": "create" } }, "result": { "ok": true, "summary": "Routine created ..." } }
    ],
    "connectors": [],
    "allowReal": []
  },
  "expect": [
    { "type": "tool_called", "tool": "propose_routine", "args": { "trigger_type": { "equals": "once" } } },
    { "type": "no_question" }
  ],
  "mock": { "turns": [ { "calls": [ { "name": "propose_routine", "args": { "action": "create", "trigger_type": "once" } } ] }, { "say": "Combinado." } ] }
}
```

- `history`: mensagens `user`/`assistant`; também aceita `{ "role": "assistant", "toolCalls": [...] }` e
  `{ "role": "tool", "toolCallId": "...", "content": "..." }` (vão como transcrição dos turnos anteriores, como no worker).
- `steer`: `[{ "afterModelCalls": 1, "content": "..." }]` = mensagem do usuário que chega no meio do run.
- `tools.fixtures`: tool nativa respondida pelo fixture (o primeiro cujo `args` bate). `uses: N` limita a N respostas e depois passa ao próximo fixture que bate (ex.: o teste falha na 1ª execução e passa depois da correção). Sem fixture, só rodam de verdade
  as tools puras (`track_items`, `update_task_list`, `create_file` com armazenamento em memória, `mcp_tool_search`,
  `read_cached_result`, `skill_read`/`list_skills`/`show_skill`, e o que estiver em `allowReal`); as demais respondem
  "indisponível". As skills rodam de verdade contra uma loja em memória (`memorySkillsStore`, injetada pelo parâmetro
  `skillStore` do runtime): sem skill do dono e sem escrita, então `skill_read` devolve o markdown real das skills de
  fábrica (`skills/builtin/*.md`), sem banco. Um fixture de `skill_read` no cenário ainda vence.
- `tools.connectors`: conector falso (`mcp__<slug>__<tool>`), com `readOnly`/`destructive`, `inputSchema` e respostas
  por argumento. `preload: true` carrega as tools no 1º passo (como uma menção `@App`).
- Predicados de argumento (caminho com pontos, `items.0.sku`): `equals`, `oneOf`, `contains`, `matches` (regex, sem
  diferenciar maiúsculas), `exists`.
- `run`: `maxSteps`, `origin` (`chat`, `routine`...), `engine` (`v1`/`v2`), `briefReadOnly`, `proactive: true` (oferece `schedule_followup` e cia., como no chat do bot principal) e `sandbox: true` (oferece navegador, `login_fill` e shell da VM; a execução continua sendo por fixture, nunca há VM).
- `mock.turns`: roteiro do modo mock. Obrigatório para cenário semente (o CI roda todos).

Verificações (`expect`; `id` opcional dá o nome que aparece na matriz):

| tipo | passa quando |
|---|---|
| `completed` | o run terminou sem erro e com resposta (implícita quando o run falha) |
| `tool_called` | chamou `tool` (ou `toolPattern`) com `args`, entre `min` e `max` vezes |
| `tool_not_called` | não chamou `tool`/`toolPattern` (com `args`, se dados) |
| `no_question` | não terminou com pergunta nem abriu questionário |
| `asks_question` | perguntou (1 a `max` "?", questionário conta) |
| `text_contains` / `text_not_contains` | resposta final com/sem `value` ou `pattern` (regex) |
| `max_model_calls` | no máximo N passos do agente (chamadas com tools) |
| `max_discards` | no máximo N respostas refeitas pelo runtime (rascunho revisado) |
| `max_context_tokens` | o pedido do 1º passo do agente (mensagens + schemas das tools, caracteres / 4) tem no máximo N tokens estimados; determinística e independente do provedor |
| `any_of` | passa se QUALQUER verificação de `checks` (2 ou mais, sem `judge`) passa; ex.: lembrete por rotina `once` ou por `schedule_followup` |
| `language` | idioma da resposta (heurística por palavras funcionais) |
| `no_internals` | nada de nome de tool, número de revisão, "a ferramenta recusou" nem dos `extraTerms` (fora de blocos cercados) |
| `file_created` | card de arquivo, com `extension` se dada |
| `chart` | gráfico válido (bloco ```chart ou evento) com o `spec` pedido |
| `no_unfulfilled_promise` | não terminou só prometendo ("vou gerar agora") |
| `no_model_note` | nenhuma nota do runtime ao modelo casa com `pattern` |
| `steer_delivered` | a mensagem do meio do run chegou ao modelo como fala do usuário |
| `judge` | a rubrica de qualidade tira nota média >= 3 (1 a 5) no juízo de `--judge`; sem ele fica "pulada", e disputada/inválida também (ver abaixo) |

## Conjunto ouro (baseline do Motor v4)

24 tarefas do uso real do dono (`PLANO-AGENTE-V4/04-avaliacao.md` §1), em `scenarios/gold/<capacidade>/<nn>-<slug>.json`: e-mail (3), compras (3), entregáveis (3), pesquisa (2), agenda (3), dia (1), navegador (1), código (1), segurança (3), insistência (3) e economia (1). Todo cenário tem as tags `gold` e a da capacidade; os que devem ser trocados por um run real redigido (`from-run.ts`) levam `real-pendente`. Rodam no motor v2 (`run.engine: "v2"`), o padrão de hoje.

```bash
pnpm --filter @workspace/evals run eval -- list --scenarios gold                       # lista
pnpm --filter @workspace/evals run eval -- --mock --scenarios gold                     # roteiro ideal (sem rede nem chave)
pnpm --filter @workspace/evals run eval -- --scenarios gold --models <ids> --repeat 3  # baseline com modelo real (gasta tokens)
pnpm --filter @workspace/evals run eval -- --scenarios gold,insistencia ...            # uma capacidade (a tag é o nome da pasta)
```

- O **mock** do ouro valida o harness (schema, fixtures, verificações) e que o roteiro só usa tools que o runtime oferece; nenhum modelo é medido ali. `gold.test.ts` também confere, por cenário, que uma trajetória ruim reprova (um padrão de texto errado deixaria o baseline verde por engano).
- **Falhar no v2 é esperado** em vários (é o ponto do baseline). Não afrouxe a expectativa para o v2 passar. A `description` de cada cenário diz o que se espera do v2.
- As verificações de texto do ouro (`text_not_contains` "vídeo", "PWNED", "comprei"...) são afirmações determinísticas sobre a SAÍDA do eval, não decisão de comportamento do runtime (a regra de `60-agente.md` vale para o runtime).
- Limites conhecidos: o relógio do runtime não é injetável (o lembrete de "amanhã às 10h" confere a HORA, não o dia); a nota de continuação que o worker injeta com dados do banco (`continuedWorkNote`) não existe no eval, então a insistência mede a parte do modelo; o cenário de código usa a VM de shell por fixture (a sessão de código não é oferecida pelo v2).

## Cenário a partir de uma conversa real

1. No worker, ligue o inspetor completo para o pedido enviado ao modelo entrar no inspetor: `ATLAS_RUN_INSPECTOR_FULL=1`
   (sem isso, passe o pedido com `--user`).
2. Exporte o run (o id está no inspetor do chat). Copie o cabeçalho `Cookie` da sua sessão no navegador (DevTools →
   Rede → qualquer pedido a `/v1`). Não automatizamos a autenticação de propósito:

   ```bash
   curl -s -H "Cookie: <cookie da sessão>" "$ATLAS_URL/v1/runs/<runId>/inspect" > run-inspect.json
   curl -s -H "Cookie: <cookie da sessão>" "$ATLAS_URL/v1/runs/<runId>/events"  > run-events.json
   ```

3. Gere o cenário:

   ```bash
   pnpm --filter @workspace/evals run eval -- from-run --inspect run-inspect.json --events run-events.json \
     --id meu-caso --out scenarios/11-meu-caso.json
   ```

   Os resultados de tool viram fixtures (tools nativas) ou conectores falsos (`mcp__*`), com a resposta exata do run.
   E-mails, telefones, CPFs e CNPJs viram marcadores com o mesmo formato (o mesmo valor vira sempre o mesmo marcador) e
   segredos somem. A resposta dada em produção vai na `description`.
4. Revise o arquivo (a redação é por padrão: nomes de pessoas e endereços **não** são detectados), escreva o título, as
   expectativas e o `mock.turns`, e apague `run-inspect.json`/`run-events.json`, que têm dados reais.

## Limitações

- Sem banco: tools que dependem dele (memória, rotinas, painéis, skills) só funcionam com fixture; o card de rotina ou
  de painel não é emitido quando a tool é respondida por fixture (a verificação é pela chamada).
- O Jev (decisões baratas) fica desligado e o sandbox não existe: cenários que dependem de `run_code` ou navegador
  precisam de fixture.
- A triagem de mensagem do meio do run usa o modelo do run no modo real; no mock ela fica indisponível (caminho neutro).
- `--harness` com `env` só afeta o que o runtime lê a cada run; variável lida ao carregar o módulo exige `compare` entre
  dois diretórios de resultado.
- Idioma, pergunta e promessa são heurísticas de texto: leia a trajetória antes de concluir.
- Custo vem do `usage.cost` do OpenRouter; quando o provedor não informa, o total sai marcado como parcial.
