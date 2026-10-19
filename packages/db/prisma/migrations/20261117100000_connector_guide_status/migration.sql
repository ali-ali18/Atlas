-- Estado da geração do guia por conexão (visível na UI): status, erro curto e quando foi pedida.
ALTER TABLE "mcp_connections" ADD COLUMN "guideStatus" TEXT, ADD COLUMN "guideError" TEXT, ADD COLUMN "guideRequestedAt" TIMESTAMP(3);
ALTER TABLE "api_connections" ADD COLUMN "guideStatus" TEXT, ADD COLUMN "guideError" TEXT, ADD COLUMN "guideRequestedAt" TIMESTAMP(3);
