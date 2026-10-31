-- Marcação de ferramentas de conector pelo dono ("read" | "write" por tool).
-- Aditiva e nula por padrão: api/worker antigos ignoram a coluna; código novo sem valor usa o padrão atual (sem anotação = escrita).
ALTER TABLE "mcp_connections" ADD COLUMN "toolMarksJson" JSONB;
