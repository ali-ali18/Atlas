---
description: Regras gerais do monorepo Atlas (vale para qualquer agente e tarefa)
alwaysApply: true
---

# Core — como trabalhar no Atlas

## Stack e comandos
- Monorepo **pnpm + turbo**, TypeScript.
  - Apps: `apps/api` (Hono), `apps/worker` (BullMQ), `apps/web` (Next.js).
  - Pacotes: `packages/{shared,db,agent-runtime,queue,llm,sandbox,search,mail,ui}`.
- **Só pnpm.** Nunca `npm`, `npx` ou `yarn`. Rodar binários com `pnpm exec`, filtrar com `pnpm --filter @workspace/<pkg>`.
- O `apps/web` usa uma versão do Next.js com breaking changes. Antes de mexer em APIs do Next (rotas, data fetching, config), leia `node_modules/next/dist/docs/`.

## Antes de mudar
- Leia o código ao redor e **reaproveite** o que existe: helpers em `packages/shared`, componentes em `packages/ui`, padrões de teste vizinhos. Não crie um utilitário paralelo.
- Pesquisa larga (3+ arquivos desconhecidos, "onde fica X?") → delegue a subagentes de exploração em paralelo e integre só a conclusão.
- Tarefa de um plano (`PLANO-*/`) → siga o arquivo da fase: dono, arquivos permitidos, testes e commits.

## Posse e escopo
- Cada agente só edita os arquivos que são seus (tabela de posse no plano ativo). Tocar em arquivo de outro dono → anote em `PLANO-*/REVIEW.md` (arquivo, motivo, trecho) **antes** e faça a mudança mínima.
- Não "aproveite para arrumar" coisa fora do escopo da tarefa. Anote como sugestão.
- Mudanças não commitadas que não são suas (ex.: `apps/web/components/ui/templates/template-4/*` do usuário) **nunca** são staged, revertidas nem formatadas.

## Pronto = verificado
Uma tarefa só está pronta com:
1. testes novos ou ajustados cobrindo a mudança (ver `50-testes.md`);
2. `pnpm exec turbo typecheck` verde;
3. suítes do pacote tocado verdes;
4. commit atômico e semântico (ver `20-commits.md`).

Relate falhas com o output real. Nunca diga "passou" sem ter rodado.

## Idioma
- Conversa com o usuário, commits, comentários e docs: **pt-BR**.
- Identificadores de código: inglês.
- Texto que vai para o modelo (prompts): ver `60-agente.md`.
