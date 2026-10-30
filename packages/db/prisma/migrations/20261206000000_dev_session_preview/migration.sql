-- Prévia privada do projeto web da sessão de código. Só coluna nula, sem default nem backfill:
-- api e worker em versões diferentes durante o deploy seguem funcionando (a versão antiga não lê nem grava `preview`).
ALTER TABLE "dev_sessions" ADD COLUMN "preview" JSONB;
