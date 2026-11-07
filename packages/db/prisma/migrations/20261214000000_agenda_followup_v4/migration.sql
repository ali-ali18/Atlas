-- Motor v4 (F4.1): agenda do agente sobre `bot_followups`, por ACRÉSCIMO.
-- Só ADD COLUMN anulável ou com default constante (o Postgres 11+ não reescreve a tabela). Api e worker de versões
-- diferentes convivem no deploy: o código antigo ignora as colunas (e só varre `agendaKind IS NULL` quando já tem o filtro);
-- o novo trata `agendaKind` nulo como lembrete/verificação do v2. Rollback seguro: as colunas e o índice podem ser removidos.
-- AlterTable
ALTER TABLE "bot_followups"
  ADD COLUMN "agendaKind" TEXT,
  ADD COLUMN "intervalMinutes" INTEGER,
  ADD COLUMN "untilAt" TIMESTAMP(3),
  ADD COLUMN "maxRuns" INTEGER,
  ADD COLUMN "runCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "eventFilterJson" JSONB,
  ADD COLUMN "noChangeStreak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastResultJson" JSONB,
  ADD COLUMN "lastNoticeAt" TIMESTAMP(3),
  ADD COLUMN "ignoredStreak" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "grantJson" JSONB,
  ADD COLUMN "endReason" TEXT;

-- CreateIndex
CREATE INDEX "bot_followups_userId_agendaKind_status_idx" ON "bot_followups"("userId", "agendaKind", "status");
