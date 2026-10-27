-- Aprovação por tarefa: uma aprovação de escrita reversível vale para a mesma tool na mesma conversa (30 min, teto de usos, no máximo 2h desde a primeira aprovação; conteúdo externo lido depois invalida).
-- Tabela nova e aditiva: api e worker em versões diferentes durante o deploy continuam funcionando (a versão antiga não a usa).
CREATE TABLE "mcp_task_grants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "exposedName" TEXT NOT NULL,
  "confirmId" TEXT,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "maxUses" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "untrustedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "mcp_task_grants_conversationId_connectionId_exposedName_key" ON "mcp_task_grants"("conversationId", "connectionId", "exposedName");
CREATE INDEX "mcp_task_grants_userId_idx" ON "mcp_task_grants"("userId");
CREATE INDEX "mcp_task_grants_expiresAt_idx" ON "mcp_task_grants"("expiresAt");
ALTER TABLE "mcp_task_grants" ADD CONSTRAINT "mcp_task_grants_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
