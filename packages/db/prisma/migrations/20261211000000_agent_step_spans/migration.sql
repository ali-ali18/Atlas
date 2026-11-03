-- Tracing do harness v3 (PR3c): um "span" é uma linha de agent_steps com estas colunas preenchidas.
-- Aditiva e nula por padrão: api/worker antigos ignoram as colunas e passos anteriores ficam sem span.
-- Sem índice novo: CREATE INDEX sem CONCURRENTLY trava escrita em agent_steps no deploy; a leitura é sempre por runId.
ALTER TABLE "agent_steps" ADD COLUMN "kind" TEXT;
ALTER TABLE "agent_steps" ADD COLUMN "provider" TEXT;
ALTER TABLE "agent_steps" ADD COLUMN "model" TEXT;
ALTER TABLE "agent_steps" ADD COLUMN "cachedTokens" INTEGER;
ALTER TABLE "agent_steps" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "agent_steps" ADD COLUMN "ttftMs" INTEGER;
ALTER TABLE "agent_steps" ADD COLUMN "finishReason" TEXT;
ALTER TABLE "agent_steps" ADD COLUMN "policyDecision" TEXT;
