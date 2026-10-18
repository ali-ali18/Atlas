# Pesquisa agêntica — fase 1 (wired, sem multi-abas)

Escada: API/conector → `web_search` → `web_extract` → navegador
(`navigate`/`browser_*`) → desktop (`screenshot`/`click`) como último recurso.
Wiring no `runComputerUse` (`packages/agent-runtime/src/computer-use.ts`):
tools filtradas por env, bloco de prompt fora de rotina, higiene por passo,
cotas via `maxCallsPerTool`.

## Configuração de chaves

| Variável | Uso |
|---|---|
| `SEARCH_PROVIDER` | Provedor de busca (`firecrawl`\|`tavily`\|`brave`\|`serper`, padrão `firecrawl`). |
| `SEARCH_API_KEY` | Chave do provedor de busca (precedência sobre `FIRECRAWL_API_KEY`). |
| `FIRECRAWL_API_KEY` | Busca (quando provider=firecrawl) + `web_extract`. |
| `GOOGLE_SHEETS_CLIENT_EMAIL` | Service account (leitura/escrita Sheets). Obrigatória para `sheets_*`. |
| `GOOGLE_SHEETS_PRIVATE_KEY` | Chave privada (`\n` escapado). Obrigatória para `sheets_*`. |

`googleapis` é peer opcional: import dinâmico em
`packages/agent-runtime/src/sheets-tools.ts`, sem dependência nova.
Credenciais somente via env `GOOGLE_*`. Nenhum `tool_result` inclui valores de env.

## Fallback sem chave

- Sem `SEARCH_PROVIDER` / `SEARCH_API_KEY` / `FIRECRAWL_API_KEY`:
  `web_search` / `web_extract` continuam disponíveis via provedor NATIVO
  (`web-native.ts`, sem chave e sem sandbox): busca na versão HTML do
  DuckDuckGo e extract por `fetch` + HTML → texto, com bloqueio de SSRF
  (loopback, rede privada, metadata de nuvem, inclusive após redirect).
  Com API configurada, a busca nativa ainda é tentada se a API falhar.
  Páginas com JS/login escalam para `navigate` + `browser_text` e, em
  último caso, desktop (`screenshot` / `click` / `type` / `key` / `scroll`).
- Sem `GOOGLE_SHEETS_*`: `isSheetsAvailable()` retorna `false` e
  `sheets_read` / `sheets_append` devolvem erro estruturado:
  `{"ok":false,"code":"needs_config","message":"Sheets indisponível: ..."}`.
- Sementes em `packages/shared/src/skill-seeds.ts` validam com
  `parseSkillRecipe` usando `availableTools` mock incluindo `web_*`.

## Orçamento default (cotas via `maxCallsPerTool`, sem sobrescrever o bot)

- `web_search`: 6 · `web_extract`: 12 (tetos de `click`/`screenshot` ficam na política do bot)
  (`RESEARCH_BUDGET_DEFAULTS` em `research-budget.ts`, fundido em `runComputerUse`).
- `softMaxSteps`: 24 (`BUDGET_SOFT_DEFAULT`) · `hardMaxSteps`: teto 100
  (`BUDGET_HARD_CAP`) · `maxWallMs`: 30 min · `extensionSteps`: 24.
- Contagem/idempotência no checkpoint existente (`toolCallCounts` + step
  records); nada em memória fora do run (resume/lease intactos).

## Sementes (packages/shared/src/skill-seeds.ts)

- `tool-escalation`: `web_search` → `web_extract` → `navigate` / `browser_text`.
- `browser-hygiene`: só `navigate` / `browser_*`; uma tarefa por vez,
  aguardar carregar, banner de cookies, preferir texto a captura,
  nunca usar resumo IA do buscador, reaproveitar sessão.
- `price-check`: `requiredTools [web_search, web_extract, browser_text]`;
  3–5 URLs de domínios diferentes, `web_extract` paralelo com
  `{store, product, price, currency, availability, url}`, tabela com data;
  preço vazio volta ao navegador.

Teste: `packages/shared/src/skill-seeds.test.ts` (`parseSkillRecipe` com mock `web_*`).

## Bloco SYSTEM_PROMPT — Parte D (aplicado)

`AGENTIC_RESEARCH_PROMPT` em `computer-use.ts`, anexado ao system quando
`origin !== "routine"`. Rotina não recebe o bloco nem `web_search` /
`web_extract` / `sheets_*` (fase 1). Sem menção a abas.

## O que ficou para a fase 2

- Multi-abas: `browser-session.mjs` / `server.mjs` / `control-client` /
  `docker-manager` + tools `browser_tab_*` (abrir, listar, alternar, fechar).
- Firecrawl self-hosted (alternativa a `FIRECRAWL_API_KEY` remota).
- Pesquisa em rotinas: hoje `origin === "routine"` stripa
  `list_routines` / `propose_routine` e recebe sufixo de modo execução;
  decidir se rotinas recebem `web_search` / `web_extract` / `sheets_*`
  ou seguem só com navegador.
