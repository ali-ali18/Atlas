-- Motivo de término do run (F0 do ADR 0002: medir por que os runs terminam).
-- Aditiva e nula por padrão: api/worker antigos ignoram as colunas; runs anteriores ficam sem motivo.
-- Sem enum de banco (motivo novo não exige migration). Sem índice: CREATE INDEX sem CONCURRENTLY trava escrita em agent_runs no deploy e a consulta de 7 dias já filtra por createdAt.
ALTER TABLE "agent_runs" ADD COLUMN "stopReason" TEXT;
ALTER TABLE "agent_runs" ADD COLUMN "stopDetail" TEXT;
