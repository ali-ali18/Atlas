-- Configuração da prévia completa pelo bot. Tabela nova e independente (aditiva): api/worker antigos a ignoram.
CREATE TABLE "preview_setups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_setups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "preview_setups_userId_key" ON "preview_setups"("userId");
