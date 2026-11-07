-- Motor v4 (F6.2 e F6.4): cartão salvo no cofre (sem CVV) e mandato de compra.
-- Só CREATE TABLE: código antigo ignora as tabelas. Rollback seguro: DROP TABLE.
-- CreateTable
CREATE TABLE "saved_cards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "secretsEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_mandates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maxAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "merchants" TEXT[],
    "until" TIMESTAMP(3) NOT NULL,
    "usesLeft" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_cards_userId_createdAt_idx" ON "saved_cards"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_mandates_userId_key" ON "purchase_mandates"("userId");

-- AddForeignKey
ALTER TABLE "saved_cards" ADD CONSTRAINT "saved_cards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_mandates" ADD CONSTRAINT "purchase_mandates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
