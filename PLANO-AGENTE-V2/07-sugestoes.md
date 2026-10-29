# F7 — Sugestões do revisor

Um commit por sugestão. As prioridades são **7.1** e **7.3**, as que mais devolvem a confiança no bot.

## 7.1 Eval de replay com conversas reais — Bot C
**Status:** a fazer · **Depende de:** nada (roda antes e depois de cada fase)
- [ ] `packages/agent-runtime/eval/cases/*.json`: casos tirados do banco, com o pedido, o contexto mínimo e as expectativas. Casos:
  - lembrete `once` 10h e 20h;
  - loja exemplo a cada 50 min;
  - criar planilha de preços;
  - pesquisar preço em 3 lojas;
  - "muda seu nome para X";
  - pergunta simples sem tool.
- [ ] Expectativas por caso: tools obrigatórias e proibidas, nenhum questionário, nenhum "não consigo" sem tool tentada (regex), máximo de N passos.
- [ ] Script `pnpm --filter @workspace/agent-runtime eval`:
  - modo `mock` (padrão, CI) com respostas gravadas;
  - modo `live` (`EVAL_LIVE=1`, usa o OpenRouter e os conectores reais em modo read-only).
  - Saída: tabela de aprovado/reprovado e um score, gravados em `eval/results/<data>.json`.
- **Aceite:** rodar antes da F1 (baseline) e depois de cada merge. O score sobe.

## 7.2 Painel de saúde das tools — Bot A
**Status:** a fazer
- [ ] `GET /v1/admin/tool-stats?days=7`: agregação de `agent_steps` (tool, total, falhas, último erro), mais os erros finais de `agent_runs` agrupados. Escopado ao usuário.
- [ ] Card "Saúde" no Marketplace: taxa de falha por conector, com vermelho acima de 20%.
- **Aceite:** mostra os números da consulta do README.

## 7.3 Teste do conector ao conectar + status real no prompt — Bot A (+ texto do C)
**Status:** a fazer
- [ ] Depois do OAuth ou da API key, uma chamada read-only barata por catálogo: `list_calendars`, GitHub `get_me`, Drive `list_recent_files` limitado a 1, Sheets metadata sem arquivo → só o token, Firecrawl `search` com limite 1.
- [ ] Guardar ok ou erro em `mcp_connections.lastError` e mostrar na UI ("Conectado · testado agora" / "Conectado, mas: <erro>").
- [ ] `connectorsPrompt` (texto do C) inclui o status real de cada conector, para o agente nunca dizer "não está conectado" quando está (e vice-versa).
- **Aceite:** reconectar o GitHub mostra "testado agora", e o agente cita o conector certo.

## 7.4 Erro de tool padronizado — Bot B
**Status:** a fazer · **Depende de:** F4
- [ ] Um formato único para o modelo: `{ code, message, hint }`, com `code ∈ not_connected | no_permission | not_found | rate_limited | timeout | invalid_args | unavailable | internal`.
- [ ] Mapear na saída de `executeTool` (MCP, Google, sandbox, builtin).
- [ ] Avisar o Bot C em `REVIEW.md` para ensinar a reação a cada `code` no prompt (F6).
- **Aceite:** os testes de mapeamento cobrem os erros reais da tabela da F4.

## 7.5 Tools read-only em paralelo — Bot B
**Status:** a fazer · **Depende de:** F4
- [ ] Quando o modelo pede várias tools no mesmo passo e **todas** são read-only (MCP read-only, `web_search`, `web_extract`, `memory_search`), rodar com `Promise.all` (limite de 4). O resto continua sequencial (`computer-use.ts:4095`).
- [ ] A ordem dos `tool_result` e o checkpoint e idempotência são preservados.
- **Aceite:** teste com mock mostra sobreposição de tempo; resultados na ordem dos pedidos.
