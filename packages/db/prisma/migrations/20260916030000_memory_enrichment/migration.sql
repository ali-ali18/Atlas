-- Entrega Memoria M1: curadoria (metadados), embedding pgvector e resumos versionados.
-- Self-contained: garante a extensao para bancos novos.
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable memory_entries
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "importance" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "validUntil" TIMESTAMP(3);
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "access" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "memory_entries" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

CREATE INDEX IF NOT EXISTS "memory_entries_target_importance_idx" ON "memory_entries"("target", "importance");

-- CreateTable conversation_summaries
CREATE TABLE IF NOT EXISTS "conversation_summaries" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "rangeStart" TIMESTAMP(3),
    "rangeEnd" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "factsJson" JSONB,
    "snapshotVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "conversation_summaries_conversationId_version_idx" ON "conversation_summaries"("conversationId", "version");

ALTER TABLE "conversation_summaries" DROP CONSTRAINT IF EXISTS "conversation_summaries_conversationId_fkey";
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
