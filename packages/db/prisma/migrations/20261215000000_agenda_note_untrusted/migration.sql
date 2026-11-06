-- Motor v4 (F4, auditoria S1): a nota da agenda guarda se o run que a escreveu tinha lido conteúdo não confiável.
-- Só ADD COLUMN com default constante (Postgres 11+ não reescreve a tabela). Código antigo ignora a coluna; item já
-- existente fica `false` (comportamento anterior). Rollback seguro: a coluna pode ser removida.
-- AlterTable
ALTER TABLE "bot_followups" ADD COLUMN "noteUntrusted" BOOLEAN NOT NULL DEFAULT false;
