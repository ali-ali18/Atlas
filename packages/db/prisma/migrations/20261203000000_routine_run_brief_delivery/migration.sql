-- Estado de entrega do brief "Seu dia" (pending/posted/expired) e o texto enquanto pendente.
-- Colunas nulas e índice novo: aditivo. Api e worker em versões diferentes durante o deploy continuam
-- lendo e gravando routine_runs (a versão antiga ignora as colunas). Aplique a migration ANTES do worker novo.
ALTER TABLE "routine_runs" ADD COLUMN "briefStatus" TEXT;
ALTER TABLE "routine_runs" ADD COLUMN "briefText" TEXT;
-- Quando o push do brief saiu (reivindicado antes de enviar): a varredura nunca repete o aviso.
ALTER TABLE "routine_runs" ADD COLUMN "briefPushedAt" TIMESTAMP(3);
CREATE INDEX "routine_runs_briefStatus_createdAt_idx" ON "routine_runs"("briefStatus", "createdAt");
