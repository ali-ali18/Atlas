# Atlas

Assistente pessoal completo (chat, ferramentas, memória, rotinas), com suporte a múltiplos agentes. Este repositório é um monorepo **pnpm** + **Turborepo**.

> **English:** Atlas is an open-source personal AI assistant (chat, tools, memory, routines, multiple agents) built as a pnpm + Turborepo monorepo.

**Licença:** [MIT](LICENSE). **Contribuir:** leia as regras em [`.agents/rules/`](.agents/rules/) (índice no [`AGENTS.md`](AGENTS.md)): commits em pt-BR no formato Conventional Commits, testes junto da mudança e um PR por assunto. Ideias e bugs entram como issues em [ali-ali18/Atlas](https://github.com/ali-ali18/Atlas/issues).

## Estrutura

| Caminho | Descrição |
|--------|-----------|
| `apps/web` | Interface Next.js (template shadcn/ui do bot) |
| `apps/api` | API HTTP (Hono + OpenRouter) — `POST /v1/chat`, SSE `POST /v1/chat/stream`, async `POST/GET /v1/chat/jobs` |
| `apps/worker` | Consumer BullMQ (Redis) — jobs `chat.completion` |
| `packages/llm` | Cliente OpenRouter compartilhado (API sync + worker) |
| `packages/queue` | Conexão Redis e filas BullMQ |
| `packages/ui` | Componentes shadcn/ui compartilhados |
| `packages/shared` | Tipos e contratos (eventos, nomes de jobs, memória) |
| `packages/db` | Prisma + Postgres (sessões, fatos duráveis) |
| `docker/agent-sandbox` | Imagem Docker (Xvfb, Chromium, noVNC, API de controle) |
| `packages/sandbox` | Lifecycle Docker (`createSession` / `destroySession`) e tools (`navigate`, `screenshot`) |

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) e Docker Compose v2 (caminho feliz)
- **Ou**, para desenvolvimento no host: Node.js ≥ 20 e [pnpm](https://pnpm.io/) 10.x

## Subir tudo com um comando (recomendado)

Na raiz do repositório:

```bash
cp .env.example .env
# Edite .env e defina OPENROUTER_API_KEY=sk-or-...
docker compose up --build
```

| Serviço | Porta no host | Função |
|--------|----------------|--------|
| `web` | [http://localhost:3000](http://localhost:3000) | UI Next.js |
| `api` | [http://localhost:3001](http://localhost:3001) | API Hono (`GET /health`) |
| `postgres` | 5432 | Memória Prisma |
| `redis` | 6379 | Filas BullMQ |
| `worker` | — | Consumer `chat.completion` |
| `migrate` | — | `prisma migrate deploy` (one-shot) |
| `agent-sandbox` | — | Só constrói a imagem `atlas-agent-sandbox:latest` |

O compose sobe Postgres e Redis com healthchecks, aplica migrações, constrói a imagem da sandbox, inicia API e worker e publica o web. Com `OPENROUTER_API_KEY` configurada, abra o web e use o chat (jobs async via Redis).

**Computer-use:** o serviço `api` monta `/var/run/docker.sock` para criar containers de sessão. Isso dá à API o mesmo poder que o daemon Docker no host — use só em ambiente local confiável (detalhes em [docker/agent-sandbox/README.md](docker/agent-sandbox/README.md)). Cada sessão publica portas **dinâmicas** no host para noVNC (viewer) e API de controle; o padrão é `127.0.0.1` — configure `SANDBOX_VIEWER_HOST=http://localhost` no `.env` para links no browser.

Parar: `docker compose down` (dados em volumes `postgres-data` / `redis-data`).

## Desenvolvimento no host (pnpm)

Na raiz do repositório:

```bash
pnpm install
pnpm dev          # sobe o app web (e outros pacotes com script dev)
pnpm --filter web dev   # apenas apps/web
pnpm --filter api dev   # API em http://localhost:3001
pnpm --filter worker dev   # consumer BullMQ (requer Redis + OPENROUTER_API_KEY no worker)
pnpm build        # build de todos os workspaces
pnpm lint
pnpm typecheck
```

App web em desenvolvimento: [http://localhost:3000](http://localhost:3000)

### Web (`apps/web`)

Copie `apps/web/.env.example` para `apps/web/.env.local` (opcional; o padrão é `http://127.0.0.1:3001`). O chat do template-4 usa `POST /v1/chat/stream` (SSE) para tokens em tempo real; jobs BullMQ continuam disponíveis para trabalho pesado/tooling.

Fluxo local completo (chat real via OpenRouter):

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgresql://atlas:atlas@127.0.0.1:5432/atlas
pnpm --filter @workspace/db db:migrate
# apps/api/.env e apps/worker/.env: OPENROUTER_API_KEY, DATABASE_URL, REDIS_URL
pnpm --filter api dev
pnpm --filter worker dev
pnpm --filter web dev
```

### API (`apps/api`)

Configure `OPENROUTER_API_KEY` (veja `apps/api/.env.example`), depois:

```bash
pnpm --filter api dev
```

Health: `GET http://localhost:3001/health`. Chat síncrono: `POST /v1/chat` (opcional `conversationId`). Chat assíncrono: enfileire com `POST /v1/chat/jobs` e consulte `GET /v1/chat/jobs/:id`. Memória: `POST/GET/DELETE /v1/memory/facts`, `POST /v1/conversations`, mensagens em `/v1/conversations/:id/messages`. Detalhes em [apps/api/README.md](apps/api/README.md), [packages/db/README.md](packages/db/README.md) e [apps/worker/README.md](apps/worker/README.md).

### Postgres + memória (dev)

Credenciais padrão do `docker-compose.yml`: usuário/senha/banco `atlas`.

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgresql://atlas:atlas@127.0.0.1:5432/atlas
pnpm --filter @workspace/db db:migrate
```

Configure `DATABASE_URL` em `apps/api/.env` e `apps/worker/.env` (veja `.env.example`).

### Redis + fila (dev)

```bash
docker compose up -d redis postgres
export REDIS_URL=redis://127.0.0.1:6379   # ou use apps/api/.env e apps/worker/.env
pnpm --filter api dev
pnpm --filter worker dev
```

Exemplo async:

```bash
JOB=$(curl -s -X POST http://localhost:3001/v1/chat/jobs \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Diga oi em uma palavra."}]}' | jq -r .jobId)
curl -s "http://localhost:3001/v1/chat/jobs/$JOB" | jq
```

## Memória durável (MVP)

- **Sessão**: mensagens por `conversationId` no Postgres (`packages/db`).
- **Fatos**: frases com `tier` = `profile` | `log` | `note` (soft-delete via API).
- Chat sync/async: com `conversationId`, o worker/API injeta fatos de perfil + histórico recente no contexto e persiste o turno (melhor esforço se o DB estiver indisponível).

### TODO

- **pgvector**: busca semântica sobre fatos e mensagens (embeddings) — ver [packages/db/README.md](packages/db/README.md).

## Computer-use sandbox (MVP)

Fundação estilo Cursor/Grok **computer-use**: container Docker com desktop stream (noVNC) e ferramentas mínimas via API.

**Pré-requisitos**

- Docker no host com socket montado no processo da API (`DOCKER_SOCKET_PATH`, padrão `/var/run/docker.sock`) — ver implicações de segurança em [docker/agent-sandbox/README.md](docker/agent-sandbox/README.md).
- Imagem: incluída em `docker compose up --build` (serviço `agent-sandbox`) ou `docker build -t atlas-agent-sandbox:latest docker/agent-sandbox`

**Fluxo**

```bash
# API com SANDBOX_ENABLED=true (padrão) e acesso ao Docker socket
SESSION=$(curl -s -X POST http://localhost:3001/v1/sandbox/sessions | jq -r .sessionId)
VIEWER=$(curl -s http://localhost:3001/v1/sandbox/sessions/$SESSION | jq -r .viewerUrl)
echo "Abra no browser: $VIEWER"
curl -s -X POST "http://localhost:3001/v1/sandbox/sessions/$SESSION/navigate" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' | jq
curl -s "http://localhost:3001/v1/sandbox/sessions/$SESSION/screenshot" -o /tmp/sandbox.png
curl -s -X DELETE "http://localhost:3001/v1/sandbox/sessions/$SESSION"
```

No app web, o painel de contexto (template-4) tem **Iniciar sandbox** / iframe do viewer quando a API está acessível.

**Limites (env)** — `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `SANDBOX_NETWORK_MODE`, `SANDBOX_VIEWER_HOST`.

**Futuro** — `click` / `type` / `scroll`, jobs no worker, isolamento por usuário, microVM.

## GitHub App

O agente usa um **GitHub App próprio** da instância (como o do Cursor): o dono cria o app **uma vez**, e cada pessoa só clica em **Instalar no GitHub**, escolhe os repositórios e autoriza. Sem webhook manual por repositório e com bem menos dependência do token pessoal (OAuth/PAT) de cada usuário.

### O que o dono faz (uma vez)

1. Configure `ATLAS_URL` (origem pública do web) e, se a API tiver outro endereço público, `ATLAS_PUBLIC_URL`. Precisa de `CONNECTOR_ENCRYPTION_KEY` (guarda as credenciais cifradas).
2. Entre como dono (`ATLAS_OWNER_EMAIL`), abra **Configurações > Conexões > GitHub** e clique em **Criar GitHub App** (opcional: nome do app e organização). O navegador vai ao GitHub com o manifest pronto; confirme lá.
3. O GitHub volta para `${ATLAS_URL}/v1/github-app/manifest/callback`, a API troca o `code` pelas credenciais e guarda App ID, slug, client ID/secret, webhook secret e chave privada **cifrados no banco**. Não há nada para copiar para variáveis de ambiente.

No Dokploy/Docker só é preciso ter as variáveis acima; nada específico do GitHub App. O webhook do app aponta sozinho para `${ATLAS_PUBLIC_URL ou ATLAS_URL}/v1/github-app/webhook` (por isso essa URL precisa ser alcançável pela internet, não `localhost`).

### O que cada pessoa faz

**Configurações > Conexões > GitHub > Instalar no GitHub** (ou o mesmo botão no cartão do GitHub no Marketplace): escolha a conta, os repositórios e autorize. Ao voltar, a instalação fica vinculada ao usuário (state assinado de 10 minutos + prova de OAuth de que a conta do GitHub enxerga a instalação). A tela mostra a conta, quantos repositórios e a lista, o status e **Gerenciar no GitHub**.

### O que muda para o agente

- **Token**: para repositórios cobertos pelo app, as leituras usam o token de instalação (JWT RS256 do app, escopado ao repositório, em cache até 5 min antes de expirar). Fora do app, cai no token pessoal (Marketplace) e depois no Composio.
- **Eventos**: um único webhook (`/v1/github-app/webhook`, `X-Hub-Signature-256`, dedupe por `X-GitHub-Delivery`) alimenta as rotinas com gatilho GitHub dos repositórios instalados, sem criar hook por repositório. Hooks antigos continuam funcionando e são ignorados quando o app cobre o repositório (sem disparo duplicado). Eventos `installation` e `installation_repositories` mantêm a lista de repositórios, suspensão e remoção.
- **Push e PR enriquecidos**: o push traz a lista **completa** de commits `before..after` (compare paginado: sha, primeira linha e mensagem limitada, autor, link, arquivos por commit) e o resumo de arquivos/linhas, sem patches; o total de commits passa a ser o real. O PR traz título, descrição limitada, contagem de commits e arquivos com +/-.
- **Tool `github_compare`** (repo, base, head, `includePatch` opcional até 20 arquivos): a lista completa de commits vem primeiro e compacta, então nunca é cortada pelo limite de tamanho de resultado.

### Variáveis (override para ops)

Opcionais; quando definidas, valem sobre o que está no banco: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, com `\n` literal ou em base64), `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`. Com essas variáveis o app é tratado como externo ("Remover app" fica indisponível).

### Problemas comuns

- **Entregas com 401 no GitHub (Advanced > Recent deliveries)**: o webhook secret do app não bate. Recrie o app pela tela ou corrija `GITHUB_APP_WEBHOOK_SECRET`.
- **Entregas com erro de conexão**: `ATLAS_PUBLIC_URL`/`ATLAS_URL` não são públicos ou o proxy não repassa `/v1/*`.
- **"A instalação não pertence à sua conta"**: o GitHub não devolveu a autorização do usuário; instale de novo e aceite a tela de autorização do app.
- **"O GitHub recusou a criação do app"**: o nome do app precisa ser único no GitHub; use outro.
- **Eventos não chegam**: confira se o repositório está na instalação (botão atualizar na tela) e se o app não está suspenso.
- **Trocar de URL pública**: edite a URL do webhook e as callback URLs em github.com/settings/apps, ou remova o app (Conexões) e crie de novo.

## Roadmap

- Cron/agendamentos
- Computer-use completo (tools no chat, quotas, microVM)

## Componentes shadcn/ui

Para adicionar componentes ao app web:

```bash
pnpm dlx shadcn@latest add button -c apps/web
```

Componentes vão para `packages/ui/src/components`.

Uso no app:

```tsx
import { Button } from "@workspace/ui/components/button";
```

## Qualidade, CI e releases

- **Testes:** `pnpm test` (tudo, exceto o que exige banco), `pnpm test:all` (sem db), `pnpm test:db` (db contra um Postgres+pgvector efêmero: sobe `pgvector/pgvector:pg16` numa porta livre aleatória, aplica as migrations do zero com smoke e roda os testes; precisa de Docker, ou `ATLAS_TEST_DB_URL` apontando para um banco cujo nome contenha `test`). Sem banco de teste, os testes de integração são pulados com mensagem.
- **E2E mobile:** `pnpm e2e` (Playwright, 390x844) sobe o app em modo dev numa porta livre e simula a API no navegador (`apps/web/e2e/mock-api.ts`). Primeira vez: `pnpm --filter web exec playwright install chromium`.
- **CI** (`.github/workflows/ci.yml`, push/PR para `main`): install, prisma generate, build das dependências, typecheck, testes de web/api/worker/packages, migrations do zero (smoke) e testes do db com service container pgvector. O job de E2E é manual (workflow_dispatch).
- **Release:** criar uma tag `v*` (ex.: `v0.1.0-beta`) roda o CI e cria o GitHub Release com o changelog (commits desde a tag anterior, agrupados por feat/fix/...). Tags com `-` viram pré-release. A versão exibida vem do `version` do `package.json` raiz; o commit é descoberto sozinho no build (lê `.git/HEAD`, a ref e `packed-refs`; `scripts/resolve-git-commit.mjs`). Sem `.git` no contexto, só a versão aparece.
- **Deploy:** o Dokploy faz autodeploy a cada push na `main`; o CI não faz deploy. Opção (não implementada): trocar o gatilho do Dokploy de "push" para "webhook" e chamar esse webhook de um job do CI que só roda quando os testes passam, para o deploy só acontecer com tudo verde.
- **Observabilidade:** `SENTRY_DSN` (opcional) liga o Sentry em api/worker/web; o commit do build marca a versão (release do Sentry e Diagnóstico). Configurações > Avançado > Diagnóstico mostra versões, saúde dos serviços, chaves (sim/não) e últimas falhas (`GET /v1/diagnostics`, só o dono).
