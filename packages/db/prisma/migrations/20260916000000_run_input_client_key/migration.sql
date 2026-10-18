-- AlterTable run_inputs: idempotencia de inputs (steer/queue)
ALTER TABLE "run_inputs" ADD COLUMN IF NOT EXISTS "clientKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "run_inputs_runId_clientKey_key" ON "run_inputs"("runId", "clientKey");
