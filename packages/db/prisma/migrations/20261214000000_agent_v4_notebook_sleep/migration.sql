-- Motor v4 (F5): caderno do dono e sono, por ACRÉSCIMO. Duas tabelas novas e duas colunas NULAS em `memory_changes`;
-- nada existente é alterado ou removido, então api/worker de versões diferentes convivem no deploy (a versão antiga
-- ignora as colunas e as tabelas) e o v2 segue idêntico.
-- Rollback seguro: as tabelas e as colunas podem ser apagadas sem afetar nada que exista hoje.

-- AlterTable
ALTER TABLE "memory_changes" ADD COLUMN "afterMeta" JSONB,
ADD COLUMN "reportId" TEXT;

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'owner',
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "detail" TEXT,
    "summary" TEXT,
    "proposalsJson" JSONB,
    "statsJson" JSONB,
    "windowEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sleep_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notes_userId_pinned_updatedAt_idx" ON "notes"("userId", "pinned", "updatedAt");

-- CreateIndex
CREATE INDEX "notes_userId_botId_updatedAt_idx" ON "notes"("userId", "botId", "updatedAt");

-- CreateIndex
CREATE INDEX "sleep_reports_userId_createdAt_idx" ON "sleep_reports"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_reports_botId_kind_slot_key" ON "sleep_reports"("botId", "kind", "slot");

-- CreateIndex
CREATE INDEX "memory_changes_userId_target_createdAt_idx" ON "memory_changes"("userId", "target", "createdAt");

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_reports" ADD CONSTRAINT "sleep_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
