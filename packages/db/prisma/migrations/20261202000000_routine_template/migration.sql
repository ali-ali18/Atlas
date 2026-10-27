-- Modelo de rotina ("daily_brief" = Seu dia). Coluna nula e aditiva: api e worker em versões diferentes
-- durante o deploy continuam lendo e gravando rotinas (a antiga simplesmente ignora o campo).
ALTER TABLE "routines" ADD COLUMN "template" TEXT;
