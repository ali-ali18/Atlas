-- Motivo de término do run (F0 do ADR 0002: medir por que os runs terminam).
-- Aditiva e nula por padrão: api/worker antigos ignoram as colunas; runs anteriores ficam sem motivo.
-- Sem enum de banco (motivo novo não exige migration). O índice é pequeno e serve à consulta de 7 dias por motivo.
ALTER TABLE "agent_runs" ADD COLUMN "stopReason" TEXT;
ALTER TABLE "agent_runs" ADD COLUMN "stopDetail" TEXT;
CREATE INDEX "agent_runs_stopReason_createdAt_idx" ON "agent_runs"("stopReason", "createdAt");
