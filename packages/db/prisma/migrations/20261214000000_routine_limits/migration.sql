-- Limites por rotina do motor v3 (harness v3, PR8b): { maxSteps?, maxCostUsd? } por execução.
-- Coluna nova e anulável: api/worker antigos não a leem (compatível nos dois sentidos durante o deploy).
ALTER TABLE "routines" ADD COLUMN "limitsJson" JSONB;
