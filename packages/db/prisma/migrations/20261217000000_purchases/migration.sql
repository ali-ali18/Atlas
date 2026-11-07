-- F6.5: compras registradas (aditiva; api e worker de versões diferentes convivem).
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "conversationId" TEXT,
    "merchant" TEXT NOT NULL,
    "itemsJson" JSONB NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "orderNumber" TEXT,
    "trackingCode" TEXT,
    "trackingUrl" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "deliveryWatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchases_userId_dedupeKey_key" ON "purchases"("userId", "dedupeKey");
CREATE INDEX "purchases_userId_purchasedAt_idx" ON "purchases"("userId", "purchasedAt");
CREATE INDEX "purchases_userId_botId_idx" ON "purchases"("userId", "botId");

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
