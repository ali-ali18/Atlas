# Rotinas no motor v4 (parte 1: ler e controlar)

- **Status:** entregue (F9, branch `feat/f9-rotinas-1`); a parte 2 (criar, propor, editar, gatilhos, alerta com veredito) vem em outra frente
- **Data:** 2026-11-09
- **Issues/PRs:** F9 (capacidades do legado que faltam no v4)

## O que é
O bot do motor novo enxerga e controla as rotinas do produto (a tabela `routines`, as mesmas que a Biblioteca mostra): lista as rotinas e alertas do dono com o gatilho em frase, pausa, retoma, apaga e organiza grupos, tudo pelo chat.

## Problema
No legado isso vivia em `agent-runtime` (`list_routines`, `routine_control`, `routine_group`). O v4 só tinha a `agenda` (lembretes e vigias do próprio motor, tabela `bot_followups`), então o bot novo não sabia dizer "quais rotinas eu tenho?" nem pausar uma. Os dois sistemas são diferentes e **não se misturam**: a agenda é do motor; rotina é do produto, com cartão, Biblioteca e grupos.

## Por que existe
Decisão do dono: toda capacidade do legado vem para o v4 com o contrato novo (escopo por dono, tool honesta, lazy, aprovação pela política). Regra de produto: o que o usuário faz pela UI o bot faz pelo chat.

## Alternativas descartadas
- Importar os handlers do `agent-runtime` no adaptador: proibido pela fronteira do pacote. O adaptador usa `@workspace/db` e `@workspace/shared`.
- Reaproveitar a `agenda` do v4 para as rotinas: tabela, gatilhos e telas diferentes; misturaria lembrete do motor com rotina do produto.
- Duplicar a frase do gatilho: `describeRoutineTrigger` (e `routineNextRunAt`) foram para `packages/shared` (`routine-trigger-summary.ts`, com teste) e o legado (`list_routines`) passou a usar a mesma função, com a saída idêntica.

## Como funciona
Capacidade `routines` (`packages/agent/src/capabilities/routines/`), lazy ("Bom dia" não ganha tool nem regra; só uma linha do índice):

| Tool | Efeito | Regra |
|---|---|---|
| `routine_list` | `read`, dado privado | Rotinas e alertas do bot do run: nome, gatilho em frase, ativa/pausada, grupo, frase do alerta, o que faz (até 280 caracteres), última execução e próxima execução **só quando se sabe** (uma vez e intervalo; cron e evento ficam sem, o gatilho em frase já diz a cadência). Filtros `onlyActive` e `onlyAlerts`. Vale também sem dono. |
| `routine_control` | `write_internal`; **apagar = `destructive`** | `pause`, `resume`, `delete` de UMA rotina por nome ou id. Apagar pede o cartão de aprovação em qualquer autonomia (o cartão diz qual rotina) e, sem dono, a tool fica fora. Repetir pausa/retoma diz "já está assim". Nome ambíguo lista as opções (nome e id) em vez de chutar. |
| `routine_group` | `write_internal` | `create`, `rename`, `delete` (desfaz o grupo, as rotinas ficam), `pause`/`resume` (o grupo todo), `move` (rotina para grupo que já existe) e `ungroup`. Grupo inexistente não é criado sozinho no `move`: o erro lista os grupos e manda usar `create`. |

- **Porta** `Routines` (`packages/agent/src/ports/routines.ts`): recebe sempre o `userId` do RUN; o bot do run já está dentro do adaptador. `null` = não existe ou é de outro dono (indistinguível).
- **Adaptador** (`apps/worker/src/v4-adapters/routines.ts`): sobre `listRoutines`, `updateRoutine`, `deleteRoutine` e as funções de grupo do db (que já filtram por dono e bot). Pausar/retomar/apagar sincronizam o agendador pelo mesmo gancho do legado (`syncRoutineScheduler`, ligado por `onRoutineMutated` desde `agent-run.ts` até `buildV4Registry`) e mostram o cartão `routine` (mesmo evento do legado, gravado na conversa). Operações de grupo emitem o cartão só ao vivo, como o legado.
- **Sem dono presente** (rotina, agenda, subagente): só `routine_list`. Sem bot no run, a capacidade não entra (`unavailable`).
- O texto para o modelo manda dizer nomes, nunca ids, e avisa que criar ou editar o que a rotina faz ainda não existe aqui.

## Riscos
- **Escopo por dono:** testes B×A na capacidade (`routines-capability.test.ts`), no adaptador (`routines.test.ts`: nenhuma escrita no db, nenhum cartão e nenhum sync para rotina de outro dono ou de outro bot) e na montagem do worker (`index.test.ts`).
- **Agendador:** pausar/apagar sem sincronizar deixaria o cron rodando. O sync é melhor esforço, como no legado (falha vira log, a mudança no banco fica e o boot reconcilia).
- **Retomar grupo com rotina de GitHub:** o legado também chamava `ensureGithubRepoHook` (vive no `agent-runtime`, fora do alcance do v4). Aqui o grupo retoma sem reinstalar o webhook no repositório; como pausar não remove o webhook, o impacto só aparece se ele nunca tinha sido instalado. Vai junto com os gatilhos GitHub na parte 2.
- **Deploy com versões mistas:** nenhuma migration, nenhum contrato novo no banco.

## Custo
Uma linha no índice do prompt (teste de economia em `guards/economy.test.ts`); sem chamada extra ao modelo.

## Fora desta parte (parte 2)
Criar/propor/editar rotina, gatilhos (cron, uma vez, intervalo, webhook, e-mail, GitHub), alerta com veredito, `routine_webhook_info`, painel atualizado por rotina e a permissão de login guardada na rotina. O modo de aviso (`notify_always`/`notify_important`) do `routine_control` legado também ficou de fora desta parte.

## Como testar
```bash
pnpm --filter @workspace/shared test
pnpm --filter @workspace/agent test
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/v4-adapters/*.test.ts" src/engine-v4.test.ts
```
