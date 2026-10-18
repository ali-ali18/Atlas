-- Sessões de desenvolvimento do agente (container leve por sessão). Aditiva.
CREATE TABLE "dev_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "repo" TEXT,
  "branch" TEXT,
  "baseBranch" TEXT,
  "status" TEXT NOT NULL DEFAULT 'CREATING',
  "tier" TEXT NOT NULL DEFAULT 'small',
  "containerId" TEXT,
  "todos" JSONB,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dev_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dev_sessions_userId_status_idx" ON "dev_sessions"("userId", "status");
CREATE INDEX "dev_sessions_conversationId_idx" ON "dev_sessions"("conversationId");
CREATE INDEX "dev_sessions_status_lastActiveAt_idx" ON "dev_sessions"("status", "lastActiveAt");
