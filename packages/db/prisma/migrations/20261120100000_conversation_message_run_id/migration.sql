-- Mensagens que um run grava na conversa (falas do assistente e cartoes) apontam para o run: o proximo turno separa o que ja esta na conversa gravada do run do que veio de fora. Sem backfill.
ALTER TABLE "conversation_messages" ADD COLUMN "runId" TEXT;
