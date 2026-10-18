-- F14 — imagens. A base do artefato com dono (runId opcional, userId,
-- conversationId, índice) já veio da migration 20261001010000_artifact_owner.
-- Aqui entra só o que é novo, com guardas para aplicar em qualquer estado.

-- Anexos de imagem do usuário em cada mensagem do run.
ALTER TABLE "run_inputs" ADD COLUMN IF NOT EXISTS "attachmentsJson" JSONB;

-- Dono do artefato passa a ser chave estrangeira (RESTRICT, como bots.ownerId).
-- Linhas antigas com userId que não existe em "user" são zeradas antes da FK.
UPDATE "artifacts" SET "userId" = NULL
WHERE "userId" IS NOT NULL AND "userId" NOT IN (SELECT "id" FROM "user");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_userId_fkey') THEN
    ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
