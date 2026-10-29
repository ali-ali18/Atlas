# Atlas — Plano: autenticação, auditoria das tools e busca própria

> Gerado em 2026-09-27 a partir de auditoria do código (`file:line` referem-se ao estado do commit `7937f55`).

## 1. Diagnóstico: como está hoje

**Não existe autenticação.** Qualquer um que alcance a porta da API (3001) é "o usuário".

- API sem middleware de auth (`apps/api/src/index.ts:66-86` só registra CORS; rotas montadas sem guarda em `:98-115`).
- `userId` é constante `"default"` espalhada pelo código: `routes/mcp.ts:46`, `routes/routines.ts:31`, `routes/github.ts:16`, `routes/skills.ts:12`, `routes/memory.ts:118`, `chat/skill-intent.ts:54`, `chat/memory.ts:142`; e defaults `?? "default"` no db (`runs.ts:207`, `mcp-connections.ts:107,118,164,192`, `memory-entries.ts`, `memory-search.ts`).
- Web sem login, sessão ou cookie; `atlasFetch` (`apps/web/lib/atlas-api.ts:63-83`) só manda `Content-Type`; 3 `fetch` crus fora dele (`:342`, `:647`, `:893`). "Ana · Plano pessoal" é hardcoded (`chat-sidebar/chat-sidebar-footer.tsx:65,104,111-113`).
- **Não há modelo `User`.** `userId` é `String` solto (sem FK) em MemoryEntry, AgentRun, Skill*, Routine, McpConnection. **Bot, Section, Conversation e UserSettings (singleton `id="default"`) não têm dono.**
- Queries sem escopo de usuário (viram IDOR com mais de um usuário): `bots.ts` (list/update/delete/get*), `conversations.ts` (tudo por `conversationId`), `sections.ts`, `runs.ts` (get/cancel/pause/resume/events/inputs), `mcp-connections.ts` (`getMcpConnection`, `update`, `delete` por id), `routines.ts` (`createRoutine` valida o bot só por id; `listRoutineRuns`), `artifacts.ts:38`.
- Streams (`GET /v1/runs/:id/stream`, `/events`, `/v1/chat/jobs/:id`): basta saber o `runId`; cada conexão faz polling no DB a cada 80 ms.
- OAuth dos conectores: o `state` amarra a **linha** da conexão, não o usuário/sessão (`routes/mcp.ts:500-549`).

### Riscos concretos (ordem de gravidade)
1. Controle total por quem alcança a API: runs (gasta crédito OpenRouter), sandbox (click/type/navigate — e `docker.sock` montado na API/worker ⇒ controle do host), ler/apagar conversas, memória, bots, rotinas.
2. Uso dos conectores já logados (Gmail, Drive, GitHub…) como o dono; adicionar/remover/reautorizar conectores; listar repos com o token guardado.
3. Adicionar "usuários" sem isolar dados não resolve: Bot/Conversation/Section/Settings sem dono + lookups por id.
4. Infra: Postgres `atlas/atlas` e Redis sem senha publicados; `ATLAS_HOOK_PEPPER` com fallback hardcoded (`packages/db/src/routines.ts:26,77-79`); `/health` expõe config.

## 2. Decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Biblioteca | ✅ **Better Auth** (decidido) com adapter Prisma, servida pela API (Hono) | TypeScript nativo, roda em Hono e Next, gera as tabelas no Prisma, sessões por cookie, OAuth social e plugins. O plugin `organization` cobre o "grupo" do futuro sem trocar de biblioteca. |
| Contas | ✅ **Uma conta só por agora** (decidido); grupo no futuro | Ver "Conta única" abaixo. |
| Métodos de login | ✅ **GitHub + Google + e-mail (magic link)** (decidido), sem senha | OAuth social reaproveita apps que já existem; magic link (plugin `magicLink` do Better Auth) cobre quando não quiser usar conta social. Envio de e-mail modular — ver §3.3. |
| Deploy | ✅ **Nosso `docker-compose.yml`**: VPS via Dokploy e também no PC (decidido) | Ver §3.1. |
| Apps OAuth | ✅ Os mesmos para login e conectores | Ver §3.2. |
| Quem pode entrar | Só o dono: `ATLAS_OWNER_EMAIL` | Cadastro fechado; qualquer outro e-mail é recusado no callback do login. |

### Conta única agora, grupo depois
- **Agora:** um único `User`. Cadastro desligado (`disableSignUp` / hook `before` que recusa e-mail ≠ `ATLAS_OWNER_EMAIL`). O primeiro login do dono reivindica todos os dados `"default"` (backfill da Fase 1).
- **Pronto para grupo sem retrabalho:** todo recurso ganha `userId` com FK (dono/criador) — isso já é necessário agora. Nada de `teamId` ainda.
- **Quando virar grupo:** ativar o plugin `organization` do Better Auth (Organization, Member, Invitation), adicionar `organizationId` em Bot/Section/Routine/McpConnection com backfill para uma org pessoal do dono, e trocar os filtros `where: { userId }` por um helper único `scopeFor(session)` — por isso a Fase 2 já deve centralizar o escopo nesse helper em vez de espalhar `userId` pelas rotas.
| Transporte da sessão | **Cookie httpOnly, SameSite=Lax, same-origin** via rewrite do Next (`/v1/*` e `/api/auth/*` → API) | Evita CORS com credenciais e cookie cross-site; o browser só fala com a origem do web. SSE continua funcionando (fetch). |
| Login ≠ conector | Login pede só identidade (`read:user user:email` / `openid email profile`); os escopos de `repo`, Gmail etc. continuam no Marketplace | Separação de privilégio: sair do app não revoga conectores, e o login não carrega escopos perigosos. Pode exigir apps OAuth separados (GitHub OAuth App aceita 1 callback base — callbacks precisam ser subpaths dele). |

## 3. Fases

### 3.1 Deploy: mesmo compose na VPS (Dokploy) e no PC
Tudo é configurado por **uma variável só**, `ATLAS_URL` (URL base pública). O resto deriva dela: `BETTER_AUTH_URL`, callbacks OAuth (login e conectores), `ATLAS_PUBLIC_URL` dos webhooks e as origens confiáveis. Nada de domínio fixo no código.

- **Só o `web` fica exposto; ele encaminha para a API.** O Next faz rewrite de `/v1/*` e `/api/auth/*` para `http://api:3001` na rede interna do compose. Assim o browser só fala com uma origem, o cookie de sessão é do próprio site (`HttpOnly`, `SameSite=Lax`, `Secure` quando `ATLAS_URL` é https) e não há CORS com credenciais. Funciona igual na VPS e no PC. (Verificar na Fase 3 que o SSE do `/v1/runs/:id/stream` passa pelo rewrite sem buffer; se não passar, usar o roteamento por caminho do Dokploy/Traefik para mandar `/v1` direto à API.)
- **`NEXT_PUBLIC_API_URL` sai:** o front usa caminhos relativos (`/v1/...`), então a mesma imagem serve para qualquer domínio.
- **Rede interna para o resto:** `api`, `worker`, `postgres`, `redis` e `searxng` sem `ports:` publicadas.
- **`docker.sock`:** a sandbox precisa dele. Colocar um `docker-socket-proxy` liberando só as chamadas do `packages/sandbox`, em vez do socket cru na API e no worker.

**Na VPS com Dokploy** (o Dokploy já traz Traefik com HTTPS automático — não precisa de Caddy):
1. DNS: registro `A` de `atlas.seudominio.com` → IP da VPS.
2. No Dokploy, criar o app do tipo *Docker Compose* apontando para o repositório.
3. Na aba *Domains*, adicionar o domínio **no serviço `web`**, porta `3000`, HTTPS com Let's Encrypt.
4. Na aba *Environment*, `ATLAS_URL=https://atlas.seudominio.com` + os segredos.
5. Nos apps OAuth do GitHub/Google, callback no domínio (ver §3.2).
Atenção: IP de datacenter é mais bloqueado pelos buscadores que o SearXNG consulta (§5).

**No PC de quem roda localmente:** `ATLAS_URL=http://localhost:3000`, `docker compose up`, sem domínio. Login funciona: magic link sem SMTP sai no log; GitHub/Google aceitam callback em `localhost` (cada pessoa cria seus próprios apps OAuth). O que **não** funciona sem URL pública: webhooks do GitHub. Para isso, profile opcional `tunnel` com `cloudflared` e `ATLAS_URL` apontando para o túnel.

### 3.2 Apps OAuth: um por provedor, compartilhado entre login e conectores
O Better Auth cuida do fluxo de login, mas **não cria o app OAuth**: ele precisa de um Client ID/Secret registrado no GitHub e no Google — os mesmos tipos de credencial que o Marketplace já usa (`GITHUB_OAUTH_*`, `GOOGLE_OAUTH_*`). Decisão: **reaproveitar os mesmos apps**.
- Login usa `/api/auth/callback/{github|google}`; conectores usam `/v1/mcp/oauth/callback`.
- **Google:** cadastrar as duas URLs em "Authorized redirect URIs".
- **GitHub OAuth App** aceita uma única "Authorization callback URL", mas qualquer subcaminho dela vale. Cadastrar a raiz (`https://atlas.seudominio.com/`) cobre as duas.
- Escopos continuam separados: o login pede só identidade (`read:user user:email` / `openid email profile`); os escopos de repositório/Gmail etc. só são pedidos ao conectar no Marketplace.

### 3.3 E-mail modular (magic link agora, Resend no futuro)
Novo pacote `packages/mail` com uma interface única, `sendMail({ to, subject, html, text })`, e drivers escolhidos por **uma variável**, `MAIL_URL`:

| `MAIL_URL` | Driver | Uso |
|---|---|---|
| vazio ou `log://` | **log** | Imprime o e-mail (e o link) no log da API. Padrão no PC/dev. |
| `smtp://usuario:senha@host:587` / `smtps://…:465` | **smtp** (`nodemailer`) | Qualquer SMTP: Gmail com senha de app, Brevo, Mailjet, SMTP2GO… |
| `resend://<API_KEY>` | **resend** | Futuro. Mesmo contrato; trocar é só mudar a variável. |

Mais `MAIL_FROM` (ex.: `Atlas <atlas@seudominio.com>`). O Better Auth só chama `sendMail`; nenhum código conhece o provedor.

Opções gratuitas para agora (sem Resend):
- **Gmail SMTP com senha de app** — o mais simples para conta única: exige verificação em 2 etapas na conta Google; `smtps://seu.email%40gmail.com:SENHA_DE_APP@smtp.gmail.com:465`. Limite ~500/dia. O remetente será o seu Gmail.
- **Brevo** — plano grátis com ~300 e-mails/dia via SMTP, permite remetente no seu domínio (com verificação de DNS).
- Alternativas: Mailjet (~200/dia), SMTP2GO (~1000/mês).

### Fase 0 — Endurecimento imediato (antes da auth, 1 dia)
- Bind da API em `127.0.0.1` por padrão quando `NODE_ENV!=production`; Postgres/Redis sem porta publicada no `docker-compose.yml` (ou com senha).
- Remover fallback de `ATLAS_HOOK_PEPPER` (falha no boot se ausente em produção).
- `/health` só `{ok:true}` para não autenticado.
- Rate limit simples por IP nos webhooks e no stream.

### Fase 1 — Modelo de dados
- Tabelas do Better Auth: `User`, `Session`, `Account`, `Verification` (via `npx @better-auth/cli generate` → **usar `pnpm dlx`**).
- `ownerId`/`userId` com FK para `User` em: `Bot`, `Section`, `UserSettings` (vira 1:1 com User; sai o singleton `"default"`), e FK nos que já têm `userId` (MemoryEntry, AgentRun, Skill*, Routine, McpConnection). `Conversation` herda o dono via `Bot`.
- Migração de backfill: criar o usuário dono no primeiro login permitido e reatribuir tudo que é `"default"` para o id dele (script idempotente `pnpm --filter @workspace/db migrate:claim-default`). Remover os `@default("default")`.

### Fase 2 — API
- Montar o handler do Better Auth em `/api/auth/*` (Hono).
- Middleware `requireUser` em todo `/v1/*`, exceto: `POST /v1/hooks/*` (auth própria por HMAC/secret), `GET /v1/mcp/oauth/callback` (ver abaixo), `GET /health`.
- Trocar todas as constantes `DEFAULT_USER_ID`/`"default"` por `c.get("user").id`; remover defaults `?? "default"` no `packages/db` (tornar `userId` obrigatório na assinatura).
- Centralizar em `scopeFor(session)` (hoje devolve `{ userId }`; no futuro `{ organizationId }`) — as rotas e o db nunca montam o filtro na mão.
- **Escopo por usuário em todas as queries** da lista do §1 (bots, conversations, sections, runs, mcp-connections, routines, artifacts): toda leitura/escrita por id passa a ser `where: { id, userId }` (ou via join no Bot). Checklist por arquivo + teste de IDOR para cada rota (usuário B recebe 404 em recurso do A).
- Streams: exigir sessão e verificar dono do run antes de abrir; limitar conexões simultâneas por usuário.
- OAuth de conector: gravar `userId` junto do `state`; no callback, conferir que a sessão atual é do mesmo usuário (ou, se o popup não carrega cookie, ao menos que a linha pertence ao usuário que iniciou).
- Webhook GitHub: continua roteando por repo, mas cada rotina só dispara para o dono dela (já é por rotina) — revisar para não vazar `lastWebhookAt` entre usuários.

### Fase 3 — Web (Next 16)
- **Ler `node_modules/next/dist/docs/` antes** (AGENTS.md: esta versão tem breaking changes; `middleware.ts` pode ter virado `proxy.ts`).
- Rewrites `/v1/*` e `/api/auth/*` → API; `NEXT_PUBLIC_API_URL` deixa de ser usado no browser.
- Página `/login` com "Entrar com GitHub" / "Entrar com Google"; `proxy`/middleware redireciona não autenticado para `/login`.
- `atlasFetch` + os 3 `fetch` crus com `credentials: "same-origin"`; tratar 401 globalmente (redirect para login).
- Rodapé da sidebar com nome/avatar reais e "Sair".

### Fase 4 — Worker e agente
- Jobs já leem `userId` da linha do run/rotina — manter, removendo os fallbacks `"default"` (`agent-run.ts:98,112`, `processors/routine.ts:24,290`).
- Passar `ctx.userId` para as tools `memory` / `memory_search` (hoje só `botId` → cai em `"default"`) e filtrar `session_search` por usuário (hoje busca em todas as conversas).
- Settings (`sandboxAutoStart` etc.) por usuário.

### Fase 5 — Testes e verificação
- Testes de IDOR por rota; teste de middleware (401 sem sessão, webhooks isentos); teste do backfill.
- Manual: login com GitHub → ver só os próprios bots; outro e-mail fora da allowlist → bloqueado; curl sem cookie em `/v1/bots` → 401.

## 4. Auditoria das tools: funcionam ou são ilustrativas?

Legenda: ✅ funciona · ⚙️ funciona com config · ⚠️ parcial/bug · 🎭 ilustrativa

### 4.1 Tools nativas do agente (29) — `packages/agent-runtime/src/computer-use.ts`

Nenhuma tem handler falso/mock; todo schema tem `case` e vice-versa. Exceção real: `sheets_*`.

| Tool | Status | Observação |
|---|---|---|
| screenshot, navigate, click, type, key, scroll, browser_click, browser_type, browser_text, browser_links | ⚙️ | Sandbox Docker (`atlas-agent-sandbox:latest`, presente localmente) + Docker Desktop rodando. Somem se `sandboxAutoStart=false`. Se `SANDBOX_ENABLED=false` mas o setting estiver ligado, são oferecidas e retornam erro "sandbox desativado". |
| web_search | ✅ | Sem chave usa scrape do DuckDuckGo (frágil: rate limit/captcha). Com `SEARCH_API_KEY`/`FIRECRAWL_API_KEY` usa provedor pago. Nenhuma chave configurada hoje. |
| web_extract | ✅ | Sem `FIRECRAWL_API_KEY` é fetch simples; o modo estruturado (`schema`) é ignorado. |
| **sheets_read / sheets_append** | 🎭 | `sheets-tools.ts` é "Stub (fase 1)"; importa `googleapis`, que **não está instalado** ⇒ sempre `needs_config`. Só aparecem com `GOOGLE_SHEETS_CLIENT_EMAIL`+`PRIVATE_KEY` (não setados). Duplicam o conector Google Sheets, que funciona. |
| memory, memory_search | ✅ | ⚠️ não recebem `userId` (cai em `"default"`) — corrigir na Fase 4. |
| session_search | ✅ | ⚠️ busca em todas as conversas, sem filtro de usuário/bot. |
| checkpoint_read, artifact_read | ✅ | |
| list_skills, show_skill, propose_skill_change, propose_skill_delete | ✅ | |
| list_routines | ✅ | Cosmético: rotina GitHub aparece rotulada como webhook genérico/cron. |
| github_list_repos | ⚙️ | Precisa GitHub conectado no Marketplace. |
| propose_routine | ✅ cron/webhook · ⚙️ GitHub | GitHub exige `ATLAS_PUBLIC_URL` pública (**não setada** ⇒ criação falha de propósito). ⚠️ Bug: `action=create` com nome já existente e `trigger_type=github` vira webhook genérico sem gatilho GitHub e sem hook (`computer-use.ts:2349-2352`). |
| propose_questionnaire, propose_profile_update | ✅ | |
| mcp_tool_search + `mcp__*` | ⚙️ | Dependem de conectores conectados. |

### 4.2 Conectores do Marketplace — `packages/shared/src/mcp-catalog.ts`

| Conector | Status | Observação |
|---|---|---|
| GitHub | ✅ | OAuth configurado (`GITHUB_OAUTH_*` na API e worker); PAT como fallback. |
| Notion | ✅ | OAuth com registro dinâmico, sem config. |
| Gmail, Google Drive, Google Calendar, Google Sheets | ✅ | Servidores MCP embutidos chamando a REST do Google; `GOOGLE_OAUTH_*` configurado. Fora do repo: APIs habilitadas no GCP e seu e-mail como test user se o consent screen estiver em "Testing". |
| Firecrawl | ✅ | Precisa da chave do usuário. Tools fora da lista `readOnlyTools` pedem confirmação e ficam fora de rotinas. |
| Slack | ⚙️ | Implementado, mas `SLACK_OAUTH_CLIENT_ID/SECRET` não setados ⇒ botão desabilitado. Ainda aparece em destaque. |
| **Brave Search** | 🎭 | `coming_soon`, sem URL nem servidor. Aparece como "Em breve". |

Callback OAuth hoje: `http://localhost:3001/v1/mcp/oauth/callback` (sem `PUBLIC_API_URL`) — precisa estar cadastrado nos apps GitHub/Google.

### 4.3 Backlog de correções das tools (independente da auth)

| # | Item | Prioridade |
|---|---|---|
| T1 | Remover `sheets_read/sheets_append` + `sheets-tools.ts` (duplicam o conector Google Sheets e nunca funcionam) ou instalar `googleapis` e unificar `isSheetsAvailable` (há duas versões divergentes: `sheets-tools.ts:57` e `web-extract.ts:446`). Recomendado: remover. | Alta |
| T2 | `propose_routine` create-com-nome-existente + github: rotear para o caminho de edição GitHub (trigger + `ensureGithubRepoHook`); idem cron↔webhook. | Alta |
| T3 | Erros de token do Google (`getFreshAccessToken`: "conector sem login", "token expirado sem refresh_token", "falha ao renovar token") não marcam `pending_auth` porque o MCP perde o tipo do erro e a detecção procura "401/403" no texto (`mcp/call.ts:17-20`) ⇒ nunca aparece "Reconectar". Usar um código/marcador estável no texto. | Alta |
| T4 | Token Google renovado a cada chamada depois do 1º vencimento (cópia dos secrets capturada em `runtime.ts:62-70`). Atualizar a cópia após refresh. | Média |
| T5 | `SANDBOX_ENABLED=false` com setting ligado ⇒ ainda oferecer as 10 tools. Esconder quando o env desliga. | Média |
| T6 | Brave Search: esconder do catálogo até existir servidor; Slack: não destacar enquanto não configurado. | Baixa |
| T7 | `list_routines`/`routineDetailText` rotular gatilho GitHub corretamente; remover comentário de "polling periódico" em `packages/db/src/routines.ts:124-127`. | Baixa |
| T8 | Testes faltando: `session_search`, `list_routines`, `github_list_repos`, `propose_questionnaire`, handler de `propose_profile_update`, tools de sandbox no runtime; `packages/sandbox` sem testes. | Média |
| T9 | `web_search` sem chave depende de scrape do DuckDuckGo — substituído pelo **Atlas Search** (§5). | Alta |

## 5. Atlas Search — busca própria, sem providers pagos

Objetivo: `web_search` e `web_extract` confiáveis sem SerpAPI/Tavily/Brave/Firecrawl. Tudo roda na nossa infra (docker compose), com cache, índice próprio e métricas.

**Limite honesto:** descobrir páginas novas na web inteira exige um índice do tamanho do Google. Ninguém constrói isso sozinho. O que dá para ter de forma madura é: (1) um meta-buscador **auto-hospedado** que consulta vários buscadores públicos com redundância, e (2) um **índice nosso** de tudo que já foi buscado, lido ou está sendo vigiado — que cresce com o uso e responde sem depender de ninguém.

### Arquitetura (novo pacote `packages/search` + serviço `searxng` no compose)
1. **Descoberta — SearXNG auto-hospedado.** Container oficial no `docker-compose.yml`, só na rede interna, com JSON API ligada. Agrega vários buscadores (DuckDuckGo, Bing, Mojeek, Qwant, Wikipedia, GitHub, StackOverflow…) sem chave. Nosso cliente adiciona: timeout por buscador, retry com backoff, circuit breaker por engine (engine que falha sai da rotação por N min), dedupe por URL canônica.
2. **Índice próprio — Postgres (FTS + pgvector, já usado na memória).** Tabelas `WebPage` (url canônica, domínio, título, texto limpo, hash, etag/last-modified, fetchedAt, TTL) e `WebChunk` (trechos com `tsvector` em português + embedding). Toda página lida entra no índice. `web_search` consulta **primeiro o índice** (resultados frescos o suficiente) e completa com o SearXNG.
3. **Ranking.** Fusão RRF entre: posição no SearXNG, BM25 do FTS local e similaridade de embedding; boosts por frescor e reputação do domínio (lista curada + histórico de sucesso de extração); penalidade para conteúdo raso/duplicado.
4. **Extração — pipeline próprio (substitui Firecrawl no `web_extract`).**
   - Fetch com `undici`: guarda contra SSRF (já existe em `web-native.ts:340`), limite de tamanho, respeito a `robots.txt`, User-Agent identificado, rate limit por domínio.
   - HTML → conteúdo principal com Mozilla Readability (`@mozilla/readability` + `linkedom`) → Markdown (`turndown`); PDF com `pdf-parse`.
   - Páginas que só renderizam com JS (ex.: Mercado Livre): fallback para o Chromium/Playwright que já existe na sandbox, via um endpoint headless dedicado.
   - Extração estruturada (`schema`): LLM via OpenRouter com JSON schema sobre o Markdown limpo (hoje o `schema` é ignorado sem Firecrawl).
   - Cache: condicional com ETag/If-Modified-Since; TTL por tipo de página.
5. **Vigias (crawler focado).** Para rotinas que acompanham sites (ex.: preço do Macbook): lista de URLs/sitemaps/RSS vigiados, re-fetch agendado no BullMQ, diff de conteúdo, e o evento "mudou" pode disparar rotina. Isso também alimenta o índice.
6. **Operação.** Métricas por engine (latência, taxa de erro, resultados úteis), log de consultas, e um conjunto fixo de ~50 consultas de avaliação (pt/en) rodando em CI/cron para detectar degradação (ex.: um buscador começou a bloquear).

### Fases do Atlas Search
- **S1:** SearXNG no compose + cliente com retry/circuit breaker; `web_search` passa a usar ele (DuckDuckGo direto vira fallback).
- **S2:** pipeline de extração próprio (Readability/Markdown/PDF + fallback Playwright) no `web_extract`; remover a dependência de Firecrawl nas tools nativas (o conector Firecrawl do Marketplace continua opcional).
- **S3:** índice `WebPage`/`WebChunk` + busca híbrida + ranking RRF.
- **S4:** extração estruturada com LLM; vigias agendados; avaliação contínua.

## 6. Ordem sugerida
1. Fase 0 (endurecimento) + T1/T2/T3.
2. Fases 1 → 2 → 3 (auth de ponta a ponta, conta única, com testes de IDOR).
3. Fase 4 + T4/T5/T8 + Atlas Search S1/S2.
4. Atlas Search S3/S4; T6/T7.

## 7. Perguntas em aberto
- Domínio da VPS: em aberto, preenchido em `ATLAS_URL` no Dokploy.
- Provedor de e-mail: em aberto, preenchido em `MAIL_URL` (sem ele, o magic link sai no log).
