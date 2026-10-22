-- AlterTable
ALTER TABLE "routines" ADD COLUMN     "pageId" TEXT;

-- CreateIndex
CREATE INDEX "routines_pageId_idx" ON "routines"("pageId");

-- AddForeignKey
ALTER TABLE "routines" ADD CONSTRAINT "routines_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

