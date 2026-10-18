# F4 — Confiabilidade do agente e do MCP

**Donos:** Bot B (travas, navegador, questionário, LLM, worker) · Bot A (seção "MCP") · **Depende de:** nada · **Status:** Bot B e Bot A (MCP) completas, revisadas e mergeadas (29/09); verificação manual pendente

## Diagnóstico (8 dias até 28/09/2026)
Falhas por tool (total / falhas):

| Tool | Total | Falhas |
|---|---|---|
| `propose_questionnaire` | 63 | 14 |
| `navigate` | 180 | 11 |
| `firecrawl_scrape` | 28 | 10 |
| `get_spreadsheet` | 9 | 9 |
| `browser_text` | 120 | 8 |
| `type` | 10 | 5 |

Erros finais dos runs `failed` e `budget_exhausted`:

| Erro | Runs |
|---|---|
| OpenRouter "could not verify credits" | 4 |
| "4 ferramentas falharam em sequência" (Firecrawl) | 3 |
| "sem heartbeat" | 3 |
| rate limit "Falha após 5 tentativas" | 4 |
| timeout de 30 min | 2 |
| "Travei repetindo browser_text/key" | 3 |
| "limite de 10 chamadas" | 2 |
| FK `conversation_messages` | 1 |

Onde está no código:
- **Travas globais** (`packages/agent-runtime/src/computer-use.ts`):
  - 4 falhas seguidas de qualquer tool abortam o run (`budget.ts:39`, `computer-use.ts:4354-4364`);
  - limite por tool (MCP 10, `:355`, `:3752`) lança `BudgetExhaustedError` (`:4186-4193`), e o contador sobe antes do check;
  - repetição: pré-check (`:4114-4127`) e `isNoProgressLoop` (`progress.ts:65-105`), em que o mesmo texto de erro conta como "mesmo resultado".
- **Sandbox:** `friendlySandboxError` (`:1296`) diz "repita a ação uma vez", e isso alimenta o detector de loop. `browser_text` = `p.evaluate(innerText)` sem espera (`docker/agent-sandbox/control/server.mjs:136`); click com timeout de 15s (`:109-115`); nenhum retry depois de navegação.
- **Questionário:** `parseArgs` (`:1299-1308`) descarta o JSON inválido e devolve `{}` ("title vazio"). `items` como string falha em `Array.isArray`, e choices `string[]` são descartadas (`:2883`).
- **LLM:** `streamChatWithTools` (`packages/llm/src/chat-tools.ts:149`) não tem retry nem fallback. O 429 é transitório (`errors.ts:84`), e o BullMQ refaz o job inteiro 5 vezes (`packages/queue/src/agent-run-queue.ts:28`).
- **Worker:** a renovação do lease que lança erro marca `leaseLost` mas não aborta (`apps/worker/src/processors/agent-run.ts:284-287`). O finalize grava a mensagem com a conversa apagada, o que dá FK (`packages/db/src/runs.ts:1098,1397`).
- **MCP:**
  - timeout fixo de 30s (`mcp/call.ts:23`), e o timeout não é retentável (`client-pool.ts:76`);
  - resultado `isError` nunca é retentado;
  - `mcp_tool_search` despeja tools já usadas por LRU (`computer-use.ts:3759-3781`).
- **Caso real, 28/09 (run `cmulub3v70007lg8g4wm5dzh8`, revisão do loja-monorepo):**
  - O modelo listou a raiz na **branch padrão** (ali existe a pasta `loja-exemplo/`) e buscou `loja-exemplo/...` com `ref: feat/19-web-v2-seletor-conta`, onde a pasta não existe.
  - 3 `get_file_contents` falharam **no mesmo passo**, e 1 `search_commits` falhou por query inválida. A trava de 4 seguidas matou o run.
  - O run anterior morreu no "limite de 10 chamadas de `get_file_contents`", lendo arquivo a arquivo.
  - Depois disso o usuário mandou "?", e nada foi feito.

## Tarefas — Bot B
- [x] **Falhas por tool:**
  - Contar falhas seguidas **por tool**. 3 falhas seguidas da mesma tool a bloqueiam no run.
  - O modelo recebe: "Tool X ficou indisponível neste run após 3 falhas: <último erro>. Use uma alternativa (ex.: web_extract, navegador) ou siga com o que tem."
  - O run só aborta com 6 falhas seguidas envolvendo 3 ou mais tools distintas.
  - **Falhas no mesmo passo** (várias tool calls paralelas) contam como **1** para a trava global. Para a trava por tool, contam como 1 por tool. Com args diferentes, é um erro de "chute" em lote, não uma quebra.
  - **Erro de argumento não conta** para a trava global: 404, "path does not point", "Validation Failed", `invalid_args`. Conta só para a trava por tool, e com dica (ver a F7.4 e a seção MCP abaixo).
  - **Na trava, o run não termina mudo.** Em vez de a mensagem final ser só o erro, fazer uma última chamada ao LLM **sem tools** com "Não consegui concluir por <motivo>. Resuma ao usuário o que já foi feito e o que falta, e sugira o próximo passo." O `error` técnico continua no run.
- [x] **Limite por tool:** devolve um `tool_result` de erro ("Limite de N chamadas de X atingido neste run; conclua com o que já tem") em vez de `BudgetExhaustedError`. Não incrementar antes do check.
- [x] **Repetição:** na primeira detecção, injetar **uma** mensagem de sistema: "Você repetiu X com o mesmo resultado. Mude de abordagem (outra tool, outro argumento) ou conclua." Só aborta se repetir de novo. Resultados de erro do sandbox não contam como "mesmo resultado" se já houve uma recuperação no meio.
- [x] **`friendlySandboxError`:** tirar "repita a ação". Dizer o que aconteceu (página navegou, elemento não apareceu) e sugerir `browser_text` depois de carregar ou recarregar.
- [x] **Sandbox** (`server.mjs`):
  - `browser_text` e `browser_links`: `await page.waitForLoadState("domcontentloaded")` e retry até 2 vezes no "Execution context was destroyed" ou "navigating", com 500 ms entre tentativas;
  - click: 1 retry depois de `waitForLoadState`;
  - rebuild da imagem, se necessário: documentar o comando no PR. (Não precisou rebuild: só lógica de espera/retry, sem dependência nova.)
- [x] **Questionário tolerante** (`computer-use.ts:2847-2945`):
  - `items` e `choices` aceitos como string JSON;
  - choices `string[]` viram `{label}`;
  - `parseArgs` com JSON inválido lança "argumentos inválidos (JSON): <erro de parse>" mais um exemplo mínimo do schema.
- [x] **LLM** (`packages/llm/src/chat-tools.ts`):
  - mandar `models: [primary, ...OPENROUTER_FALLBACK_MODELS]` (fallback nativo do OpenRouter; nova env em `packages/llm` config e nos `.env.example` da raiz, api e worker);
  - retry por passo: 3 tentativas com backoff exponencial e jitter (1s, 3s, 9s) em 429, 5xx e "could not verify credits", antes de propagar;
  - reduzir `attempts` do job (`agent-run-queue.ts`) para 3.
- [x] **Worker:**
  - lease que lança erro → mesmo caminho do `!ok` (abortar), em `agent-run.ts:284`;
  - finalize e steer: se a conversa não existir, terminar o run sem gravar a mensagem (checar antes ou capturar P2003), em `runs.ts:1098,1397`.
- [x] **`mcp_tool_search`:** tools chamadas no run ficam fixas e não saem no LRU (`computer-use.ts:3759`).

## Tarefas — Bot A (MCP)
- [x] Timeout por conector: campo opcional `callTimeoutMs` no catálogo (`mcp-catalog.ts`). Firecrawl = 90_000. Usar em `mcp/call.ts`.
- [x] Retry único com backoff de 1s para resultado `isError` ou erro com texto transitório (`timeout`, `temporarily`, `ECONNRESET`, 5xx, `rate limit`), em `mcp/client-pool.ts`.
- [x] Firecrawl "All scraping engines failed" → sufixo de dica: "Tente web_extract ou o navegador para esta URL."
- [x] **Dicas do GitHub** (mesmo mecanismo de sufixo, função pura por conector):
  - `get_file_contents` com "path does not point…" → "O caminho não existe no ref `<ref>`. Liste a pasta pai com o **mesmo ref** antes (a estrutura pode ser diferente entre branches), ou use `search_code`.";
  - `search_commits` com "Search text is required" → "search_commits exige texto de busca; para listar commits recentes use `list_commits` (com `since`/`sha`).".

## Testes obrigatórios
- [x] Trava: tool com 3 falhas é bloqueada e o run continua; aborto só com o critério novo.
- [x] Limite por tool devolve erro ao modelo sem abortar.
- [x] Repetição: o primeiro aviso é injetado e o segundo aborta.
- [x] Questionário: `items` string, choices `string[]`, JSON inválido com mensagem clara.
- [x] LLM (fetch mockado): 429, 429 e depois 200 → sucesso; `models` enviado com o fallback.
- [x] Worker: renovação que lança erro aborta; conversa apagada termina sem exceção.
- [x] MCP (A): timeout por conector aplicado; `isError` transitório retentado 1 vez.
- [x] Sandbox: função pura de "deve tentar de novo?" para as mensagens do Playwright.

## Commits
- **B:**
  - `fix(agent): travas por tool em vez de matar o run`
  - `fix(sandbox): browser_text/click resilientes a navegação`
  - `fix(agent): questionário tolerante a formato`
  - `feat(llm): retry por passo e fallback de modelo`
  - `fix(worker): lease e conversa apagada`
  - `fix(agent): mcp_tool_search mantém tools usadas`
- **A:**
  - `fix(mcp): timeout por conector e retry transitório`

## Critérios de aceite
- No `/run`: "pesquisa o preço do MacBook M5 Pro 24GB/1TB em 5 lojas" termina com resposta mesmo com o Firecrawl falhando (cai no `web_extract` ou no navegador).
- A consulta de falhas do README (2 dias depois do merge): nenhum run abortado por "falharam em sequência" ou "limite de N chamadas" por causa de uma tool opcional; `propose_questionnaire` com menos de 5% de falha.

## Commits feitos (Bot B)
- 3b70b7d `fix(agent): travas por tool em vez de matar o run`
- 2f25ae5 `fix(sandbox): browser_text/click resilientes a navegação`
- ca8431a `fix(agent): questionário tolerante a formato`
- 5cd7b54 `feat(llm): retry por passo e fallback de modelo`
- 32598e3 `fix(worker): lease e conversa apagada`
- 27558b5 `fix(agent): mcp_tool_search mantém tools usadas`
- bcc52b8 `fix(agent): falhas em lote e erro de argumento não derrubam o run`
- 5245723 `feat(agent): run travado termina com resumo do que foi feito`
