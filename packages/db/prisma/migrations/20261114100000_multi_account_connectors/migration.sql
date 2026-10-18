-- Várias contas do mesmo conector: o slug (único por usuário) continua distinguindo as contas.
DROP INDEX "mcp_connections_userId_catalogId_key";
DROP INDEX "api_connections_userId_baseUrl_key";

ALTER TABLE "mcp_connections" ADD COLUMN "accountLabel" TEXT;
ALTER TABLE "api_connections" ADD COLUMN "accountLabel" TEXT;

CREATE INDEX "mcp_connections_userId_catalogId_idx" ON "mcp_connections"("userId", "catalogId");
CREATE INDEX "api_connections_userId_baseUrl_idx" ON "api_connections"("userId", "baseUrl");
