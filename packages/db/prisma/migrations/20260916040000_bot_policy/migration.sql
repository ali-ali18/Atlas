-- Orçamento por bot (E3 mínimo): política de limites lida na resolução do budget.
-- Sem default: ausência = padrões globais.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "policyJson" JSONB;
