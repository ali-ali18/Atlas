-- "Volto depois" do motor v3 (harness v3, PR8a): retornos agendados por conversa.
-- Tabela nova e independente: api/worker antigos não a leem (compatível nos dois sentidos durante o deploy).
CREATE TABLE "conversation_returns" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "conversationId" TEXT NOT NULL,
    "sourceRunId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_returns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_returns_conversationId_status_idx" ON "conversation_returns"("conversationId", "status");
CREATE INDEX "conversation_returns_userId_idx" ON "conversation_returns"("userId");
