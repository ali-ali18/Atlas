-- CreateTable
CREATE TABLE "skill_docs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_revisions" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_docs_userId_botId_idx" ON "skill_docs"("userId", "botId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_docs_userId_botId_name_key" ON "skill_docs"("userId", "botId", "name");

-- CreateIndex
CREATE INDEX "skill_revisions_userId_idx" ON "skill_revisions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_revisions_skillId_revision_key" ON "skill_revisions"("skillId", "revision");

-- AddForeignKey
ALTER TABLE "skill_docs" ADD CONSTRAINT "skill_docs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skill_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unicidade da skill de conta (botId nulo): o UNIQUE acima trata NULL como
-- distinto no Postgres, então duas skills de conta com o mesmo nome passariam.
-- Índice único parcial (funciona em qualquer versão; o PG16 do compose também
-- aceitaria NULLS NOT DISTINCT, mas o Prisma não o representa no schema).
CREATE UNIQUE INDEX "skill_docs_userId_name_account_key" ON "skill_docs"("userId", "name") WHERE "botId" IS NULL;
