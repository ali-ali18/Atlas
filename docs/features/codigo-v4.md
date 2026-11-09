# Código no Motor v4 (capacidade `code` e presets `plan`/`build`)

- **Status:** em andamento (F8.2, frente C; o v4 segue desligado por padrão)
- **Data:** 2026-11-09
- **Issues/PRs:** #165 (mãe), #166 (frente C)

## O que é
O bot trabalha num repositório do dono: abre uma sessão de código, lê os arquivos em partes, edita com precisão, roda o teste que cobre a mudança e mostra o diff. O dono escolhe se o run só planeja (`plan`) ou também constrói (`build`).

## Problema
No v2 as sessões de código (`dev_session_*`) moram dentro do `computer-use` e do runtime antigo, com aprovação própria, e a lacuna apareceu no eval: sem banco o modelo respondia que "não há sessão ativa". O v4 precisa do mesmo poder (edição tolerante, allowlist de comando, teste focado) sobre a porta `Sandbox`, com o contrato de efeitos e aprovações únicos do motor.

## Por que existe
Reaproveitar o que já funciona (portão de comando e casamento de edição do v2) sob a política única do v4: o efeito de cada chamada sai do `decide()`, não de um modo de aprovação paralelo.

## Alternativas descartadas
- **Uma tool `code` com `action`:** esconde o efeito de cada ação. Uma tool por arquivo e por efeito deixa o `decide()` e o cartão de aprovação exatos.
- **Reimplementar o casamento de edição na capacidade:** a VM já o aplica (`docker/dev-sandbox/server/edit-match.mjs`) e devolve o diff. A capacidade só repassa e traduz a recusa. O fake de teste tem um porte, preso à VM por teste de paridade (`code-edit-match.parity.test.ts`).
- **Perguntar ao dono no bloqueio fixo (como o v2):** no v4 o que o v2 chama de "bloqueio fixo" (sair do ambiente, apagar fora do workspace, push) é recusado sem cartão; o cartão seria um atalho para o que a política quer impedir.
- **Abrir PR com `gh` e o token dentro da VM (v2):** no v4 o PR sai pela escrita nativa do GitHub (`githubWrite`, o app do dono), a mesma de `github_pr_create`; a VM só faz o push. Ver "Entrega: commit, push, PR e CI (F9)".

## Como funciona
Capacidade lazy `code` (`packages/agent/src/capabilities/code/`), nove tools, um `kind` da porta `Sandbox` cada (contrato em `kinds.ts`):

| Tool | `kind` | Efeito |
|---|---|---|
| `code_session` | `code.session` | `read` (só prepara um workspace descartável; o `plan` precisa dele) |
| `code_list`, `code_read` (em partes, com `nextOffset`), `code_git_status`, `code_diff` | `code.list`, `code.read`, `code.git_status`, `code.diff` | `read`, saída não confiável (`file`) |
| `code_edit`, `code_write` | `code.edit`, `code.write` | `write_internal` (reversível por git); `.env`, CI, auth e caminho sensível = `credential` (cartão em toda autonomia; sem dono a tool some) |
| `code_shell` | `code.shell` | só leitura = `read`; na allowlist = `write_internal`; fora da lista ou não analisável = `destructive`; ler `.env` = `credential`; bloqueio fixo = recusa sem tocar a VM |
| `code_test` | `code.test` | igual ao shell; só aceita executor de teste; suíte inteira só com `fullSuite: true` (o modelo declara quando o dono pediu; nada de regex sobre a fala) |

- **Portão:** a lógica é a pura de `packages/shared/src/dev-command-approval.ts` (`decideCommand`, `hardDenyReason`, `isSensitiveWrite`, `isFullSuiteTestCommand`). Nada foi copiado; a allowlist v4 é a do v2 mais os executores de teste.
- **Saída:** sempre por `redactSecrets` (texto a texto) e não confiável: ela entra na taint do run. Saída longa vai para um arquivo do workspace e o resultado diz o caminho para ler em partes.
- **Adaptador do worker** (`apps/worker/src/v4-adapters/code-actions.ts`, e `code-actions-real.ts` com banco e provedor Docker): escopo usuário + sessão (`getDevSession(id, userId)`); sessão de outro dono = "Coding session not found." sem tocar a VM; bloqueio fixo, caminho e parâmetros conferidos de novo na fronteira. Não é um `Sandbox`: é um tratador por kind (`handles(kind)` / `run(userId, action, signal)`) que o dispatcher da frente A chama.
- **Presets de política** (`packages/agent/src/presets/policy-presets.ts`, `applyPolicyPreset(id, política)`): regras `deny` no fim da lista do `decide()`, sem mexer em pisos.
  - `plan`: lê, lista, vê o diff e roda comando só de leitura. NÃO edita, não escreve, **não roda teste** (teste executa código do repositório) e esconde todo efeito que sai do Atlas. Anotar (lista de tarefas, memória) segue livre.
  - `build`: com dono, edita e roda comandos permitidos; `.env`, comando fora da lista e ler segredo pedem o dono. Sem dono (agenda, rotina, subagente, bot a bot) vira leitura.
  - Filho nunca excede a mãe: `childPolicy` de uma mãe `plan`/`build` continua só leitura.
- **Selecionar por run ou bot:** `engine-v4.ts` já aceita `policy`; o integrador faz `applyPolicyPreset(bot.codeMode, basePolicy)` e liga a capacidade com `code: {}` nas dependências do preset (e `code: { readOnly: true }` no `plan`). A capacidade é opt-in: não está em nenhum preset e só entra quando a chave `code` vem nas dependências (por isso `full` não ganha uma capacidade "indisponível" em quem não usa código).

## Entrega: commit, push, PR e CI (F9)
Quatro tools a mais na capacidade `code`, sobre kinds novos da porta `Sandbox` (`code.commit`, `code.push`, `code.pr_prepare`, `code.ci`, `code.ci_log`):

| Tool | Efeito | O que faz |
|---|---|---|
| `code_commit` | `write_internal` (`credential` se o modelo pedir `paths` de segredo) | Comita as mudanças da sessão; `branch` cria uma branch nova antes (obrigatório na branch padrão). Mensagem do modelo redigida (`redactSecrets`); arquivo de segredo (`.env`, chaves) no stage é recusado e o stage é desfeito. |
| `code_push` | `write_external`; com `confirmWrites` pede o dono em toda chamada | Envia a branch ATUAL. Sem argumento de branch (o modelo não escolhe o destino). Nunca força (refspec explícito sem `+`, sem `--force`) e nunca a branch padrão (a lida de `origin/HEAD`, mais `main` e `master`). Repositório = o da sessão do dono. |
| `code_open_pr` | `write_external`, mesma regra de confirmação | Abre o PR pela escrita nativa `githubWrite` (o app do dono, mesmo portão de `github_pr_create`). Repo, branch e base vêm da sessão (`code.pr_prepare`), não do modelo. Recusa se está na base, tem mudança solta, não tem commit novo ou a branch não foi enviada; se já há PR aberto da branch, devolve o link sem escrever. Só entra se a escrita nativa existe. |
| `code_ci_status` | `read`, saída não confiável (`file`) | Checks do PR da branch (ou de `number`, do mesmo repositório) com o resumo (passando, falhando, rodando). Com `jobId` lê o log do job EM PARTES: o fim primeiro, com `offset` para as outras partes e as linhas `##[error]` à parte. |

- **Credencial:** o token do GitHub do dono (instalação do app ou pessoal) entra só como `GH_TOKEN` no ambiente do job que fala com o GitHub (push, fetch, ls-remote); o helper de credencial da imagem o lê. Fica fora dos outros jobs, do resultado, dos eventos e do comando. Saída e erro passam por `redactSecrets` com o token da sessão.
- **Escopo:** tudo por `{ id, userId }` da sessão; o dono B recebe "Coding session not found." e nada chega à VM nem ao GitHub. A leitura de CI usa o token e o repositório da sessão do dono.
- **Política:** `plan` nega commit, push e PR (só o CI fica); `build` com dono libera o commit e segue a regra do GitHub para push e PR; sem dono (agenda, rotina, subagente) commit, push e PR ficam ocultos e só o CI lê.
- **Cartão:** o v4 não tem cartão de PR/CI do legado (os eventos `dev_pr`/`dev_ci` e o painel só existem para as sessões do motor antigo). Nesta frente o resultado é texto honesto com o link do PR e a lista de checks; cartão no chat do v4 fica para uma frente de UI.
- **Movido para `@workspace/github`:** `pull-ci.ts` inteiro (leitura de PR e checks, log de job e a criação de PR do legado), com reexport em `agent-runtime`; mais `cleanJobLog` e `jobLogErrors`, extraídos de `tailJobLog` (que segue igual).
- **Riscos novos:** push de uma branch que já existe no origin com avanço simples (corrigir o CI) é permitido; divergência é rejeitada pelo git e a tool diz para não forçar. O PR é aberto pelo app do dono (precisa estar instalado no repositório) e o push usa o token do dono: sem o app, a escrita nativa responde com a dica de instalar.
- **Fora desta frente:** esperar o CI terminar (a tool lê o estado agora e manda avisar o dono, sem polling), `dev_pr_checkout` do v2 e o cartão no chat.

## Riscos
- **Fake x VM:** o porte do casamento de edição pode divergir. Coberto por teste de paridade contra o `.mjs` da imagem.
- **Segredo na saída:** coberto na capacidade (`redactSecrets`) e no adaptador (segredos da sessão + padrões); teste com token e `Bearer`.
- **Sessão alheia:** teste de IDOR nas duas camadas (capacidade e adaptador).
- **`pnpm test` na raiz de um monorepo** não é reconhecido como suíte inteira (a sessão não informa se a raiz é workspace). Pendência: o adaptador informar `rootIsWorkspace`.
- **Sem servidor de desenvolvimento nem prévia** (`dev_preview`, jobs em segundo plano do v2): fora desta frente.
- **Deploy com versões mistas:** só código novo e uma chave nova opcional; nenhuma migration.

## Custo
"Bom dia" não cresce: a capacidade é lazy (só uma linha no índice); o pedido de código carrega o grupo no passo 1 (teste em `code-capability.test.ts`). Teto de "Bom dia" intocado.

## Como testar
- `pnpm --filter @workspace/agent test` (contrato, edição precisa, portão, `.env`, plan/build, sem dono, vazamento, economia, IDOR, paridade).
- `pnpm --filter @workspace/evals test`: o seed `seed-codigo-corrigir-bug-com-teste` roda em `matrix --engines v4 --simulate` com o repositório real `fixtures/code/fixture-loja`; o teste roda de verdade (falha, edita, passa). Substitui o gold 17 no v4 (o gold segue como baseline do v2).
- Worker: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/code-actions.test.ts`.

## F8.3 Code Mode
Não feito nesta frente. É experimento: só entra se ganhar na matriz.
