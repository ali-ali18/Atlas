# Atlas Worker (`apps/worker`)

Processador BullMQ do Atlas. Nesta fatia: jobs `chat.completion` na fila `atlas-chat` (chamada OpenRouter no worker, não na API).

## Variáveis de ambiente

Copie `.env.example` para `.env` em `apps/worker`:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `REDIS_URL` | Não | URL Redis (padrão: `redis://127.0.0.1:6379`) |
| ``DATABASE_URL` (quando o job inclui `conversationId`)

`OPENROUTER_API_KEY`` | Sim (para chat) | Chave OpenRouter |
| `OPENROUTER_MODEL` | Não | Modelo padrão se o job não enviar `model` |

## Desenvolvimento

Na raiz do monorepo, com Redis rodando (`docker compose up -d redis`):

```bash
pnpm install
pnpm --filter @workspace/shared build
pnpm --filter @workspace/llm build
pnpm --filter @workspace/queue build
pnpm --filter worker dev
```

Produção local: `pnpm --filter worker build && pnpm --filter worker start`.

## Computer-use sandbox

`src/sandbox.ts` reexporta `@workspace/sandbox` para futuros jobs BullMQ. No MVP, sessões e tools (`navigate`, `screenshot`) são expostas pela API; o worker só precisa do Docker socket quando esses jobs existirem.

## Logs

O worker registra início/fim/falha de cada job `chat.completion` no stdout.
