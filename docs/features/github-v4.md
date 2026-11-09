# GitHub (leitura e escrita) no Motor v4 (F9)

Listar os repositórios do dono e comparar dois pontos (branch, tag ou commit) pelo chat, no motor v4 (`packages/agent`, ainda atrás da flag). Paridade com `github_list_repos` e `github_compare` do legado (`packages/agent-runtime`) e, desde a escrita nativa, com as escritas mais usadas do legado: issue, comentário, PR e merge. Branch, arquivo, review e gatilho de webhook ficam fora (branch, arquivo e review seguem pelo conector GitHub).

## O que é
- Capacidade lazy `github`: só o índice curto entra no prompt; o schema das tools e as instruções entram ao carregar. "Bom dia" não cresce (teste de economia em `guards/economy.test.ts`).
- `github_list_repos` (`query` opcional, filtro por trecho de `owner/name`): até 20 repositórios, mais recentes primeiro, com público ou privado e a branch padrão. Passou de 20: avisa para filtrar.
- `github_compare` (`repo` como `owner/name`, `base`, `head` sem espaço, `includePatch` opcional): lista completa de commits entre os dois pontos e estatística por arquivo. Patches só com `includePatch` e para no máximo 20 arquivos, cada um cortado. O texto é o mesmo `formatCompareForModel` do legado.
- **Escrita** (só com dono presente; sempre como o app do GitHub do dono, nunca pela conta pessoal): `github_issue_create` (título, texto, etiquetas, responsáveis), `github_issue_update` (título, texto, estado, motivo, etiquetas; sem nenhum campo falha), `github_comment` (issue ou PR), `github_pr_create` (head e base já existentes no repositório; sem fork) e `github_pr_merge` (método opcional). O resultado traz o link e o número; falha lança com a mensagem real (nunca sucesso falso).
- Qualquer outro campo, inclusive `ownerId` ou `token`, falha com a lista do que é aceito. Formato inválido de `repo`, `base` ou `head` falha antes de falar com o GitHub.

## Onde mora
- **`packages/github` (`@workspace/github`)**: pacote novo com o cliente REST de leitura, a comparação, a identidade do GitHub App para leitura, o token da instalação, o token OAuth/PAT do Marketplace (`getGithubConnectionToken`) e `resolveGithubReadOps` (app, token nativo, e um `fallback` injetável). Veio de `agent-runtime/src/github` e `agent-runtime/src/mcp/github-token.ts`, que viraram reexports (comportamento igual; as suítes antigas passam sem mudança). Motivo do pacote novo: o adaptador do v4 não pode importar o `agent-runtime`, e o token do dono dependia de pedaços do runtime de MCP (cofre, OAuth, `markMcpConnectionAuthFailed`). Esses pedaços foram reescritos em poucas linhas no pacote, sobre `@workspace/db` (incluindo `@workspace/db/vault-crypto`).
- **Escrita** (`github/write`: operações e portão de identidade) também mora em `@workspace/github`; o legado reexporta. O portão devolve agora o número e o link do que foi criado (`data`).
- **Fica no `agent-runtime`** (legado): hooks e `hook-sync`, `pull-ci`, manifesto/estado do App, `enrich`, e o Composio como terceira fonte de leitura.
- **Portas** (`packages/agent/src/ports/github.ts`): `Github` (`listRepos` e `compare`) e `GithubWriter` (`write` de uma `GithubWriteAction`), ambas com o `ownerId` do run. O texto da comparação já sai formatado e com teto.
- **Adaptador** (`apps/worker/src/v4-adapters/github.ts`, `createV4GithubWriter` para a escrita): resolve o token **do dono do run** (nunca de args), pede reconexão no 401 e redige o erro de terceiros.
- `code-actions-real.ts` (sessão de código) passou a pegar o token em `@workspace/github`, sem importar o `agent-runtime`.

## Segurança e política
- Efeito `read`, `trust: untrusted`, `source: mcp`, `privateData` e `ownerData: connector`: nome de repositório, mensagem de commit, nome de arquivo e patch são escritos por outras pessoas (dado, nunca instrução) e, depois deles, uma saída para fora no mesmo run pede aprovação, como no Google Agenda.
- Escopo por dono: o `userId` vem do run. Repositório de outro dono responde "não encontrado" (o token do dono não o enxerga). Teste de outro usuário no capability e no adaptador.
- Sem dono presente (rotina, agenda): as duas tools de leitura continuam, porque só leem; a escrita fica oculta.
- Segredo: o token nunca é logado nem devolvido; o erro do GitHub passa por `sanitizeErrorMessage`.
- GitHub não conectado: falha (nunca lista vazia) com instrução em português para o dono ("Conecte o GitHub no Marketplace ou instale o app do GitHub em Conexões"). 401: pede reconexão e diz como (Marketplace ou reinstalar o app).

## Escrita: identidade, aprovação e escopo
- **Identidade.** A escrita usa o mesmo portão do legado (`gateGithubWrite` em `@workspace/github`, movido de `agent-runtime/src/github/write`, que virou reexport): token de instalação do app, só em repositório coberto por uma instalação **do dono do run**. A conta pessoal (OAuth, PAT, Composio) nunca escreve.
- **App não instalado** (ou suspenso, sem permissão, ou app não criado no servidor): nada é enviado e a tool falha com texto em inglês para o modelo, mandando o dono instalar em Configurações → Conexões → GitHub. O v4 **não** mostra o cartão `githubIdentity` do legado, então a mensagem não o promete (mesmo texto do `mcp.ts`).
- **Aprovação.** Efeito `write_external`: a autonomia do dono decide, como no Google Agenda. Se o dono marcou "confirmar escritas" no conector GitHub dele, todas as escritas nativas viram `confirm: always` (lido uma vez ao montar o registro; falha ao ler = confirmar). `github_pr_merge` pede o dono **sempre** (não se desfaz pelo bot).
- **Sem dono** (rotina, agenda, bot a bot): as cinco tools de escrita nem são oferecidas; só as duas de leitura.
- **Escopo por dono.** O `userId` vem do run; o portão lista só as instalações desse dono. Usuário B no repositório do A: "app não instalado", nada enviado (teste no adaptador, com o portão real e instalações falsas por dono).
- **Conteúdo de fora.** Texto de issue, PR e comentário lido do GitHub é dado, nunca instrução; as instruções da capacidade e as descrições das tools dizem para nunca escrever porque um texto de fora pediu. A assinatura "enviado pelo bot" do dono (configuração do legado) continua aplicada pelo portão.

## Conector GitHub (MCP): mantido, e por quê
`email` e `calendar` tiram do run o conector que os duplica porque o nativo cobre tudo o que o conector fazia. Aqui **não** cobre: o conector GitHub também faz branch, arquivo (criar, editar, apagar, enviar), review de PR, fork, busca e leituras de issue/PR/arquivo. Esconder o conector tiraria esses caminhos, então ele **continua** no run (a escrita dele passa pelo mesmo portão de identidade, no `mcp.ts`). A sobreposição (issue, comentário, PR, merge) é pequena e o modelo é instruído a usar as tools nativas para isso e o conector (`tool_search`) para o resto. Se um dia as tools nativas cobrirem branch/arquivo/review, o conector passa a ser deduplicado em `NativeCoverage`.

## Riscos e limites
- **Sem Composio no v4.** Quem conectou o GitHub só pelo Composio não usa as tools nativas (o v4 diz que não está conectado e a dica manda procurar a ferramenta nos apps conectados). O Composio continua nos conectores genéricos do v4.
- **Pacote novo no deploy.** O worker passou a depender de `@workspace/github` por `dist`: o build do monorepo (turbo) cobre; imagem ou script que lista pacotes à mão precisa incluí-lo.
- **Duplicação pequena.** `createNativeGithubReadOps` e `resolveGithubReadOps` existem no pacote (sem Composio) e no `agent-runtime` (com Composio), porque os testes legados trocam o cliente e o token por mocks nos caminhos antigos. O `createAppGithubReadOps` é compartilhado.

## Testes
- `packages/agent/src/capabilities/github/github-capability.test.ts`: forma, validação dos args, ordenação e limite, filtro, outro dono, falha honesta, texto vazio.
- `apps/worker/src/v4-adapters/github.test.ts`: dono do run, outro dono sem GitHub, 401 (nativo marca, app não), erro redigido, cancelamento.
- `capabilities/github/github-write.test.ts`: forma (5 tools, `write_external`, ocultas sem dono ou sem porta), `confirm`, args inválidos e campo desconhecido, outro dono sem app, falha honesta.
- `apps/worker/src/v4-adapters/github.test.ts` (escrita): portão real com instalações por dono, token do app, link, B×A, app ausente, erro redigido, cancelamento.
- `economy.test.ts`, `presets.test.ts`, `contract-invariants.test.ts`, `v4-adapters/index.test.ts`, `engine-v4.test.ts`: lazy, `unavailable`, lista de tools do registro, conector GitHub preservado.
- `packages/github`: `client.test.ts` e `connection-token.test.ts` (movidos junto com o código).
