-- Modo proativo do bot principal: lembretes agendados, registro de eventos e origem da rotina.
ALTER TABLE "routines" ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT 'user';

CREATE TABLE "bot_followups" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "conversationId" TEXT,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "requestedFor" TIMESTAMP(3) NOT NULL,
  "note" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'reminder',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "source" TEXT NOT NULL DEFAULT 'chat',
  "sourceRunId" TEXT,
  "runId" TEXT,
  "claimedUntil" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "doneAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_followups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_followups_status_dueAt_idx" ON "bot_followups"("status", "dueAt");
CREATE INDEX "bot_followups_botId_status_idx" ON "bot_followups"("botId", "status");
CREATE INDEX "bot_followups_userId_idx" ON "bot_followups"("userId");

CREATE TABLE "proactive_events" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "runId" TEXT,
  "detail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "proactive_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "proactive_events_botId_kind_createdAt_idx" ON "proactive_events"("botId", "kind", "createdAt");
