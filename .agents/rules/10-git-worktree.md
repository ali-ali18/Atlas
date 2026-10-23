---
description: Git — um worktree por agente, branches, rebase, o que nunca fazer
alwaysApply: true
---

# Git e worktrees

## Um worktree por agente (obrigatório quando há mais de um agente)
O diretório principal `atlas-agent/` é do **usuário** e fica no branch dele (ex.: `checkpoint/agentic-baseline`). Agentes **não** trabalham ali nem trocam o branch dele.

```bash
# criar (a partir do branch base do plano)
git worktree add ../atlas-<agente> -b agente-v2/<agente> checkpoint/agentic-baseline
cd ../atlas-<agente>
pnpm install

# atualizar com a base
git fetch . checkpoint/agentic-baseline && git rebase checkpoint/agentic-baseline

# remover ao terminar (depois do merge)
git worktree remove ../atlas-<agente>
```

- Branch: `agente-v2/<agente>` (plano) ou `<tipo>/<assunto-curto>` (tarefa avulsa), a partir do branch base atual, nunca de `main` sem pedir.
- Antes de começar, confira `git worktree list` e `git branch --show-current`. Se estiver no diretório principal ou no branch errado, **pare** e corrija.
- Arquivo de outro agente apareceu no seu worktree (untracked ou modificado)? Não commite. Avise no `REVIEW.md`.

## Staging
- **Sempre** `git add <caminhos explícitos>`. Nunca `git add -A`, `git add .` nem `git commit -a`.
- Antes de commitar: `git diff --cached --stat`. Só devem aparecer arquivos da sua tarefa.
- Em arquivo com mudanças misturadas (suas e de outro), use hunks (`git apply --cached` com o patch só da sua parte).

## Proibido sem pedido explícito do usuário
- `git push` (qualquer um), `--force`, `reset --hard`, `checkout -- <arquivo>`/`restore` em arquivo que não é seu, `clean -fd`, `branch -D`, rebase de branch de outro agente.
- `--no-verify`, ou pular hooks e assinatura.
- Merge no branch base: é o revisor que faz, depois de aprovar (ordem definida no plano). Merge na `main` só com o ok do dono (ver `80-fluxo-de-trabalho.md`).

## Lock e concorrência
- `index.lock` existe → espere alguns segundos e tente de novo. Nunca apague o lock sem checar se há processo git ativo.
