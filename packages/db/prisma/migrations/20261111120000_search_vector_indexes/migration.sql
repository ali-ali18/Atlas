-- Índices de busca: texto das mensagens (GIN) e embeddings (HNSW, pgvector).
--
-- Por que CREATE INDEX comum e não CONCURRENTLY: o `prisma migrate deploy` executa o arquivo em
-- bloco único (transação implícita) e CREATE INDEX CONCURRENTLY não roda ali. O custo é um lock de
-- escrita na tabela durante a construção. Aqui é aceitável: o histórico de mensagens de uma
-- instalação pessoal/pequena indexa em segundos. Em base muito grande (milhões de linhas), crie os
-- índices à mão com CONCURRENTLY antes do deploy; o IF NOT EXISTS faz esta migration só reconhecê-los.

-- Mesma expressão usada por searchConversationMessages (to_tsvector('portuguese', content)).
CREATE INDEX IF NOT EXISTS "conversation_messages_content_fts_idx"
  ON "conversation_messages" USING GIN (to_tsvector('portuguese', "content"));

-- vector(1536) < 2000 dimensões (limite do HNSW); `<=>` é distância de cosseno => vector_cosine_ops.
-- Parcial (embedding IS NOT NULL): as consultas já filtram isso, e o índice não guarda linhas sem vetor.
CREATE INDEX IF NOT EXISTS "memory_entries_embedding_hnsw_idx"
  ON "memory_entries" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "skill_versions_embedding_hnsw_idx"
  ON "skill_versions" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;
