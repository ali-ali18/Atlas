-- Licoes do bot (memoria procedural): itens curtos com contadores de utilidade, escopo e versoes.
-- Escrita a mao; o vetor segue o mesmo padrao de memory_entries (vector(1536), preenchido via SQL cru).
CREATE TABLE "bot_lessons" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT,
    "content" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "evidence" JSONB,
    "helpful" INTEGER NOT NULL DEFAULT 0,
    "harmful" INTEGER NOT NULL DEFAULT 0,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "rule" JSONB,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "bot_lessons_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_lessons_botId_status_idx" ON "bot_lessons"("botId", "status");
CREATE INDEX "bot_lessons_userId_botId_idx" ON "bot_lessons"("userId", "botId");

ALTER TABLE "bot_lessons" ADD CONSTRAINT "bot_lessons_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bot_lessons" ADD CONSTRAINT "bot_lessons_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
