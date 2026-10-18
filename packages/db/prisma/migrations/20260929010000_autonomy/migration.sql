-- F10: política de autonomia do agente (padrão da conta + override por bot).
ALTER TABLE "user_settings" ADD COLUMN "autonomyJson" JSONB;
ALTER TABLE "bots" ADD COLUMN "autonomyJson" JSONB;

-- Dados: cada conector com `confirmWrites = false` vira uma exceção `never_ask`
-- (por catalogId, ou slug em conector personalizado) na política da conta do
-- dono. Quem tinha desligado a confirmação continua sem ser perguntado.
-- 1) garante a linha de configurações de quem precisa dela
INSERT INTO "user_settings" ("id", "userId", "sandboxAutoStart", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text || c."userId"), c."userId", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "userId" FROM "mcp_connections" WHERE "confirmWrites" = false
) c
WHERE EXISTS (SELECT 1 FROM "user" u WHERE u."id" = c."userId")
  AND NOT EXISTS (SELECT 1 FROM "user_settings" s WHERE s."userId" = c."userId");

-- 2) grava a política (nível Equilibrado = padrão de hoje) com as exceções
UPDATE "user_settings" s
SET "autonomyJson" = jsonb_build_object('level', 'balanced', 'exceptions', agg.exceptions)
FROM (
  SELECT "userId",
         jsonb_agg(jsonb_build_object('connector', COALESCE("catalogId", "slug"), 'mode', 'never_ask') ORDER BY "createdAt") AS exceptions
  FROM "mcp_connections"
  WHERE "confirmWrites" = false
  GROUP BY "userId"
) agg
WHERE s."userId" = agg."userId" AND s."autonomyJson" IS NULL;
