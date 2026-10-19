-- E-mail próprio por bot (provedor hospedado) e metadados das mensagens.
CREATE TABLE "bot_mailboxes" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openmail',
    "address" TEXT NOT NULL,
    "providerInboxId" TEXT NOT NULL,
    "secretsEnc" TEXT,
    "webhookSecretHash" TEXT NOT NULL,
    "allowedSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailySendLimit" INTEGER NOT NULL DEFAULT 20,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_mailboxes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_messages" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "fromAddr" TEXT NOT NULL,
    "toAddrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL DEFAULT '',
    "snippet" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'received',
    "conversationId" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_mailboxes_botId_key" ON "bot_mailboxes"("botId");
CREATE UNIQUE INDEX "bot_mailboxes_provider_providerInboxId_key" ON "bot_mailboxes"("provider", "providerInboxId");
CREATE INDEX "bot_mailboxes_userId_idx" ON "bot_mailboxes"("userId");
CREATE UNIQUE INDEX "email_messages_mailboxId_providerMessageId_key" ON "email_messages"("mailboxId", "providerMessageId");
CREATE INDEX "email_messages_mailboxId_createdAt_idx" ON "email_messages"("mailboxId", "createdAt");
CREATE INDEX "email_messages_mailboxId_direction_createdAt_idx" ON "email_messages"("mailboxId", "direction", "createdAt");
CREATE INDEX "email_messages_mailboxId_threadId_idx" ON "email_messages"("mailboxId", "threadId");

ALTER TABLE "bot_mailboxes" ADD CONSTRAINT "bot_mailboxes_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_mailboxes" ADD CONSTRAINT "bot_mailboxes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "bot_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
