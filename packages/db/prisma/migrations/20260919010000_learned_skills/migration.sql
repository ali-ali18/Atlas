CREATE TABLE "skills" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "botId" TEXT NOT NULL, "capabilityKey" TEXT NOT NULL,
 "enabled" BOOLEAN NOT NULL DEFAULT true, "shared" BOOLEAN NOT NULL DEFAULT false,
 "activeVersionId" TEXT, "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "skills_userId_botId_capabilityKey_key" ON "skills"("userId", "botId", "capabilityKey");
CREATE TABLE "skill_versions" (
 "id" TEXT PRIMARY KEY, "skillId" TEXT NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "number" INTEGER NOT NULL, "content" JSONB NOT NULL, "hash" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'draft', "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "skill_versions_skillId_number_key" ON "skill_versions"("skillId", "number");
CREATE UNIQUE INDEX "skill_versions_skillId_hash_key" ON "skill_versions"("skillId", "hash");
CREATE TABLE "skill_evidence" (
 "id" TEXT PRIMARY KEY, "versionId" TEXT NOT NULL REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "runId" TEXT NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "learningJobId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "skill_evidence_versionId_runId_key" ON "skill_evidence"("versionId", "runId");
CREATE TABLE "skill_evaluations" (
 "id" TEXT PRIMARY KEY, "versionId" TEXT NOT NULL REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "passed" BOOLEAN NOT NULL, "report" JSONB NOT NULL, "tokens" INTEGER NOT NULL DEFAULT 0,
 "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "skill_evaluations_versionId_createdAt_idx" ON "skill_evaluations"("versionId", "createdAt");
CREATE TABLE "skill_usages" (
 "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "versionId" TEXT NOT NULL REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "outcome" TEXT NOT NULL DEFAULT 'selected', "detail" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "skill_usages_runId_versionId_key" ON "skill_usages"("runId", "versionId");
CREATE TABLE "skill_learning_jobs" (
 "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "extractorVersion" TEXT NOT NULL, "userId" TEXT NOT NULL, "botId" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0, "maxAttempts" INTEGER NOT NULL DEFAULT 2,
 "tokens" INTEGER NOT NULL DEFAULT 0, "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "reservedTokens" INTEGER NOT NULL DEFAULT 0, "reservedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "budgetDay" TEXT, "leaseOwner" TEXT, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "skill_learning_jobs_runId_extractorVersion_key" ON "skill_learning_jobs"("runId", "extractorVersion");
CREATE INDEX "skill_learning_jobs_status_leaseUntil_idx" ON "skill_learning_jobs"("status", "leaseUntil");
CREATE TABLE "skill_learning_budgets" (
 "id" TEXT PRIMARY KEY, "tokens" INTEGER NOT NULL DEFAULT 0, "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
 "candidates" INTEGER NOT NULL DEFAULT 0
);
