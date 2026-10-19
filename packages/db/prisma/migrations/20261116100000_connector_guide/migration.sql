-- Guia de uso por conexão (MCP e API): texto curto, origem e sugestões pendentes do bot.
ALTER TABLE "mcp_connections" ADD COLUMN "guideMd" TEXT, ADD COLUMN "guideSource" TEXT, ADD COLUMN "guideUpdatedAt" TIMESTAMP(3), ADD COLUMN "guideSuggestionsJson" JSONB;
ALTER TABLE "api_connections" ADD COLUMN "guideMd" TEXT, ADD COLUMN "guideSource" TEXT, ADD COLUMN "guideUpdatedAt" TIMESTAMP(3), ADD COLUMN "guideSuggestionsJson" JSONB;
