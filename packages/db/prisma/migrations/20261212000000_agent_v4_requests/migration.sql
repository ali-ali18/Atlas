-- Motor v4 (F2.6): pedidos que esperam o dono (aprovação, handoff) e respostas a cartões de pergunta, por ACRÉSCIMO.
-- Só CREATE TABLE/INDEX e FK da tabela nova para `agent_runs`; nada existente muda, então api/worker de versões
-- diferentes convivem no deploy. Rollback seguro: a tabela pode ser apagada sem afetar nada que exista hoje.
-- CreateTable
CREATE TABLE "agent_v4_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "callId" TEXT,
    "toolName" TEXT,
    "payloadHash" TEXT,
    "state" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_v4_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_v4_requests_runId_idx" ON "agent_v4_requests"("runId");

-- CreateIndex
CREATE INDEX "agent_v4_requests_userId_conversationId_kind_state_idx" ON "agent_v4_requests"("userId", "conversationId", "kind", "state");

-- CreateIndex
CREATE UNIQUE INDEX "agent_v4_requests_userId_runId_kind_key_key" ON "agent_v4_requests"("userId", "runId", "kind", "key");

-- AddForeignKey
ALTER TABLE "agent_v4_requests" ADD CONSTRAINT "agent_v4_requests_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
