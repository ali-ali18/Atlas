-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "leaseGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "jobEnqueuedAt" TIMESTAMP(3);

-- AlterTable agent_steps
ALTER TABLE "agent_steps" ADD COLUMN IF NOT EXISTS "decisionIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_steps" ADD COLUMN IF NOT EXISTS "subIndex" INTEGER NOT NULL DEFAULT 0;

UPDATE "agent_steps" SET "decisionIndex" = "index", "subIndex" = 0;

DROP INDEX IF EXISTS "agent_steps_runId_index_key";

CREATE UNIQUE INDEX IF NOT EXISTS "agent_steps_runId_decisionIndex_subIndex_key"
  ON "agent_steps"("runId", "decisionIndex", "subIndex");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_steps_runId_idempotencyKey_key"
  ON "agent_steps"("runId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "agent_steps_runId_index_idx" ON "agent_steps"("runId", "index");

-- CreateTable
CREATE TABLE IF NOT EXISTS "run_inputs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'user',
    "content" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'steer',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "run_inputs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "run_inputs_runId_seq_key" ON "run_inputs"("runId", "seq");
CREATE INDEX IF NOT EXISTS "run_inputs_runId_status_idx" ON "run_inputs"("runId", "status");

ALTER TABLE "run_inputs" DROP CONSTRAINT IF EXISTS "run_inputs_runId_fkey";
ALTER TABLE "run_inputs" ADD CONSTRAINT "run_inputs_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
