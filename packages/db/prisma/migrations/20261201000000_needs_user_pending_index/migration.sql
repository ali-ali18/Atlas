-- Marcadores "precisa de você" (bot-link needs-user) ainda pendentes. O varredor de mensagens entre bots
-- procura esses marcadores a cada poucos segundos; sem índice, cada passo varria `conversation_messages`
-- inteira. Índice parcial: só as linhas pendentes entram (somem ao virar "resolved"), então fica minúsculo.
-- Os predicados precisam ser IGUAIS aos de `listPendingNeedsUserMarkers` (packages/db/src/bot-messages.ts).
CREATE INDEX IF NOT EXISTS "conversation_messages_needs_user_pending_idx"
  ON "conversation_messages" ("createdAt")
  WHERE "role" = 'bot-link'
    AND "content" LIKE '%"kind":"needs-user"%'
    AND "content" LIKE '%"status":"pending"%';
