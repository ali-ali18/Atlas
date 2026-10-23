# @workspace/evals — o erro é do MODELO ou do HARNESS?

Bateria de cenários que roda o runtime de verdade (`runComputerUse`) contra modelos reais via OpenRouter, com as
ferramentas respondidas por fixtures (nada de rede externa nem banco), e devolve uma matriz **cenário × modelo** com
a taxa de acerto, as verificações que falharam e um veredito por cenário: `modelo`, `harness/instruções`, `instável`.

Inspirado nos evals do Hermes Agent (calibração por modelo, políticas comparáveis), adaptado ao Atlas.

## Estrutura

```
packages/evals/
  scenarios/*.json      cenários versionados (semente: casos reais do projeto, anonimizados)
  src/scenario.ts       formato do cenário (zod, campo desconhecido = erro)
  src/checks.ts         verificações determinísticas (+ juiz LLM opcional)
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
| `--scenarios ids,tags` | só esses cenários (ids ou tags, ex.: `arquivos,rotinas`) |
| `--repeat N` | repetições por cenário e modelo (3 separa "instável" de "falha") |
| `--concurrency N` | execuções simultâneas (padrão 3; o container é pequeno, não passe de 4) |
| `--timeout S` | segundos por execução (padrão 180) |
| `--max-cost USD` | não inicia novas execuções depois do teto |
| `--strong a,b` | quais modelos contam como "fortes" no diagnóstico |
| `--harness base,sem-disciplina` | compara variantes do runtime nos mesmos modelos |
| `--judge MODELO` | liga o juiz LLM das verificações `judge` (desligado por padrão) |
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
- `tools.fixtures`: tool nativa respondida pelo fixture (o primeiro cujo `args` bate). Sem fixture, só rodam de verdade
  as tools puras (`track_items`, `update_task_list`, `create_file` com armazenamento em memória, `mcp_tool_search`,
  `read_cached_result`, e o que estiver em `allowReal`); as demais respondem "indisponível".
- `tools.connectors`: conector falso (`mcp__<slug>__<tool>`), com `readOnly`/`destructive`, `inputSchema` e respostas
  por argumento. `preload: true` carrega as tools no 1º passo (como uma menção `@App`).
- Predicados de argumento (caminho com pontos, `items.0.sku`): `equals`, `oneOf`, `contains`, `matches` (regex, sem
  diferenciar maiúsculas), `exists`.
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
| `language` | idioma da resposta (heurística por palavras funcionais) |
| `no_internals` | nada de nome de tool, número de revisão, "a ferramenta recusou" nem dos `extraTerms` (fora de blocos cercados) |
| `file_created` | card de arquivo, com `extension` se dada |
| `chart` | gráfico válido (bloco ```chart ou evento) com o `spec` pedido |
| `no_unfulfilled_promise` | não terminou só prometendo ("vou gerar agora") |
| `no_model_note` | nenhuma nota do runtime ao modelo casa com `pattern` |
| `steer_delivered` | a mensagem do meio do run chegou ao modelo como fala do usuário |
| `judge` | o juiz LLM aprova a `rubric` (só com `--judge`; sem ele fica "pulada") |

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
