-- GitHub App da instância, instalações por usuário e dedupe de entregas do webhook.
CREATE TABLE "github_app_configs" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "appId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "htmlUrl" TEXT,
    "clientId" TEXT NOT NULL,
    "ownerLogin" TEXT,
    "secretsEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_app_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_installations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'User',
    "repositorySelection" TEXT NOT NULL DEFAULT 'selected',
    "repositories" JSONB,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_app_deliveries" (
    "deliveryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_app_deliveries_pkey" PRIMARY KEY ("deliveryId")
);

CREATE UNIQUE INDEX "github_installations_installationId_key" ON "github_installations"("installationId");
CREATE INDEX "github_installations_userId_idx" ON "github_installations"("userId");
CREATE INDEX "github_app_deliveries_createdAt_idx" ON "github_app_deliveries"("createdAt");

ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
