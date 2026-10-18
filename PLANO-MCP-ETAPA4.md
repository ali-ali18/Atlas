# Etapa 4 — Marketplace de conectores MCP (catálogo + API + UI)

> Handoff para implementação. Leia inteiro antes de começar. Não faça commit.
> Branch: `checkpoint/agentic-baseline` (working tree tem trabalho não commitado das etapas 0–3 — não reverta nada).

## 1. Contexto

O Atlas é um agente (monorepo pnpm: `apps/api` Hono, `apps/worker` BullMQ, `apps/web` Next.js, `packages/*`). As etapas anteriores já entregaram o **backend MCP**: tabela, cofre de segredos, cliente MCP, registry de tools e integração no runtime do agente. Falta o que o usuário vê: **um marketplace** (estilo "Adicionar"/"✓ Adicionado") para conectar servidores MCP à conta. Conexões são **da conta** (`userId: "default"`, app single-user) e valem para todos os bots.

**Escopo desta etapa:** conectores que autenticam por **chave/token** (`api_key`) ou **sem auth** (`none`), incluindo **MCP personalizado por URL**. **OAuth fica para a etapa 5**: entradas OAuth aparecem no catálogo como "Em breve" (desabilitadas).

## 2. O que já existe (use, não recrie)

| Peça | Onde | O que usar |
|---|---|---|
| Tabela `McpConnection` | `packages/db/prisma/schema.prisma` + migration `20260925130000_mcp_connections` | campos: `catalogId`, `slug`, `name`, `url`, `authType`, `status`, `secretsEnc`, `toolsCacheJson`, `disabledTools`, `confirmWrites`, `lastError` |
| CRUD | `packages/db/src/mcp-connections.ts` | `createMcpConnection`, `updateMcpConnection` (aceita `tools`, `status`, `secretsEnc`, `disabledTools`, `confirmWrites`, `lastError`), `deleteMcpConnection`, `getMcpConnection`, `getMcpConnectionByCatalogId`, `listMcpConnections`, `toMcpConnectionView` (tira segredos) |
| Tipos | `packages/shared/src/mcp.ts` | `McpConnectionView`, `McpToolInfo`, `McpAuthType`, `McpConnectionStatus`, `slugifyConnectorName`, `isReadOnlyMcpTool` |
| Cofre | `packages/agent-runtime/src/mcp/secret-box.ts` | `sealSecrets(secrets)`, `openSecrets(str)`, `isSecretBoxConfigured()`, `secretValues(secrets)`. Tipo `McpConnectorSecrets = { apiKey?, url?, headers?, oauth? }` — `url` = URL real quando a chave vai na URL (a coluna `url` guarda a versão pública/redigida) |
| Cliente MCP | `packages/agent-runtime/src/mcp/client-pool.ts` | `McpClientPool` (aceita `transportFactory` injetável p/ testes), `getSharedMcpPool()`, `McpClientConfig = { id, version, name, url, headers?, authProvider? }` |
| Listagem de tools | `packages/agent-runtime/src/mcp/call.ts` | `listMcpTools(client)` → `McpToolInfo[]` |
| Config de cliente | `packages/agent-runtime/src/mcp/runtime.ts` | `buildMcpClientConfig(record, secrets)` |
| Redação | `packages/agent-runtime/src/mcp/sanitize.ts` | `sanitizeErrorMessage(error, secrets)` |
| Runtime do agente | já lê conexões `status: "connected"` a cada run (`loadMcpRuntime` no worker). **Não mexa** em `computer-use.ts` nem no worker. |

Tudo acima é exportado por `@workspace/agent-runtime`, `@workspace/db` e `@workspace/shared`.

**Pegadinhas do repo:**
- Pacotes internos resolvem para `dist/` em runtime. Depois de mudar `packages/shared` ou `packages/db`, rode `pnpm --filter @workspace/shared build` e `pnpm --filter @workspace/db exec tsc` antes de testar API/web/agent-runtime.
- `prisma generate` pode falhar com `EPERM` no Windows se API/worker estiverem rodando (DLL travada). Não precisa regenerar nada nesta etapa.
- Env: `CONNECTOR_ENCRYPTION_KEY` (32 bytes base64). Sem ela, `isSecretBoxConfigured()` é `false` → a API deve responder 503 com mensagem clara em qualquer rota que grave segredo.
- Estilo: TypeScript estrito, tabs, comentários curtos em português, sem dependências novas.

## 3. Tarefas

### A. Catálogo — `packages/shared/src/mcp-catalog.ts` (+ export em `packages/shared/src/index.ts`)

```ts
export type McpCatalogCategory = "search" | "google" | "productivity" | "custom";
export type McpApiKeyPlacement =
  | { kind: "bearer" }                        // Authorization: Bearer <key>
  | { kind: "header"; name: string }          // <name>: <key>
  | { kind: "url"; template: string };        // template com "{key}"
/** Habilidade que acompanha o conector (vale enquanto ele estiver conectado). */
export type McpCatalogSkill = {
  key: string;                // "notion-meeting-notes" (slug)
  title: string;
  description: string;        // quando usar, 1–2 frases
};
export type McpCatalogEntry = {
  id: string;                 // "firecrawl", "github"…
  name: string;
  description: string;        // 1 linha, PT-BR (card)
  longDescription: string;    // parágrafo da página de detalhe
  category: McpCatalogCategory;
  icon: string;               // arquivo em apps/web/public/connectors/<id>.svg (ou ícone lucide)
  developer: string;          // "Notion Labs", "GitHub"…
  website: string;            // "notion.com"
  sourceUrl: string;          // "Ver origem ↗" (repo/doc do servidor MCP)
  authType: McpAuthType;
  url?: string;               // endpoint Streamable HTTP (ausente se url-template)
  apiKey?: { placement: McpApiKeyPlacement; label: string; helpUrl: string };
  availability: "available" | "coming_soon";
  docsUrl: string;
  /** Só exibição nesta etapa; a injeção no run é outra tarefa (não faça). */
  skills: McpCatalogSkill[];
};
export const MCP_CATALOG: readonly McpCatalogEntry[];
export function getMcpCatalogEntry(id: string): McpCatalogEntry | undefined;
/** URL pública para exibir/guardar na coluna `url` (chave substituída por "***"). */
export function publicMcpUrl(entry: McpCatalogEntry): string;
/** Aplica a chave: devolve { url, headers } para o cliente. */
export function applyMcpApiKey(entry: McpCatalogEntry, key: string): { url: string; headers?: Record<string, string> };
```

Entradas iniciais (**confira cada URL/forma de auth na doc oficial antes de fixar; se não conseguir confirmar, deixe `coming_soon` e anote no resumo final**):
- `firecrawl` — busca + extração web. MCP remoto com chave na URL (doc: docs.firecrawl.dev → MCP server; formato esperado `https://mcp.firecrawl.dev/{key}/v2/mcp`). `authType: "api_key"`, placement `url`.
- `github` — MCP remoto oficial `https://api.githubcopilot.com/mcp/` aceita PAT como `Authorization: Bearer`. `api_key` + `bearer`. (OAuth vem na etapa 5.)
- `notion` (`https://mcp.notion.com/mcp`), `slack`, `gmail`, `google_drive`, `google_calendar`, `google_sheets` — `authType: "oauth"`, `availability: "coming_soon"`.
- `brave_search` — o servidor oficial é stdio (processo local); stdio **não** é suportado nesta etapa → `coming_soon`.
- `custom` **não** entra no array: é um formulário próprio (ver D).
- `skills`: 2–3 por conector, escritas em PT-BR, descrevendo **quando** usar (ex.: GitHub → "Revisar PR", "Resumo de issues abertas"; Firecrawl → "Comparar preços", "Pesquisa com fontes"). Entradas `coming_soon` também têm skills (aparecem na página de detalhe). Custom não tem.

### B. Conectar/testar — `packages/agent-runtime/src/mcp/connect.ts` (+ export no index)

```ts
/** Conecta, lista tools e fecha. Lança erro já sanitizado (sem segredo). */
export async function probeMcpServer(input: {
  url: string;
  headers?: Record<string, string>;
  pool?: McpClientPool;        // default: new McpClientPool() descartável
  timeoutMs?: number;          // default 20s
}): Promise<McpToolInfo[]>;
```
- Use `McpClientPool.withClient` + `listMcpTools`; `id` temporário (`probe-<uuid>`), feche o pool no `finally`.
- Erro de auth (`UnauthorizedError` do SDK ou HTTP 401/403 na mensagem) → `Error("credencial recusada pelo servidor")`. Demais → `sanitizeErrorMessage(error, [key/headers])`.
- Teste com servidor em memória (padrão em `packages/agent-runtime/src/mcp/mcp.test.ts`: `InMemoryTransport.createLinkedPair()` + `Server` de baixo nível) via `transportFactory` injetado.

### C. API — `apps/api/src/routes/mcp.ts`, registrado em `apps/api/src/index.ts` (padrão de `routes/settings.ts`)

Todas com `userId = "default"`. Respostas **nunca** incluem `secretsEnc`, chave, headers ou URL com chave (use `toMcpConnectionView`).

| Rota | Corpo | Resposta |
|---|---|---|
| `GET /v1/mcp/catalog` | — | `{ entries: Array<McpCatalogEntry & { connectionId: string \| null; status: McpConnectionStatus \| null }>, secretBoxReady: boolean }` (sem expor templates com chave — só metadados) |
| `GET /v1/mcp/connections` | — | `{ connections: McpConnectionView[] }` |
| `POST /v1/mcp/connections` | `{ catalogId: string, apiKey?: string }` **ou** `{ custom: { name: string, url: string, headerName?: string, headerValue?: string } }` | `201 { connection }` |
| `PATCH /v1/mcp/connections/:id` | `{ disabledTools?: string[], confirmWrites?: boolean, name?: string }` | `{ connection }` |
| `POST /v1/mcp/connections/:id/refresh` | — | re-probe, atualiza tools/status → `{ connection }` |
| `DELETE /v1/mcp/connections/:id` | — | `204` |

Fluxo do `POST` (catálogo):
1. `isSecretBoxConfigured()` falso → `503 { error: "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker" }`.
2. Entrada inexistente → 404; `coming_soon` ou `authType === "oauth"` → 400 `"disponível em breve"`; `api_key` sem `apiKey` → 400.
3. Já existe conexão com esse `catalogId` → **atualiza** a mesma (reconectar/trocar chave), não cria outra.
4. `applyMcpApiKey` → `probeMcpServer({ url, headers })`.
5. Sucesso: `createMcpConnection`/`updateMcpConnection` com `url: publicMcpUrl(entry)`, `slug: entry.id`, `authType`, `status: "connected"`, `tools`, `lastError: null`, `secretsEnc: sealSecrets({ apiKey, url: <url real se placement=url>, headers })`.
6. Falha no probe: **não grava nada** para conexão nova (responde `422 { error }` com a mensagem sanitizada); para conexão existente, grava `status: "error"` + `lastError`.

Fluxo do `POST` (custom):
- Valide: `name` 1–60 chars; `url` parseável; `https:` obrigatório, exceto host `localhost`/`127.0.0.1` (servidor local do próprio usuário); `headerName` só `[A-Za-z0-9-]`, e se vier `headerName` tem que vir `headerValue`.
- `catalogId: null`, `slug: slugifyConnectorName(name)` (o db já desambigua `_2`, `_3`), `authType: headerValue ? "api_key" : "none"`, `secretsEnc` só se houver header.
- Mesmo probe/gravação do fluxo acima.

`PATCH`: `disabledTools` deve conter só nomes presentes em `connection.tools` (ignore desconhecidos); limite 200 itens.
`refresh`: abre segredos (`openSecrets`), `buildMcpClientConfig` → probe; sucesso = `connected` + tools; falha = `error` + `lastError`.
Extraia validações para funções puras (`parseCreateMcpBody`, `parsePatchMcpBody`) e teste-as. Erros de JSON inválido → 400, como em `routes/settings.ts`.

### D. Web — Marketplace

Cliente HTTP em `apps/web/lib/atlas-api.ts` (use o `atlasFetch<T>` existente): `getMcpCatalog`, `listMcpConnections`, `createMcpConnection`, `updateMcpConnection`, `refreshMcpConnection`, `deleteMcpConnection`.

Componentes novos em `apps/web/components/ui/templates/template-4/marketplace/`. Primitivos de `@workspace/ui/components/*` (`dialog`, `input`, `button`, `switch`, `item`, `empty`, `skeleton`, `field`, `label`, `alert`, `tooltip`, `sheet`). Siga o visual de `chat-context-panel/agent-settings.tsx` e `routine-editor.tsx`.

- `marketplace-dialog.tsx` — modal largo (referência: marketplace do print do usuário):
  - topo: busca "Buscar conectores" (filtra por nome/descrição, sem rede);
  - seções: **Conectados** (se houver), **Pesquisa web**, **Google**, **Produtividade**, **Personalizado**;
  - grid de 2 colunas; card = ícone, nome, descrição (1 linha, truncada), botão à direita: `Adicionar` / `✓ Adicionado` / `Reconectar` (status `error`/`pending_auth`) / `Em breve` (desabilitado). **Clicar no card abre a página de detalhe**; clicar no botão faz a ação direto;
  - se `secretBoxReady === false`: `Alert` no topo explicando a env, e botões desabilitados.
- `connector-page.tsx` — **página de detalhe dentro do mesmo modal** (troca o conteúdo, seta `←` volta ao grid, `✕` fecha). Layout de referência (marketplace do Cursor, print do usuário):
  - **Cabeçalho:** ícone grande (≈64px, cantos arredondados), nome, link `Ver origem ↗` (`sourceUrl`, nova aba); à direita o botão principal (mesmos estados do card). Sem botão "Compartilhar" (app single-user).
  - **Descrição:** `longDescription`.
  - **Aplicativos 1:** bloco com uma linha: ícone de plugue + `slug` + "Conector" (subtítulo). Se conectado, mostra "N ferramentas" à direita.
  - **Habilidades N:** lista das `skills` (ícone de cubo + `key` em destaque + descrição truncada em 1 linha). Oculte a seção se N = 0.
  - **Informações:** tabela chave/valor — Recursos ("1 aplicativo, N habilidades"), Desenvolvedor, Categoria (rótulo PT-BR da categoria), Site (`website`, link).
  - **Se conectado**, abaixo de Informações, seção **Configuração** = conteúdo do `connector-detail.tsx` (abaixo).
  - Blocos com fundo levemente destacado e cantos arredondados, linhas separadas por divisória, como no print.
- `api-key-dialog.tsx` — pede a chave (`type="password"`), link "Onde consigo?" (`apiKey.helpUrl`), botão "Conectar" com estado de carregamento; erro da API aparece inline.
- `custom-connector-form.tsx` — nome, URL, header opcional (nome + valor). Mesmo tratamento de erro.
- `connector-detail.tsx` (seção "Configuração" da página; também usado por conectores personalizados, que não têm página de catálogo — para eles a página mostra só cabeçalho com nome/URL pública + Configuração) — status + `lastError`; lista de tools com `Switch` (liga/desliga → `disabledTools`); selo "leitura"/"escreve" por tool (`isReadOnlyMcpTool`); switch "Pedir confirmação antes de alterar dados" (`confirmWrites`); botões "Atualizar tools" (refresh) e "Desconectar" (confirmação com `confirm-alert`).
- Ligar o botão existente **"Marketplace"** em `chat-sidebar/chat-sidebar-footer.tsx` (hoje sem `onClick`, ~linha 92): nova prop `onOpenMarketplace`, repassada por `chat-sidebar.tsx` e controlada em `template-4-client.tsx` (mesmo padrão de `onOpenSettings`).
- Aviso de tamanho: se a soma de tools ativas > 40, mostrar nota "o agente usa no máximo 40 tools de conectores por vez" (constante `MCP_MAX_EXPOSED_TOOLS` do agent-runtime — replique o número em `shared/mcp-catalog.ts` como `MCP_MAX_EXPOSED_TOOLS_HINT` para a web não importar agent-runtime).

## 4. Fora do escopo (não faça)
OAuth (etapa 5) · servidores stdio · Google embutido (etapa 6) · conexões por bot · mudanças em `computer-use.ts`, worker, higiene ou orçamento · remover código da Fase 1 (`web-search.ts`, `web-extract.ts`, `sheets-tools.ts`) · commits.

## 5. Segurança (obrigatório)
- Nenhum segredo em resposta, log (`console.*`), mensagem de erro ou `lastError`: passe `sanitizeErrorMessage(err, [apiKey, headerValue, urlReal])`.
- URL com chave nunca vai para a coluna `url` nem para a UI — só `publicMcpUrl`.
- Chave só trafega do form → `POST` (corpo JSON). Não guardar no estado global do React além do form.
- Tools vindas do servidor são dados não confiáveis: a UI renderiza `name`/`description` como texto (sem `dangerouslySetInnerHTML`/markdown).

## 6. Critérios de aceite
1. Abrir Marketplace pela sidebar mostra o catálogo com busca e seções; OAuth aparece "Em breve".
1b. Clicar num card abre a página de detalhe (cabeçalho + Ver origem, descrição, Aplicativos, Habilidades, Informações; Configuração se conectado); `←` volta ao grid. Funciona também para itens "Em breve" (botão desabilitado).
2. Firecrawl (se a URL for confirmada) ou GitHub com PAT: "Adicionar" → chave → vira "✓ Adicionado"; `GET /v1/mcp/connections` lista as tools; o próximo run do agente enxerga `mcp__<slug>__*` (já funciona no backend).
3. Chave errada → erro inline, nada gravado.
4. MCP personalizado com URL `http://` pública → recusado; `http://localhost:…` → aceito.
5. Desligar uma tool no detalhe → some da lista do próximo run. "Desconectar" apaga a linha.
6. Nenhuma resposta da API contém a chave (verifique com um teste).
7. `tsc --noEmit` limpo em shared, db, agent-runtime, api, web; testes novos passando: `pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/agent-runtime test`.

## 7. Entregue no final
Resumo curto: arquivos criados/alterados, URLs de catálogo que você **confirmou** vs. deixou `coming_soon`, qualquer desvio deste plano e por quê.
