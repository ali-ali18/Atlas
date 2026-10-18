-- CreateTable
CREATE TABLE "user_vault_keys" (
    "userId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "masterVer" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "user_vault_keys_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "user_secrets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'secret',
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "siteUrl" TEXT,
    "domain" TEXT,
    "username" TEXT,
    "valueEnc" TEXT NOT NULL,
    "sharedWith" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alwaysBots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "user_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_secret_audit" (
    "id" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "botId" TEXT,
    "botName" TEXT,
    "conversationId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_secret_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_secrets_userId_name_key" ON "user_secrets"("userId", "name");

-- CreateIndex
CREATE INDEX "user_secrets_userId_updatedAt_idx" ON "user_secrets"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "user_secret_audit_secretId_createdAt_idx" ON "user_secret_audit"("secretId", "createdAt");

-- CreateIndex
CREATE INDEX "user_secret_audit_userId_createdAt_idx" ON "user_secret_audit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "user_secret_audit" ADD CONSTRAINT "user_secret_audit_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "user_secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
