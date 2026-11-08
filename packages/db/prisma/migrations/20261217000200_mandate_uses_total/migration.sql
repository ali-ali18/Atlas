-- Motor v4 (auditoria F6, N2): o mandato guarda o total de usos original (teto da devolução) e uma revisão que sobe a cada
-- troca, para o gasto e a devolução de um uso valerem só para o mandato que o run viu.
-- Só ADD COLUMN com default: código antigo ignora as colunas. Rollback seguro: DROP COLUMN.
ALTER TABLE "purchase_mandates" ADD COLUMN "usesTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "purchase_mandates" ADD COLUMN "rev" INTEGER NOT NULL DEFAULT 0;
-- Linhas que já existem: o melhor teto conhecido é o que resta hoje.
UPDATE "purchase_mandates" SET "usesTotal" = "usesLeft" WHERE "usesTotal" = 0;
