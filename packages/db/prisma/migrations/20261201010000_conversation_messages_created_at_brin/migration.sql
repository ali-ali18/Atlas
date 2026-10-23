-- Varredura de resumo por inatividade: acha só as conversas com mensagem recente em vez de agregar a
-- tabela inteira a cada passada. BRIN porque as linhas entram em ordem de "createdAt" (índice minúsculo,
-- custo de escrita quase nulo).
CREATE INDEX IF NOT EXISTS "conversation_messages_createdAt_idx" ON "conversation_messages" USING BRIN ("createdAt");
