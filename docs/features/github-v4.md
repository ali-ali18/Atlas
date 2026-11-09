# GitHub (leitura) no Motor v4 (F9)

Listar os repositórios do dono e comparar dois pontos (branch, tag ou commit) pelo chat, no motor v4 (`packages/agent`, ainda atrás da flag). Paridade com `github_list_repos` e `github_compare` do legado (`packages/agent-runtime`). **Só leitura**: issue, PR, branch e gatilho de webhook ficam fora desta entrega.

## O que é
- Capacidade lazy `github`: só o índice curto entra no prompt; o schema das tools e as instruções entram ao carregar. "Bom dia" não cresce (teste de economia em `guards/economy.test.ts`).
- `github_list_repos` (`query` opcional, filtro por trecho de `owner/name`): até 20 repositórios, mais recentes primeiro, com público ou privado e a branch padrão. Passou de 20: avisa para filtrar.
- `github_compare` (`repo` como `owner/name`, `base`, `head` sem espaço, `includePatch` opcional): lista completa de commits entre os dois pontos e estatística por arquivo. Patches só com `includePatch` e para no máximo 20 arquivos, cada um cortado. O texto é o mesmo `formatCompareForModel` do legado.
- Qualquer outro campo, inclusive `ownerId` ou `token`, falha com a lista do que é aceito. Formato inválido de `repo`, `base` ou `head` falha antes de falar com o GitHub.

## Onde mora
- **`packages/github` (`@workspace/github`)**: pacote novo com o cliente REST de leitura, a comparação, a identidade do GitHub App para leitura, o token da instalação, o token OAuth/PAT do Marketplace (`getGithubConnectionToken`) e `resolveGithubReadOps` (app, token nativo, e um `fallback` injetável). Veio de `agent-runtime/src/github` e `agent-runtime/src/mcp/github-token.ts`, que viraram reexports (comportamento igual; as suítes antigas passam sem mudança). Motivo do pacote novo: o adaptador do v4 não pode importar o `agent-runtime`, e o token do dono dependia de pedaços do runtime de MCP (cofre, OAuth, `markMcpConnectionAuthFailed`). Esses pedaços foram reescritos em poucas linhas no pacote, sobre `@workspace/db` (incluindo `@workspace/db/vault-crypto`).
- **Fica no `agent-runtime`** (legado): escrita (`github/write`), hooks e `hook-sync`, `pull-ci`, manifesto/estado do App, `enrich`, e o Composio como terceira fonte de leitura.
- **Porta `Github`** (`packages/agent/src/ports/github.ts`): `listRepos` e `compare`, ambos com o `ownerId` do run. O texto da comparação já sai formatado e com teto.
- **Adaptador** (`apps/worker/src/v4-adapters/github.ts`): resolve o token **do dono do run** (nunca de args), pede reconexão no 401 e redige o erro de terceiros.
- `code-actions-real.ts` (sessão de código) passou a pegar o token em `@workspace/github`, sem importar o `agent-runtime`.

## Segurança e política
- Efeito `read`, `trust: untrusted`, `source: mcp`, `privateData` e `ownerData: connector`: nome de repositório, mensagem de commit, nome de arquivo e patch são escritos por outras pessoas (dado, nunca instrução) e, depois deles, uma saída para fora no mesmo run pede aprovação, como no Google Agenda.
- Escopo por dono: o `userId` vem do run. Repositório de outro dono responde "não encontrado" (o token do dono não o enxerga). Teste de outro usuário no capability e no adaptador.
- Sem dono presente (rotina, agenda): as duas tools continuam, porque só leem. Não há escrita para esconder.
- Segredo: o token nunca é logado nem devolvido; o erro do GitHub passa por `sanitizeErrorMessage`.
- GitHub não conectado: falha (nunca lista vazia) com instrução em português para o dono ("Conecte o GitHub no Marketplace ou instale o app do GitHub em Conexões"). 401: pede reconexão e diz como (Marketplace ou reinstalar o app).

## Conector GitHub (MCP) não é escondido
`email` e `calendar` tiram do run o conector que os duplica (o nativo tem aprovação e fuso). Aqui **não**: o conector GitHub é o único caminho de **escrita** (issue, PR, branch) e o `github` nativo só lê. Esconder o conector tiraria a escrita. A sobreposição é pequena (listar repositórios) e o modelo é instruído a escrever pelo conector (`tool_search`). Se a escrita nativa entrar depois, aí o conector passa a ser deduplicado em `NativeCoverage`.

## Riscos e limites
- **Sem Composio no v4.** Quem conectou o GitHub só pelo Composio não usa as tools nativas (o v4 diz que não está conectado e a dica manda procurar a ferramenta nos apps conectados). O Composio continua nos conectores genéricos do v4.
- **Pacote novo no deploy.** O worker passou a depender de `@workspace/github` por `dist`: o build do monorepo (turbo) cobre; imagem ou script que lista pacotes à mão precisa incluí-lo.
- **Duplicação pequena.** `createNativeGithubReadOps` e `resolveGithubReadOps` existem no pacote (sem Composio) e no `agent-runtime` (com Composio), porque os testes legados trocam o cliente e o token por mocks nos caminhos antigos. O `createAppGithubReadOps` é compartilhado.

## Testes
- `packages/agent/src/capabilities/github/github-capability.test.ts`: forma, validação dos args, ordenação e limite, filtro, outro dono, falha honesta, texto vazio.
- `apps/worker/src/v4-adapters/github.test.ts`: dono do run, outro dono sem GitHub, 401 (nativo marca, app não), erro redigido, cancelamento.
- `economy.test.ts`, `presets.test.ts`, `contract-invariants.test.ts`, `v4-adapters/index.test.ts`, `engine-v4.test.ts`: lazy, `unavailable`, lista de tools do registro, conector GitHub preservado.
- `packages/github`: `client.test.ts` e `connection-token.test.ts` (movidos junto com o código).
