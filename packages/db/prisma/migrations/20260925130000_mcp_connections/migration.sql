-- CreateTable
CREATE TABLE "mcp_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT 'default',
    "catalogId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_auth',
    "secretsEnc" TEXT,
    "oauthStateHash" TEXT,
    "toolsCacheJson" JSONB,
    "disabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmWrites" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_connections_oauthStateHash_idx" ON "mcp_connections"("oauthStateHash");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_connections_userId_catalogId_key" ON "mcp_connections"("userId", "catalogId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_connections_userId_slug_key" ON "mcp_connections"("userId", "slug");

