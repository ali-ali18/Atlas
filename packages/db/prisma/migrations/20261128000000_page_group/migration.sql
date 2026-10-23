-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "groupId" TEXT;

-- CreateIndex
CREATE INDEX "pages_groupId_idx" ON "pages"("groupId");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "routine_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
