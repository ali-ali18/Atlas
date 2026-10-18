-- Skill search: embedding pgvector para a versão ativa da skill.
-- Self-contained: garante a extensao para bancos novos.
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable skill_versions
ALTER TABLE "skill_versions" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
