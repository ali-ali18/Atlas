-- Motor v4 (F1.12): store do agente por ACRÉSCIMO. Só CREATE TABLE/INDEX e FKs das tabelas novas para `agent_runs`;
-- nenhuma tabela ou coluna existente é alterada ou removida, então api/worker de versões diferentes convivem no deploy
-- e o v2 segue idêntico. O checkpoint do v4 usa `agent_runs."checkpointJson"` (chave `v4`), sem coluna nova.
-- Rollback seguro: as tabelas podem ser apagadas sem afetar nada que exista hoje.
-- CreateTable
CREATE TABLE "agent_journal_entries" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_receipts" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "location" TEXT,
    "externalId" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_notes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_notes_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "agent_conversation_offers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_conversation_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_conversation_declined" (
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_conversation_declined_pkey" PRIMARY KEY ("userId","conversationId","label")
);

-- CreateIndex
CREATE INDEX "agent_journal_entries_runId_idx" ON "agent_journal_entries"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_journal_entries_userId_runId_idempotencyKey_key" ON "agent_journal_entries"("userId", "runId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "agent_receipts_userId_runId_createdAt_idx" ON "agent_receipts"("userId", "runId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_receipts_runId_idx" ON "agent_receipts"("runId");

-- CreateIndex
CREATE INDEX "agent_notes_userId_pinned_updatedAt_idx" ON "agent_notes"("userId", "pinned", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_conversation_offers_userId_conversationId_position_idx" ON "agent_conversation_offers"("userId", "conversationId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "agent_conversation_offers_userId_conversationId_cardId_key" ON "agent_conversation_offers"("userId", "conversationId", "cardId");

-- AddForeignKey
ALTER TABLE "agent_journal_entries" ADD CONSTRAINT "agent_journal_entries_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_receipts" ADD CONSTRAINT "agent_receipts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

