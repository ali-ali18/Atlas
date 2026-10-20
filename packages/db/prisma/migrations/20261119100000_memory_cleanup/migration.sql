-- Limpeza da memória com aprovação: sugestões pendentes (apagar/fundir) e estado da revisão, por bot.
ALTER TABLE "bots" ADD COLUMN "memoryCleanupJson" JSONB, ADD COLUMN "memoryCleanupStatus" TEXT, ADD COLUMN "memoryCleanupError" TEXT, ADD COLUMN "memoryCleanupRequestedAt" TIMESTAMP(3);
