-- Idioma automático do bot: último idioma detectado por conversa e por conta, mais o locale da conta/navegador.
-- Só colunas nuláveis, sem default nem backfill: api e worker em versões diferentes durante o deploy continuam funcionando
-- (a versão antiga não lê nem grava estas colunas). `bots.language` continua TEXT; "auto" é só um valor novo.
ALTER TABLE "conversations" ADD COLUMN "lastLanguage" TEXT;
ALTER TABLE "conversations" ADD COLUMN "pendingLanguage" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "lastLanguage" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "pendingLanguage" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "uiLocale" TEXT;
ALTER TABLE "user_settings" ADD COLUMN "browserLocale" TEXT;
