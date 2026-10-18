-- Grupos de bots: turnos (fala a rotear) e fila sequencial de respostas dos membros.
CREATE TABLE "group_turns" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'routing',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "group_turns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "group_turns_status_createdAt_idx" ON "group_turns"("status", "createdAt");
CREATE INDEX "group_turns_groupId_createdAt_idx" ON "group_turns"("groupId", "createdAt");

CREATE TABLE "group_replies" (
  "id" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "depth" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT NOT NULL,
  "triggerBotId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "runId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "group_replies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "group_replies_status_createdAt_idx" ON "group_replies"("status", "createdAt");
CREATE INDEX "group_replies_groupId_status_idx" ON "group_replies"("groupId", "status");
CREATE INDEX "group_replies_turnId_idx" ON "group_replies"("turnId");
CREATE INDEX "group_replies_runId_idx" ON "group_replies"("runId");

-- Membros de um grupo ficam em bots.memberIds; busca "grupos que contêm o bot X".
CREATE INDEX "bots_memberIds_idx" ON "bots" USING GIN ("memberIds");
