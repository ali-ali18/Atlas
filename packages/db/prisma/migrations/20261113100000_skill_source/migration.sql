-- AlterTable
ALTER TABLE "skill_docs" ADD COLUMN "sourceKind" TEXT,
ADD COLUMN "sourceSlug" TEXT,
ADD COLUMN "sourceVersion" TEXT,
ADD COLUMN "sourceHash" TEXT;
