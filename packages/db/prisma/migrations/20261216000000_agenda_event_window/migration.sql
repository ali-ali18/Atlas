-- Motor v4 (F4, auditoria B4): teto diário de acordares por evento em cada item `intent`.
-- Só ADD COLUMN anulável ou com default constante. Código antigo ignora as colunas; item existente começa com a janela
-- fechada (contagem 0). Rollback seguro: as colunas podem ser removidas.
-- AlterTable
ALTER TABLE "bot_followups"
  ADD COLUMN "eventWindowAt" TIMESTAMP(3),
  ADD COLUMN "eventWindowCount" INTEGER NOT NULL DEFAULT 0;
