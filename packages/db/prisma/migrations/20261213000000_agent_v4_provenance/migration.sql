-- Motor v4 (auditoria F2, C1): sinais de proveniência do run numa coluna pequena, por ACRÉSCIMO.
-- Só ADD COLUMN anulável, sem default e sem reescrita da tabela: api/worker de versões diferentes convivem no deploy
-- (o código antigo ignora a coluna; o novo trata nulo como "sem sinal"). Rollback seguro: a coluna pode ser removida.
-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN "v4Provenance" JSONB;
