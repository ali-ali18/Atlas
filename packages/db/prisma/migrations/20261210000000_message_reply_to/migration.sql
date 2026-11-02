-- Responder/citar uma mensagem do chat (app mobile).
-- Aditiva e nula por padrão: api/worker antigos ignoram a coluna; mensagens anteriores ficam sem resposta.
-- A FK é SET NULL: apagar a mensagem citada não apaga a resposta, só some o trecho citado.
-- O índice cobre a busca de respostas ao apagar uma mensagem (ou a conversa inteira, em cascata): sem ele cada
-- linha apagada varreria conversation_messages. Coluna 100% nula na criação, então o índice nasce minúsculo.
ALTER TABLE "conversation_messages" ADD COLUMN "replyToMessageId" TEXT;

CREATE INDEX "conversation_messages_replyToMessageId_idx" ON "conversation_messages"("replyToMessageId");

ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "conversation_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
