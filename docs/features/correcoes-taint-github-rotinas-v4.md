# Correções do v4: taint do histórico, GitHub honesto e rotinas

## O que é
Três correções de auditoria no motor v4.

## Taint do histórico (S5)
Fala de outro bot, rotina ou webhook entra no histórico como `kind:"data"`. Agora o kernel marca o run como "já leu conteúdo não confiável" quando existe qualquer item `data` no histórico (sinal estrutural, sem olhar o texto). Efeito: `send_to_bot` e escritas externas pedem o cartão do dono nesses runs.

## GitHub honesto (S13, S11, S12)
- Bloqueio de identidade do app do GitHub vira erro em inglês para o modelo, sem prometer cartão que o v4 não mostra.
- `github_compare`: ref no formato git (sem `..`, sem `/` nas pontas, sem `~ ^ : ? * [ \ #`) e `repo` sem `..`; a mesma checagem roda em `fetchCompare`. Código em `packages/shared/src/git-ref.ts`.
- `listRepos` do app não inventa `main`: a branch padrão desconhecida é `null` e a tool não a afirma.

## Rotinas e painéis (P2, P5, P7)
- P2: pausar, retomar e apagar (inclusive grupo) reconciliam o webhook do repositório uma vez por repo, em melhor esforço. O adaptador recebe `ensureGithubHook` injetado (o worker liga ao `ensureGithubRepoHook` do agent-runtime em `processors/agent-run.ts`).
- P5: apagar rotina só com id ou nome exato; pedaço do nome vira erro pedindo o id.
- P7: `panel_update` recusa painel com link público quando o run já leu conteúdo de fora.

## Riscos
Run com fala de outro bot no histórico passa a pedir cartão em `send_to_bot`: é o efeito desejado. `defaultBranch` passou a `string | null` em `GithubRepo` e na porta.
