-- CreateIndex
CREATE INDEX IF NOT EXISTS "run_events_runId_type_idx" ON "run_events"("runId", "type");
