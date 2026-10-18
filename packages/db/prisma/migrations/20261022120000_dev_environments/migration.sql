-- Ambientes de código por repositório (comandos, recursos, internet, segredos selados). Aditiva.
CREATE TABLE "dev_environments" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "repo" TEXT NOT NULL,
  "installCommand" TEXT,
  "startCommand" TEXT,
  "tier" TEXT NOT NULL DEFAULT 'small',
  "network" TEXT NOT NULL DEFAULT 'allowlist',
  "allowlist" TEXT[],
  "secrets" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dev_environments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dev_environments_userId_repo_key" ON "dev_environments"("userId", "repo");
CREATE INDEX "dev_environments_userId_idx" ON "dev_environments"("userId");
