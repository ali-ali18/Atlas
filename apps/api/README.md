# Atlas API (`apps/api`)

Serviço HTTP do Atlas. Nesta fatia inicial: health check e chat completion via [OpenRouter](https://openrouter.ai/) (API compatível com OpenAI).

**Framework:** [Hono](https://hono.dev/) — leve, tipado, roda bem no Node com `@hono/node-server`, sem boilerplate pesado.

## Variáveis de ambiente

Copie `.env.example` para `.env` em `apps/api`:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `OPENROUTER_API_KEY` | Sim (para `POST /v1/chat`) | Chave da OpenRouter |
| `OPENROUTER_MODEL` | Não | Modelo OpenRouter (padrão: `openai/gpt-4o-mini`) |
| `REDIS_URL` | Não | Redis para jobs async (padrão: `redis://127.0.0.1:6379`) |
| `DATABASE_URL` | Sim (memória) | Postgres (`postgresql://atlas:atlas@127.0.0.1:5432/atlas` no compose) |
| `PORT` | Não | Porta HTTP (padrão: `3001`) |
| `HOST` | Não | Interface HTTP (padrão: `127.0.0.1` em dev, `0.0.0.0` em produção) |
| `ATLAS_HOOK_PEPPER` | Em produção | Segredo estável para webhooks de rotinas |

## Desenvolvimento

Na raiz do monorepo:

```bash
pnpm install
# Para rodar API/worker fora do compose, inicie Postgres e Redis no host.
export DATABASE_URL=postgresql://atlas:atlas@127.0.0.1:5432/atlas
pnpm --filter @workspace/db db:migrate
pnpm --filter @workspace/shared build
pnpm --filter @workspace/db build
pnpm --filter @workspace/llm build
pnpm --filter @workspace/queue build
pnpm --filter api dev
pnpm --filter worker dev   # outro terminal — processa jobs async
```

Ou, após `pnpm build` na raiz, `pnpm --filter api start`.

## Endpoints

### `GET /health`

```json
{ "ok": true }
```

### `POST /v1/chat`

Corpo (tipos em `@workspace/shared`):

```json
{
  "messages": [
    { "role": "user", "content": "Olá!" }
  ],
  "model": "openai/gpt-4o-mini",
  "conversationId": "clxx..."
}
```

Com `conversationId`, a API carrega histórico recente + fatos `profile` e persiste user/assistant após a resposta.

Resposta:

```json
{
  "message": { "role": "assistant", "content": "..." },
  "model": "openai/gpt-4o-mini",
  "usage": {
    "promptTokens": 10,
    "completionTokens": 20,
    "totalTokens": 30
  }
}
```

Exemplo com `curl`:

```bash
curl -s http://localhost:3001/health
curl -s http://localhost:3001/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Diga oi em uma palavra."}]}'
```

### `POST /v1/chat/jobs`

Enfileira um job `chat.completion` (OpenRouter roda no **worker**, não na API). Resposta `202`:

```json
{ "jobId": "1", "queue": "atlas-chat", "name": "chat.completion" }
```

### `GET /v1/chat/jobs/:id`

```json
{
  "id": "1",
  "status": "completed",
  "result": { "message": { "role": "assistant", "content": "..." }, "model": "..." },
  "error": null
}
```

### Memória e conversas

| Método | Caminho | Descrição |
|--------|---------|-----------|
| `POST` | `/v1/conversations` | Cria `conversationId` |
| `GET` | `/v1/conversations/:id/messages` | Lista mensagens da sessão |
| `POST` | `/v1/conversations/:id/messages` | Persiste `{ role, content }` |
| `POST` | `/v1/memory/facts` | `{ content, tier, scope? }` |
| `GET` | `/v1/memory/facts` | `?tier=profile\|log\|note` |
| `DELETE` | `/v1/memory/facts` | `{ id }` ou `{ content, tier? }` (soft-delete) |

### Computer-use sandbox

Requer Docker socket no host do processo API e imagem `atlas-agent-sandbox:latest` (veja `docker/agent-sandbox`).

| Método | Caminho | Descrição |
|--------|---------|-----------|
| `POST` | `/v1/sandbox/sessions` | Cria sessão → `{ sessionId, viewerUrl, status }` |
| `GET` | `/v1/sandbox/sessions/:id` | Estado da sessão |
| `DELETE` | `/v1/sandbox/sessions/:id` | Para e remove o container |
| `POST` | `/v1/sandbox/sessions/:id/navigate` | `{ url }` — Playwright no container |
| `GET` | `/v1/sandbox/sessions/:id/screenshot` | PNG da página atual |

Env: `SANDBOX_*`, `DOCKER_SOCKET_PATH` — ver `.env.example`.

## Próximos passos

- pgvector / embeddings sobre fatos
- Integração do `apps/web` com esta API
