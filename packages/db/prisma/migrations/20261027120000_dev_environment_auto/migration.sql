-- Ambientes de código automáticos: origem (manual | auto) e campos editados pelo usuário
-- (o agente não sobrescreve). Aditiva: só colunas novas com padrão.
ALTER TABLE "dev_environments" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "dev_environments" ADD COLUMN "userEditedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
