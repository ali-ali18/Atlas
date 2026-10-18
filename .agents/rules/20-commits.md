---
description: Commits semânticos (Conventional Commits em pt-BR) e atômicos
alwaysApply: true
---

# Commits

## Formato
```
<tipo>(<escopo>): <resumo no imperativo/descritivo, pt-BR, minúsculo, sem ponto>

<corpo opcional: o PORQUÊ e o que muda de comportamento, ~72 colunas>

Co-Authored-By: <modelo que escreveu> <noreply@...>
```

- **Tipos:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`, `style`, `revert`.
- **Escopos usados no repo:** `agent`, `api`, `web`, `worker`, `db`, `shared`, `queue`, `llm`, `sandbox`, `mcp`, `connectors`, `routines`, `auth`, `bots`, `groups`, `files`, `infra`, `ui`, `plano`, `review`.
- Exemplos reais:
  - `fix(agent): propose_profile_update só no onboarding ou com pedido explícito`
  - `feat(routines): lembrete de uma vez só (trigger once)`
  - `fix(db): conexões MCP escopadas por dono (fecha vazamento entre usuários)`
- Breaking change: `feat(api)!: ...` + `BREAKING CHANGE:` no corpo.

## Atômico
Um commit = **uma** mudança lógica que compila e passa nos testes sozinha.
- Separe: refactor ≠ feature ≠ fix ≠ formatação. Migration + código que a usa podem ir juntos. Migration de outra feature, não.
- Teste da mudança vai **no mesmo commit** da mudança.
- Não misture arquivos de fases ou donos diferentes.
- Commit grande (>~400 linhas de código) → pergunte se dá para quebrar.
- Cada commit do meio precisa passar em `typecheck` (o revisor pode usar bisect).
- Não reescreva commit que já foi para revisão. Ajuste pedido = commit novo (`fix(...)`/`refactor(...)`).

## Mensagem honesta
- O resumo diz **o que muda para quem usa**, não "update file".
- O corpo cita a causa de um bug quando ela não é óbvia.
