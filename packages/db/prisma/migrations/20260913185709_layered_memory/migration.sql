/*
  Warnings:

  - You are about to drop the `facts` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "facts";

-- DropEnum
DROP TYPE "FactTier";

-- CreateTable
CREATE TABLE "memory_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT 'default',
    "botId" TEXT,
    "target" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_entries_userId_botId_target_idx" ON "memory_entries"("userId", "botId", "target");
