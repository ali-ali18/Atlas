# TIP-02: Tipagem Fraca de Campos JSON e Vetoriais (`pgvector`) no Prisma com Casts Inseguros

- **ID:** `TIP-02`
- **Agravante:** 4 (Baixo-Médio)
- **Categoria:** Tipagem / ORM / Integridade de Dados
- **Status:** Aberta para Correção

---

## 1. Arquivos Afetados

- `packages/db/src/memory-search.ts`
- `packages/db/src/skills-search.ts`
- `packages/db/src/memory-entries.ts`
- `packages/db/prisma/schema.prisma`

---

## 2. Descrição Técnica da Falha

Existem duas fragilidades de tipagem e integridade no acesso ao banco via Prisma:

1. **Vulnerabilidade de Interpolação no `pgvector`:**
   - O Prisma Client não oferece tipagem nativa para colunas do tipo `Unsupported("vector(1536)")`.
   - As consultas vetoriais são feitas via tagged template literals com `$queryRaw` e interpolação de strings manuais:
     ```ts
     function vectorLiteral(vector: number[]): string {
       return `[${vector.join(",")}]`;
     }
     await prisma.$executeRaw`UPDATE memory_entries SET embedding = ${vectorLiteral(vector)}::vector WHERE id = ${id}`;
     ```
   - Se por qualquer motivo `vector` for um array vazio `[]` ou contiver valores `NaN`/`Infinity`, a string resultante vira `[]::vector` ou `[NaN, 0.1]::vector`, provocando erro de sintaxe SQL no PostgreSQL e abortando a transação.
   - Não há validação em tempo de execução garantindo que o array de floats tenha exatamente o tamanho dimensional esperado (ex: 1536).

2. **Casts Inseguros de Colunas `Prisma.Json`:**
   - As colunas `checkpointJson`, `budgetJson`, `usageJson`, `policyJson` e `eventJson` retornam do Prisma como `Prisma.JsonValue` (`any` mascarado).
   - O código aplica asserções diretas sem validação:
     ```ts
     return row.checkpointJson as AgentRunCheckpoint;
     ```
   - Se o formato interno do JSON for modificado em uma atualização de versão do software, leituras de registros antigos causam falhas silenciosas ou crashes do tipo `Cannot read properties of undefined` no worker.

---

## 3. Impacto de Negócio e Segurança

- Falhas no armazenamento e busca semântica de memórias do agente.
- Quebra de execução ao tentar desserializar checkpoints antigos ou corrompidos.

---

## 4. Bibliotecas Externas Recomendadas

- **`zod`** para parsing e tipagem estrita de colunas JSON recuperadas do banco de dados.

---

## 5. Passos para Validação pelo QA

1. Inserir manualmente um embedding vazio no banco ou disparar busca com array malformado.
2. Inspecionar o log de erro retornado pelo PostgreSQL.
3. Verificar se o sistema trata o erro graciosamente ou se a requisição quebra com status `500/503`.

---

## 6. Plano de Ação e Remediação

1. **Validador Estrito de Vetor:**
   ```ts
   export function safeVectorLiteral(vector: number[], expectedDim = 1536): string {
     if (!Array.isArray(vector) || vector.length !== expectedDim || !vector.every(Number.isFinite)) {
       throw new Error(`Invalid embedding vector: expected ${expectedDim} finite numbers, received ${vector?.length}`);
     }
     return `[${vector.join(",")}]`;
   }
   ```
2. **Schema Parsing para JSONs do Banco:**
   ```ts
   export async function getAgentRunCheckpoint(runId: string): Promise<AgentRunCheckpoint | null> {
     const row = await prisma.agentRun.findUnique({
       where: { id: runId },
       select: { checkpointJson: true },
     });
     if (!row?.checkpointJson) return null;
     const parsed = AgentRunCheckpointSchema.safeParse(row.checkpointJson);
     return parsed.success ? parsed.data : null;
   }
   ```
