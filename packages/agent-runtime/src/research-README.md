# Research — Parte B (`web_search` / `web_extract`)

Blocos novos, sem wiring no `computer-use.ts` (o integrador fará).

## Provedores (`web_search`)

Provedor plugável via `SEARCH_PROVIDER`: `firecrawl` (padrão) | `tavily` |
`brave` | `serper`. Valor desconhecido cai para `firecrawl`.

| Provedor  | Endpoint                    | Auth                          |
| --------- | --------------------------- | ----------------------------- |
| firecrawl | `POST /v1/search`           | `Authorization: Bearer <key>` |
| tavily    | `POST api.tavily.com/search`| `api_key` no corpo            |
| brave     | `GET res/v1/web/search`     | `X-Subscription-Token`        |
| serper    | `POST google.serper.dev`    | `X-API-KEY`                   |

`web_search({ query, num = 8 (1-10), locale = "pt-BR", recency? })`.
Timeout 15s. Erros estruturados (`WebSearchError`):
`blocked` | `needs_login` | `empty` | `timeout`, sempre com `escalateHint`.

## Extração (`web_extract`)

Sempre via Firecrawl cloud API:

- sem `schema`: `POST /v1/scrape` + `formats: ["markdown"]`;
- com `schema`: `POST /v1/extract` (+ `prompt` opcional).

`web_extract({ urls[] (máx. 5/chamada), schema?, prompt?, maxChars? = 8000 })`.
Lote em paralelo (`Promise.allSettled`, concorrência 3), ordem preservada.
Retorna por URL `{ url, title?, fetchedAt, content? | data?, truncated, error? }`;
conteúdo acima de `maxChars` ganha sufixo `[truncado...]` + `truncated: true`.
Erro por URL: `blocked` | `needs_login` | `empty` | `timeout` + `escalateHint`
(`"tente web_search com outra query"` para vazio; senão
`"escale para navegador navigate+browser_text, motivo: …"`).

## Envs

```sh
SEARCH_PROVIDER=firecrawl   # firecrawl | tavily | brave | serper
SEARCH_API_KEY=             # precedência sobre FIRECRAWL_API_KEY (busca)
FIRECRAWL_API_KEY=          # busca (provider=firecrawl) + extração
```

Sem chave, `isWebSearchAvailable()` / `isWebExtractAvailable()` retornam
`false` e o runtime usa o provedor nativo (`web-native.ts`: DuckDuckGo HTML
+ `fetch` com guarda SSRF); o navegador (`navigate` + `browser_text`) fica
para páginas com JS/login. Credenciais: só leitura de env, nunca logar.

## Orçamento (`research-budget.ts`)

`RESEARCH_BUDGET_DEFAULTS = { web_search: 6, web_extract: 12 }`. `mergeResearchBudget(policy?.maxCallsPerTool)`
preenche faltantes sem sobrescrever explícitos. O integrador aplica via
`resolveBudget()` / `buildStoredBudget`. Contagem/idempotência usam o
checkpoint existente (`toolCallCounts` + step records) — nada em memória fora
do run, nenhum store novo.
