-- O índice único "run_events_runId_seq_key" já cobre ("runId", "seq"): o índice comum duplicado só custava
-- escrita (um evento por delta do stream) e espaço.
DROP INDEX IF EXISTS "run_events_runId_seq_idx";
