-- CreateTable
CREATE TABLE "orchestrator_reflections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sinceAt" TIMESTAMP(3),
    "summary" TEXT,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "changesJson" JSONB,
    "statsJson" JSONB,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "orchestrator_reflections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orchestrator_reflections_userId_createdAt_idx" ON "orchestrator_reflections"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "orchestrator_reflections_status_createdAt_idx" ON "orchestrator_reflections"("status", "createdAt");
