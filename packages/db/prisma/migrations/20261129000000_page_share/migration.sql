-- CreateTable
CREATE TABLE "page_shares" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "page_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "page_shares_pageId_key" ON "page_shares"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "page_shares_tokenHash_key" ON "page_shares"("tokenHash");

-- AddForeignKey
ALTER TABLE "page_shares" ADD CONSTRAINT "page_shares_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

