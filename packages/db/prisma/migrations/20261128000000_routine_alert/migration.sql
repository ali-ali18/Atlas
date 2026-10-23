-- Alerta por condição da rotina: configuração + estado da última verificação (debounce).
ALTER TABLE "routines" ADD COLUMN "alertJson" JSONB;
