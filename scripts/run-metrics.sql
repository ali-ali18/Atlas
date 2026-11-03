-- Métricas de saúde dos runs do agente (E6 do motor v2). SOMENTE LEITURA: um único SELECT, nada é gravado.
--
-- Uso (Dokploy: terminal do container do Postgres, ou qualquer psql com acesso ao banco):
--   psql "$DATABASE_URL" -v days=7 -f scripts/run-metrics.sql
-- `days` = janela em dias (obrigatório; tente 7 e 30). Sem -v days o psql avisa e a consulta não roda.
--
-- Parada por contexto = `budget_context` (janela do modelo estourada; `context` também é aceito por segurança).
-- Uma linha por (origem, perfil) mais uma linha "TOTAL". O perfil vem de `budgetJson.engineProfile` (chat, long_work…),
-- gravado só pelo motor v2; run do motor anterior aparece como "(sem perfil)".
-- Só conta o run raiz já terminado (sem `parentRunId`: o ajudante de um run não é um run do usuário).
-- Custo: `usageJson.costUsd` (parcial quando `costUnknownCalls` > 0; run sem custo informado fica fora da média).
-- Passos: chamadas ao modelo registradas em `agent_steps` (type = 'model').

WITH finished AS (
	SELECT
		r."id",
		r."origin",
		coalesce(nullif(r."budgetJson"->>'engineProfile', ''), '(sem perfil)') AS "profile",
		r."stopReason",
		(r."stopReason" = 'answered' AND length(btrim(coalesce(r."resultText", ''))) > 0) AS "answered_ok",
		CASE WHEN jsonb_typeof(r."usageJson"->'costUsd') = 'number' THEN (r."usageJson"->>'costUsd')::float8 END AS "cost",
		(SELECT count(*) FROM "agent_steps" s WHERE s."runId" = r."id" AND s."type" = 'model') AS "steps"
	FROM "agent_runs" r
	WHERE r."createdAt" >= now() - make_interval(days => :days::int)
		AND r."parentRunId" IS NULL
		AND r."finishedAt" IS NOT NULL
),
grouped AS (
	SELECT "origin", "profile", "stopReason", "answered_ok", "cost", "steps" FROM finished
	UNION ALL
	SELECT 'TOTAL', 'TOTAL', "stopReason", "answered_ok", "cost", "steps" FROM finished
)
SELECT
	"origin" AS "origem",
	"profile" AS "perfil",
	count(*) AS "runs",
	round(100.0 * count(*) FILTER (WHERE "answered_ok") / count(*), 1) AS "pct_respondeu",
	count(*) FILTER (WHERE "stopReason" = 'answered') AS "n_answered",
	count(*) FILTER (WHERE "stopReason" IN ('budget_context', 'context')) AS "n_context",
	count(*) FILTER (WHERE "stopReason" = 'loop_repeat') AS "n_loop_repeat",
	count(*) FILTER (WHERE "stopReason" LIKE 'budget\_%') AS "n_budget",
	count(*) FILTER (WHERE "stopReason" = 'tool_failures') AS "n_tool_failures",
	count(*) FILTER (WHERE "stopReason" IS NULL) AS "n_sem_motivo",
	count(*) FILTER (WHERE "stopReason" IS NOT NULL AND "stopReason" NOT IN ('answered', 'context', 'loop_repeat', 'tool_failures') AND "stopReason" NOT LIKE 'budget\_%') AS "n_outros",
	round(avg("steps")::numeric, 1) AS "passos_media",
	round((percentile_cont(0.95) WITHIN GROUP (ORDER BY "steps"))::numeric, 1) AS "passos_p95",
	round(avg("cost")::numeric, 4) AS "custo_media_usd",
	round((percentile_cont(0.95) WITHIN GROUP (ORDER BY "cost"))::numeric, 4) AS "custo_p95_usd",
	round(100.0 * count(*) FILTER (WHERE "stopReason" IN ('budget_context', 'context')) / count(*), 1) AS "pct_context",
	round(100.0 * count(*) FILTER (WHERE "stopReason" = 'loop_repeat') / count(*), 1) AS "pct_loop_repeat"
FROM grouped
GROUP BY 1, 2
ORDER BY ("origin" = 'TOTAL'), count(*) DESC, 1, 2;
