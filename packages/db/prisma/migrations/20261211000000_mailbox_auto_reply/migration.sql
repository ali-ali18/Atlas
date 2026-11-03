-- Liberação do dono para o bot responder e-mails recebidos sozinho (email_reply em run de e-mail).
-- Aditiva, com DEFAULT false (= exige aprovação): api/worker antigos ignoram a coluna e as caixas existentes
-- passam a pedir aprovação, que é o padrão desejado.
ALTER TABLE "bot_mailboxes" ADD COLUMN "autoReply" BOOLEAN NOT NULL DEFAULT false;
