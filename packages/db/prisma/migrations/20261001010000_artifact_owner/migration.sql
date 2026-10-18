-- F9/F14 — artefato com dono direto (arquivos gerados e imagens do usuário).
-- Aditiva: artefatos existentes (screenshots) ficam com userId nulo e o dono
-- continua derivado do run. runId passa a ser opcional (upload antes do run).
ALTER TABLE "artifacts" ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE "artifacts" ADD COLUMN "userId" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "conversationId" TEXT;

CREATE INDEX "artifacts_userId_kind_idx" ON "artifacts"("userId", "kind");
