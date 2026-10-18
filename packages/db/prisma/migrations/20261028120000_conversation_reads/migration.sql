-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN "sourceKind" TEXT,
ADD COLUMN "sourceLabel" TEXT,
ADD COLUMN "sourceAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "conversation_reads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,
    "lastReadMessageId" TEXT,
    "manualUnread" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_reads_userId_conversationId_key" ON "conversation_reads"("userId", "conversationId");

-- CreateIndex
CREATE INDEX "conversation_reads_conversationId_idx" ON "conversation_reads"("conversationId");

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: o histórico existente conta como lido (ninguém vê centenas de não lidas de uma vez).
INSERT INTO "conversation_reads" ("id", "userId", "conversationId", "lastReadAt", "updatedAt")
SELECT 'cr_' || md5(c."id" || c."userId"), c."userId", c."id", NOW(), NOW()
FROM "conversations" c
WHERE c."userId" IS NOT NULL;
