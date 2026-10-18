-- F5 — subagentes: run filho aponta para o run pai (delegate_task).
-- Filhos nascem sem conversationId, então não entram no índice
-- "um run ativo por conversa".
ALTER TABLE "agent_runs" ADD COLUMN "parentRunId" TEXT;

CREATE INDEX "agent_runs_parentRunId_idx" ON "agent_runs"("parentRunId");

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "agent_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
