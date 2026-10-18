-- Intenções pendentes de comandos de skill (uma por conversa, expiração curta).
CREATE TABLE IF NOT EXISTS "skill_pending_intents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "skill_pending_intents_conversationId_key" UNIQUE ("conversationId")
);
CREATE INDEX IF NOT EXISTS "skill_pending_intents_expiresAt_idx" ON "skill_pending_intents"("expiresAt");
