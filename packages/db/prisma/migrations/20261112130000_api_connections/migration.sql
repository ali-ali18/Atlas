-- CreateTable
CREATE TABLE "api_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "specUrl" TEXT NOT NULL,
    "authKind" TEXT NOT NULL,
    "authJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_auth',
    "secretsEnc" TEXT,
    "oauthStateHash" TEXT,
    "catalogJson" JSONB NOT NULL,
    "groupsJson" JSONB NOT NULL,
    "allowedTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "operationCount" INTEGER NOT NULL DEFAULT 0,
    "rateLimitRps" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_connections_oauthStateHash_idx" ON "api_connections"("oauthStateHash");

-- CreateIndex
CREATE UNIQUE INDEX "api_connections_userId_slug_key" ON "api_connections"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_connections_userId_baseUrl_key" ON "api_connections"("userId", "baseUrl");

-- AddForeignKey
ALTER TABLE "api_connections" ADD CONSTRAINT "api_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
