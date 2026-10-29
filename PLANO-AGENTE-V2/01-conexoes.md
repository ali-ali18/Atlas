# F1 — Conexões por dono (desbloqueia o GitHub e fecha o vazamento)

**Dono:** Bot A · **Depende de:** nada · **Status:** aprovada e mergeada (28/09)

## Diagnóstico
- A conexão GitHub do usuário (`gYUwIB6mkwj2N5H3SM8OMxiYnDlQdtXl`) está `connected`, mas com `userId = "default"`. O mesmo vale para gmail, calendar, notion, drive e firecrawl; só google_sheets tem o dono real.
- Run `cmulqxn0i001hlgroaorsdht8`: `github_list_repos({query:"loja monorepo"})` devolveu `ok:true` com o texto "Conecte o GitHub no Marketplace".
  - `executeGithubListRepos` (`packages/agent-runtime/src/computer-use.ts:2286-2325`) chama `getGithubConnectionToken(scope.userId)` (`mcp/github-token.ts:115-159`).
  - Essa função chama `getMcpConnectionByCatalogId("github", userId)` (`packages/db/src/mcp-connections.ts:195-211`), que faz um `findUnique` exato **sem fallback `"default"`**.
  - `isOwnedBy` (`:111-114`) aceita `"default"`, mas só é usado em get, update e delete.
- **Vazamento:** `listConnectedMcpConnections` (`mcp-connections.ts:127-136`) ignora `_userId` e usa `where: {status:"connected"}`, de todos os usuários. Por isso `mcp__github__*` funciona (vê a linha `"default"`), mas qualquer usuário vê os conectores de qualquer outro. Quem carrega é `loadMcpRuntime` (`mcp/runtime.ts:161`), a partir de `apps/worker/src/processors/agent-run.ts:459`.
- **Mesmo bug em outros callers:** `mcp/github-token.ts:162` (`markGithubConnectionAuthFailed`), `github/hook-sync.ts:122-124` (webhook do `propose_routine` github), `apps/api/src/routes/github.ts:17`, `apps/api/src/routes/mcp.ts:379,398` (reconectar cria uma segunda linha `github`).
- **Claim-default só roda:**
  - por conexão, no callback OAuth (`claimMcpConnectionByStateHash`, `mcp-connections.ts:172-193`);
  - no script manual `packages/db/scripts/claim-default.mjs` (`package.json:14`, `--user-id`, exige que o usuário seja o `ATLAS_OWNER_EMAIL` e o único usuário).

## Tarefas
- [x] Criar o helper `ownerIds(userId)` = `[userId, "default"]`, com a mesma regra de `isOwnedBy`.
- [x] `listConnectedMcpConnections(userId)`: filtrar `userId in ownerIds(userId)`. Com `userId` ausente, só `"default"`.
- [x] `getMcpConnectionByCatalogId(catalogId, userId)`: se houver linha do usuário, ela ganha; senão, usa a `"default"`.
- [x] Ajustar os callers listados acima para usar o helper, **sem criar linha duplicada** ao reconectar (`mcp.ts:379,398`: se existir linha `"default"`, reivindicar e atualizar).
- [x] Extrair a lógica de `claim-default.mjs` para uma função em `packages/db` (idempotente). Chamar no boot da API (`apps/api/src/index.ts`) quando houver **exatamente 1 usuário** e o e-mail dele for o `ATLAS_OWNER_EMAIL`. Logar quantas linhas foram reivindicadas. O script continua existindo e passa a chamar a função.
- [x] Honestidade: `executeGithubListRepos` e as outras tools builtin que devolvem o texto de erro com `ok:true` passam a **lançar erro** (`ok:false`). Procurar com Grep por `return { summary: error` e padrões iguais em `computer-use.ts`. Essas linhas são do Bot B: registrar a nota em `REVIEW.md` e fazer uma mudança mínima.

## Testes obrigatórios
Seguir `apps/api/src/routes/scope.test.ts`:
- [x] Usuário B não lista as conexões do usuário A.
- [x] Linha `"default"` visível ao dono; a linha própria ganha da `"default"`.
- [x] `getGithubConnectionToken(realUserId)` acha a linha `"default"`.
- [x] Reconectar não duplica a linha.
- [x] Claim-default no boot: roda com 1 usuário dono, não roda com 2 usuários, e rodar de novo não muda nada.
- [x] `github_list_repos` sem conexão → `ok:false`.

## Commits
1. `fix(db): conexões MCP escopadas por dono (fecha vazamento entre usuários)`
2. `feat(db): claim-default automático no boot quando há um único dono`
3. `fix(agent): github_list_repos acha conexão legada e falha de verdade`

## Critérios de aceite
- No `/run`, com o bot Jujuba: "Quero sua ajuda no repo loja monorepo…" → `github_list_repos` lista o repo, sem "conecte o GitHub".
- Depois do boot: `select "catalogId","userId" from mcp_connections` não tem mais `"default"` (ambiente com 1 usuário).
- Um segundo usuário de teste não vê nem usa os conectores do dono.

## Commits feitos
- aff1f3e `fix(db): conexões MCP escopadas por dono (fecha vazamento entre usuários)`
- a406d02 `feat(db): claim-default automático no boot quando há um único dono`
- 07fa7d5 `fix(agent): github_list_repos acha conexão legada e falha de verdade`
- 2398c9b `fix(db): claim-default tolera colisões de unique e run sem tools duplicadas` (ajustes da revisão)
- d8c65ac `fix(db): claim-default reivindica skill colidida como _legado e valida cada FK` (2ª revisão)
- 6e230f7 `style(api): indentação do bloco OAuth em mcp.ts` (2ª revisão)
