CREATE TABLE "ProviderConnection" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "provider" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'disconnected',
 "secretsEnc" TEXT,
 "oauthStateHash" TEXT,
 "accountEmail" TEXT,
 "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 "accessExpiresAt" TIMESTAMP(3),
 "lastError" TEXT,
 "lastLimitAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ProviderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProviderConnection_userId_provider_key" ON "ProviderConnection"("userId", "provider");
CREATE UNIQUE INDEX "ProviderConnection_oauthStateHash_key" ON "ProviderConnection"("oauthStateHash");
