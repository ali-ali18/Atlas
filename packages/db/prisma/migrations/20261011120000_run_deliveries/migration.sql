-- CreateTable
CREATE TABLE "run_deliveries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "outcome" TEXT,
    "summary" TEXT,
    "deliverAfter" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "seenAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_deliveries_runId_key" ON "run_deliveries"("runId");

-- CreateIndex
CREATE INDEX "run_deliveries_userId_seenAt_idx" ON "run_deliveries"("userId", "seenAt");

-- CreateIndex
CREATE INDEX "run_deliveries_status_dueAt_idx" ON "run_deliveries"("status", "dueAt");

-- CreateIndex
CREATE INDEX "run_deliveries_conversationId_idx" ON "run_deliveries"("conversationId");

-- AddForeignKey
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
