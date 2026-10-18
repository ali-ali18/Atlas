# @workspace/db

Prisma + Postgres para memória de sessão (conversas/mensagens) e fatos duráveis (`profile` | `log` | `note`).

## Setup local

```bash
docker compose up -d postgres
cp .env.example .env   # na raiz ou exporte DATABASE_URL
pnpm --filter @workspace/db db:migrate
```

## Comandos

| Comando | Descrição |
|--------|-----------|
| `pnpm --filter @workspace/db db:migrate` | Cria/aplica migrations em dev |
| `pnpm --filter @workspace/db db:migrate:deploy` | Aplica migrations (CI/prod) |
| `pnpm --filter @workspace/db db:generate` | Regenera o Prisma Client |

## TODO

- Busca semântica com **pgvector** sobre fatos e trechos de sessão (embeddings).
