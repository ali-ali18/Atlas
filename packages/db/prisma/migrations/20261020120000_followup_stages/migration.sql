-- Avisos (etapas) de um mesmo lembrete: [{ at, firedAt }]. Nulo = aviso único em "dueAt" (lembretes antigos).
ALTER TABLE "bot_followups" ADD COLUMN "stages" JSONB;
