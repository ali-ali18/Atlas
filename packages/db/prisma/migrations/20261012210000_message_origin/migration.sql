-- Origem automatizada da mensagem (routine/webhook); NULL = conversa normal.
-- Nullable: linhas antigas continuam válidas e valem como conversa normal.
ALTER TABLE "conversation_messages" ADD COLUMN "origin" TEXT;

-- Backfill best-effort: a saída de uma rotina é gravada na mesma transação que
-- fecha o run, dentro de ~50 ms do finishedAt (medido no banco real).
UPDATE "conversation_messages" m
SET "origin" = r."origin"
FROM "agent_runs" r
WHERE r."conversationId" = m."conversationId"
  AND r."origin" IN ('routine', 'webhook')
  AND m."role" = 'assistant'
  AND r."finishedAt" IS NOT NULL
  AND m."createdAt" BETWEEN r."finishedAt" - interval '1 second' AND r."finishedAt" + interval '2 seconds';
