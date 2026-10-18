-- Assinatura opcional no rodapé das escritas do bot no GitHub (padrão desligada).
ALTER TABLE "user_settings" ADD COLUMN "githubSignature" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_settings" ADD COLUMN "githubSignatureText" TEXT;
