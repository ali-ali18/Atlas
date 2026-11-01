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
  -- `auto_continue`: o worker retomou o run sozinho (budget_steps com continuação); não foi um fim de verdade.
  count(*) FILTER (WHERE r."stopDetail" = 'auto_continue')                    AS continuados,
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

-- 3) Qual trava mais encerra runs? Só o que NÃO é fim normal (answered / cancelado pelo usuário) nem retomada automática.
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
  -- Retomado sozinho pelo worker: o run continuou em outro run, então não conta como trava que encerrou.
  AND coalesce(r."stopDetail", '') <> 'auto_continue'
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

-- =====================================================================================================
-- PILOTO DO MOTOR V2 (F4): comparar o motor atual (v1) e o novo (v2) no mesmo bot, depois de alguns dias.
-- O motor do run fica em agent_runs."budgetJson"->>'engine' ('v2'; o v1 não grava, então NULL = v1) e o perfil em
-- "budgetJson"->>'engineProfile' ('chat' | 'long_work'). Troque `<BOT>` pelo nome do bot (ex.: 'Radar de Mercado')
-- e `interval '7 days'` pelo período. Só runs pai (parentRunId nulo) e terminados; somente leitura.
-- Veja docs/ops/piloto-motor-v2.md para ler os números.
-- =====================================================================================================

-- 6) Taxa de conclusão por motor e perfil: "answered" (fim normal) contra cada trava. Tarefa longa = long_work no v2;
--    no v1 não há perfil, então compare o v1 inteiro com o v2 em long_work e com o v2 em chat.
SELECT
  coalesce(r."budgetJson"->>'engine', 'v1')                                            AS motor,
  coalesce(r."budgetJson"->>'engineProfile', '-')                                      AS perfil,
  count(*)                                                                             AS runs,
  count(*) FILTER (WHERE r."stopReason" = 'answered')                                  AS answered,
  round(100.0 * count(*) FILTER (WHERE r."stopReason" = 'answered') / count(*), 1)     AS pct_answered,
  count(*) FILTER (WHERE r."stopReason" LIKE 'budget\_%')                              AS parou_por_orcamento,
  count(*) FILTER (WHERE r."stopReason" IN ('loop_repeat', 'loop_stall_guard', 'tool_failures', 'no_progress', 'budget_stalled')) AS travas_de_repeticao,
  count(*) FILTER (WHERE r."stopReason" = 'awaiting_confirmation')                     AS esperando_usuario,
  count(*) FILTER (WHERE r.status = 'failed')                                          AS falhou
FROM agent_runs r
JOIN bots b ON b.id = r."botId"
WHERE b.name = '<BOT>'
  AND r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
  AND r.origin = 'chat'
GROUP BY 1, 2
ORDER BY 1, 2;

-- 7) Custo e duração por tarefa: média, mediana e p90 (US$ e segundos) por motor e perfil.
SELECT
  coalesce(r."budgetJson"->>'engine', 'v1')                                                     AS motor,
  coalesce(r."budgetJson"->>'engineProfile', '-')                                               AS perfil,
  count(*)                                                                                       AS runs,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                                            AS custo_medio_usd,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (r."usageJson"->>'costUsd')::numeric))::numeric, 4)  AS custo_mediana_usd,
  round((percentile_cont(0.9) WITHIN GROUP (ORDER BY (r."usageJson"->>'costUsd')::numeric))::numeric, 4) AS custo_p90_usd,
  round(sum((r."usageJson"->>'costUsd')::numeric), 2)                                            AS custo_total_usd,
  round(avg(extract(epoch FROM (r."finishedAt" - r."startedAt")))::numeric, 1)                   AS duracao_media_s,
  round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (r."finishedAt" - r."startedAt"))))::numeric, 1) AS duracao_p90_s
FROM agent_runs r
JOIN bots b ON b.id = r."botId"
WHERE b.name = '<BOT>'
  AND r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."startedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
  AND r.origin = 'chat'
  AND r."usageJson" ? 'costUsd'
GROUP BY 1, 2
ORDER BY 1, 2;

-- 8) Custo dos ajudantes dentro das tarefas do v2 (runs filhos origin = 'subagent' do bot): quanto do gasto vai para eles.
SELECT
  coalesce(p."budgetJson"->>'engine', 'v1')                                          AS motor_do_pai,
  count(DISTINCT p.id)                                                               AS tarefas_com_ajudantes,
  count(*)                                                                           AS ajudantes,
  round(avg((c."usageJson"->>'costUsd')::numeric), 4)                                AS custo_medio_por_ajudante_usd,
  round(sum((c."usageJson"->>'costUsd')::numeric), 2)                                AS custo_total_ajudantes_usd
FROM agent_runs c
JOIN agent_runs p ON p.id = c."parentRunId"
JOIN bots b ON b.id = p."botId"
WHERE b.name = '<BOT>'
  AND c.origin = 'subagent'
  AND p."createdAt" >= now() - interval '7 days'
GROUP BY 1
ORDER BY 1;

-- 9) Perguntas ao usuário: cartões de questionário gravados por run (mede "pergunta demais"), e quantos runs
--    terminaram com uma pergunta no texto final. Menos é melhor, desde que a tarefa tenha sido entregue.
SELECT
  coalesce(r."budgetJson"->>'engine', 'v1')                                          AS motor,
  count(*)                                                                           AS runs,
  count(*) FILTER (WHERE q.n > 0)                                                    AS runs_com_questionario,
  coalesce(sum(q.n), 0)                                                              AS questionarios,
  count(*) FILTER (WHERE last_msg.content ~ '\?\s*[*_)"''»]*\s*$')                   AS runs_que_terminaram_perguntando,
  round(100.0 * count(*) FILTER (WHERE last_msg.content ~ '\?\s*[*_)"''»]*\s*$') / count(*), 1) AS pct_terminaram_perguntando
FROM agent_runs r
JOIN bots b ON b.id = r."botId"
LEFT JOIN LATERAL (
  SELECT count(*) AS n FROM conversation_messages m WHERE m."runId" = r.id AND m.role = 'questionnaire'
) q ON true
LEFT JOIN LATERAL (
  SELECT m.content FROM conversation_messages m WHERE m."runId" = r.id AND m.role = 'assistant' ORDER BY m."createdAt" DESC LIMIT 1
) last_msg ON true
WHERE b.name = '<BOT>'
  AND r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
  AND r.origin = 'chat'
GROUP BY 1
ORDER BY 1;

-- 10) Documentos gerados: runs que terminaram com arquivo (artifacts kind = 'file'). O v2 entrega relatório longo em documento.
SELECT
  coalesce(r."budgetJson"->>'engine', 'v1')                                          AS motor,
  count(*)                                                                           AS runs,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM artifacts a WHERE a."runId" = r.id AND a.kind = 'file')) AS runs_com_documento,
  round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM artifacts a WHERE a."runId" = r.id AND a.kind = 'file')) / count(*), 1) AS pct_com_documento
FROM agent_runs r
JOIN bots b ON b.id = r."botId"
WHERE b.name = '<BOT>'
  AND r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
  AND r.origin = 'chat'
  AND coalesce(r."budgetJson"->>'engineProfile', 'long_work') = 'long_work'  -- só tarefa longa (no v1 não há perfil: entra tudo)
GROUP BY 1
ORDER BY 1;

-- 11) Como as tarefas do v2 terminam (motivo e detalhe): "budget_cost/delivered" = estourou o orçamento e entregou
--     o que tinha; "answered/tasklist_open" = terminou com itens da lista descartados ("não deu para confirmar").
SELECT
  r."stopReason"                                                                      AS stop_reason,
  coalesce(r."stopDetail", '-')                                                       AS detalhe,
  count(*)                                                                            AS runs,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1)                                  AS pct,
  round(avg((r."usageJson"->>'costUsd')::numeric), 4)                                 AS custo_medio_usd
FROM agent_runs r
JOIN bots b ON b.id = r."botId"
WHERE b.name = '<BOT>'
  AND r."budgetJson"->>'engine' = 'v2'
  AND r."createdAt" >= now() - interval '7 days'
  AND r."finishedAt" IS NOT NULL
  AND r."parentRunId" IS NULL
GROUP BY 1, 2
ORDER BY runs DESC;
