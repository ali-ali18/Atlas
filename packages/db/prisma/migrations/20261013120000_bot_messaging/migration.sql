-- Conversa entre bots: remetente na mensagem, bot principal e outbox de mensagens.
ALTER TABLE "conversation_messages"
  ADD COLUMN "fromBotId" TEXT,
  ADD COLUMN "fromBotName" TEXT,
  ADD COLUMN "botMessageId" TEXT;

ALTER TABLE "bots" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- No máximo um bot principal por dono.
CREATE UNIQUE INDEX "bots_one_primary_per_owner" ON "bots"("ownerId") WHERE "isPrimary" = true;

CREATE TABLE "bot_messages" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fromBotId" TEXT NOT NULL,
  "toBotId" TEXT NOT NULL,
  "fromConversationId" TEXT,
  "toConversationId" TEXT,
  "fromRunId" TEXT,
  "toRunId" TEXT,
  "wakeRunId" TEXT,
  "rootId" TEXT NOT NULL,
  "parentId" TEXT,
  "depth" INTEGER NOT NULL DEFAULT 1,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "replyContent" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "repliedAt" TIMESTAMP(3),
  CONSTRAINT "bot_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_messages_status_createdAt_idx" ON "bot_messages"("status", "createdAt");
CREATE INDEX "bot_messages_userId_rootId_idx" ON "bot_messages"("userId", "rootId");
CREATE INDEX "bot_messages_toRunId_idx" ON "bot_messages"("toRunId");
CREATE INDEX "bot_messages_fromBotId_idx" ON "bot_messages"("fromBotId");
CREATE INDEX "bot_messages_toBotId_status_idx" ON "bot_messages"("toBotId", "status");
