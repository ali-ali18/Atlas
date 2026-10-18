-- Pull request da sessão de código (número, link, estado, branches e commit). Aditiva: só colunas opcionais.
ALTER TABLE "dev_sessions" ADD COLUMN "prNumber" INTEGER;
ALTER TABLE "dev_sessions" ADD COLUMN "prUrl" TEXT;
ALTER TABLE "dev_sessions" ADD COLUMN "prState" TEXT;
ALTER TABLE "dev_sessions" ADD COLUMN "prBase" TEXT;
ALTER TABLE "dev_sessions" ADD COLUMN "prHead" TEXT;
ALTER TABLE "dev_sessions" ADD COLUMN "prHeadSha" TEXT;
ALTER TABLE "dev_sessions" ADD COLUMN "prTitle" TEXT;
