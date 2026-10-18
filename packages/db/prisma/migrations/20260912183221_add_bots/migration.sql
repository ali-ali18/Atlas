-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "snippet" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#fafafa',
    "description" TEXT,
    "openRouterModel" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinOrder" INTEGER,
    "memberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bots_conversationId_key" ON "bots"("conversationId");

-- CreateIndex
CREATE INDEX "bots_pinned_pinOrder_idx" ON "bots"("pinned", "pinOrder");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
