-- Por que os runs terminam? (F0 do ADR 0002: medir antes de redesenhar o motor.)
-- Somente leitura. Rodar contra o banco de produção (réplica, se houver). Ajuste `interval '7 days'`.
-- Colunas: agent_runs."stopReason" / "stopDetail" (migration 20261209000000_agent_run_stop_reason).
-- Vocabulário: RunStopReason em packages/shared/src/run-stop-reason.ts.
-- "Custo" vem de usageJson->>'costUsd'; duração = finishedAt - startedAt. Só runs terminados.

-- 1) Panorama: motivo x origem, com custo e duração médios e % do total.
SELECT
  coalesce(r."stopReason", '(sem motivo)')                                   AS stop_reason,
  r.origin,
  count(*)                                                                    AS runs,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)                          AS pct_do_total,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                         AS custo_medio_usd,
  round(sum((r."usageJson"->>'costUsd')::numeric), 2)                         AS custo_total_usd,
  round(avg(extract(epoch FROM (r."finishedAt" - r."startedAt")))::numeric, 1) AS duracao_media_s
FROM agent_runs r
WHERE r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL          -- só runs pai; subagentes têm a consulta 4
GROUP BY 1, 2
ORDER BY runs DESC;

-- 2) Por bot (mesmos números). Troque `b.name` por `r."botId"` se precisar de ids.
SELECT
  coalesce(r."stopReason", '(sem motivo)')                                   AS stop_reason,
  coalesce(b.name, '(sem bot)')                                               AS bot,
  count(*)                                                                    AS runs,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)                          AS pct_do_total,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                         AS custo_medio_usd,
  round(sum((r."usageJson"->>'costUsd')::numeric), 2)                         AS custo_total_usd,
  round(avg(extract(epoch FROM (r."finishedAt" - r."startedAt")))::numeric, 1) AS duracao_media_s
FROM agent_runs r
LEFT JOIN bots b ON b.id = r."botId"
WHERE r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
GROUP BY 1, 2
ORDER BY runs DESC
LIMIT 100;

-- 3) Qual trava mais encerra runs? Só o que NÃO é fim normal (answered / cancelado pelo usuário).
SELECT
  r."stopReason"                                                              AS stop_reason,
  r."stopDetail"                                                              AS detalhe,
  count(*)                                                                    AS runs,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)                          AS pct_das_travas,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                         AS custo_medio_usd,
  round(avg(extract(epoch FROM (r."finishedAt" - r."startedAt")))::numeric, 1) AS duracao_media_s
FROM agent_runs r
WHERE r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
  AND r."stopReason" IS NOT NULL
  AND r."stopReason" NOT IN ('answered', 'cancelled')
GROUP BY 1, 2
ORDER BY runs DESC;

-- 4) Subagentes (origin = 'subagent'): como os filhos terminam.
SELECT
  coalesce(r."stopReason", '(sem motivo)')                                   AS stop_reason,
  count(*)                                                                    AS runs,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)                          AS pct_do_total,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                         AS custo_medio_usd
FROM agent_runs r
WHERE r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r.origin = 'subagent'
GROUP BY 1
ORDER BY runs DESC;

-- 5) Runs ANTIGOS (anteriores à coluna, "stopReason" nulo): heurística pelo status + texto de `error`.
--    Espelha `inferStopReasonFromLegacy` (packages/shared/src/run-stop-reason.ts); é aproximada.
--    Use para ter uma linha de base retroativa, nunca para decisão fina.
SELECT
  CASE
    WHEN r.status = 'completed'                                                      THEN 'answered'
    WHEN r.status = 'cancelled'                                                      THEN 'cancelled'
    WHEN r.status = 'paused'                                                         THEN 'paused_login'
    WHEN r.status = 'waiting_user'                                                   THEN 'awaiting_confirmation'
    WHEN r.error ~* 'sem heartbeat|recuper(a|ou) .*vezes|recoveries'                 THEN 'crash_recoveries'
    WHEN r.error ~* 'falha ap[oó]s [0-9]+ tentativa'                                 THEN 'retries_exhausted'
    WHEN r.status = 'budget_exhausted' OR r.error ~* 'limite|teto|or[cç]amento|esgotad' THEN
      CASE
        WHEN r.error ~* 'custo|cost|\$'                  THEN 'budget_cost'
        WHEN r.error ~* 'tempo|rel[oó]gio|wall|minutos'  THEN 'budget_wall'
        WHEN r.error ~* 'tokens'                         THEN 'budget_tokens'
        WHEN r.error ~* 'janela|contexto|context'        THEN 'budget_context'
        WHEN r.error ~* 'passos|steps'                   THEN 'budget_steps'
        WHEN r.error ~* 'sem progresso|estagn|stalled'   THEN 'budget_stalled'
        ELSE 'other'
      END
    WHEN r.error ~* 'repet|loop|mesm[ao]'                                            THEN 'loop_repeat'
    WHEN r.error ~* 'cortada|truncad'                                                THEN 'truncated'
    WHEN r.error ~* 'falh(ou|as) .*(seguid|ferrament)|ferramenta.*falh'              THEN 'tool_failures'
    WHEN r.error ~* 'sem progresso|nenhum arquivo'                                   THEN 'no_progress'
    WHEN r.status = 'failed'                                                         THEN 'error'
    ELSE 'other'
  END                                                                                AS stop_reason_inferido,
  r.origin,
  count(*)                                                                           AS runs,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)                                 AS pct_do_total,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                                AS custo_medio_usd,
  round(avg(extract(epoch FROM (r."finishedAt" - r."startedAt")))::numeric, 1)       AS duracao_media_s
FROM agent_runs r
WHERE r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
  AND r."stopReason" IS NULL
GROUP BY 1, 2
ORDER BY runs DESC;
