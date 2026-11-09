# Rotinas no motor v4 (parte 1: ler e controlar)

- **Status:** entregue. Parte 1 (ler e controlar, branch `feat/f9-rotinas-1`) e parte 2 (criar, editar, gatilhos, alerta com veredito, webhook, painel da rotina, permissão de login, proativo; branch `feat/f9-rotinas-2`)
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
- O texto para o modelo manda dizer nomes, nunca ids, e ler a lista antes de mudar algo (a parte 2 trouxe criar e editar).

## Riscos
- **Escopo por dono:** testes B×A na capacidade (`routines-capability.test.ts`), no adaptador (`routines.test.ts`: nenhuma escrita no db, nenhum cartão e nenhum sync para rotina de outro dono ou de outro bot) e na montagem do worker (`index.test.ts`).
- **Agendador:** pausar/apagar sem sincronizar deixaria o cron rodando. O sync é melhor esforço, como no legado (falha vira log, a mudança no banco fica e o boot reconcilia).
- **Retomar grupo com rotina de GitHub (parte 1; resolvido pelo gancho `ensureGithubHook` do worker):** o legado também chamava `ensureGithubRepoHook` (vive no `agent-runtime`, fora do alcance do v4). Aqui o grupo retoma sem reinstalar o webhook no repositório; como pausar não remove o webhook, o impacto só aparece se ele nunca tinha sido instalado. Vai junto com os gatilhos GitHub na parte 2.
- **Deploy com versões mistas:** nenhuma migration, nenhum contrato novo no banco.

## Custo
Uma linha no índice do prompt (teste de economia em `guards/economy.test.ts`); sem chamada extra ao modelo.

## Parte 2: criar, editar, alerta, painel, login e proativo (F9, branch `feat/f9-rotinas-2`)

### Tools novas (mesma capacidade `routines`, lazy; nenhuma existe sem dono presente)
| Tool | Efeito | Regra |
|---|---|---|
| `routine_create` | `write_internal`; **com `loginAccess` = `credential`** | Cria UMA rotina ou alerta: `name`, `task`, gatilho (`triggerType` + campos), `timezone`, `group` (por nome, reaproveita ou cria), `panelId`, `notify`, `alert`, `loginAccess`, `enabled`. Como no legado (`propose_routine`), criar não tem cartão de proposta: a rotina nasce e o cartão `routine` (`action: created`, gravado na conversa) aparece. Mesmo nome de uma existente recusa e manda usar `routine_update` (nunca duplica nem edita às escondidas). |
| `routine_update` | `write_internal`; **com `loginAccess` novo = `credential`** | Edita UMA rotina (nome ou id): o que vier muda, o resto fica. Para mudar o gatilho manda `triggerType` e TODOS os campos dele (o legado aceitava remendo parcial do GitHub; aqui o gatilho é sempre completo e validado). `group: ""` tira do grupo, `panelId: ""` desliga o painel, `alert: null` volta a rotina comum, `loginAccess: null` tira a permissão. Atualiza o cartão com o mesmo `routineId` (sem gravar um novo, como o legado). Dono B recebe "não achei" (nada muda). |
| `routine_webhook_info` | `read`, dado privado | Endereço público do webhook das rotinas do bot e o cabeçalho `X-Atlas-Hook-Secret`. O segredo NUNCA aparece (nem ao modelo, nem em cartão, nem em evento): o dono o copia da rotina na Biblioteca ("Gerar novo segredo"). |
| `suggest_routine` | `write_internal` | Ideia do bot (não pedida): vira cartão "Posso criar esta rotina?" (Criar / Agora não) e NÃO cria; só no modo automático que o dono escolheu a rotina nasce e o cartão tem "Desfazer". Só no bot principal com o modo proativo ligado (o adaptador confere; senão lança com o motivo). Duplicada e já proposta voltam como erro. Ideia do bot nunca é mais frequente que 2 h. |
| `report_alert` | `write_internal` | Só em run de rotina de alerta (capacidade `routine-run`, núcleo). Grava o veredito (`triggered` + frase com o valor) no objeto do run; quem decide avisar, com debounce, é o worker (`planAlertRun`), como no legado. Um por run. A nota "isto é uma conferência" entra como seção de contexto do run. |
| `notify_user` | `write_internal` | Só em run de rotina marcada "só importante" (mesma capacidade `routine-run`; nunca junto de `report_alert`). Push avulso ao dono: um por run, 240 caracteres, nunca no horário de silêncio dele. Substitui o `notify_user` só-push do legado. |

### Gatilhos e regras
- Validação pura em `capabilities/routines/routine-trigger.ts`, com os validadores de `@workspace/shared` (os mesmos do legado e da API): cron de 5 campos; uma vez (`runAt` no futuro e até 1 ano, ou `inMinutes`, nunca os dois); intervalo de 5 a 1440 min; e-mail (filtros opcionais); GitHub (repo e eventos aceitos, URL colada vira `owner/name`); webhook genérico. Campo de outro tipo de gatilho, campo desconhecido e fuso inválido FALHAM com a lista do aceito (nada é ignorado em silêncio).
- **Intervalo mínimo de 2 h (regra de produto)** vale para o alerta por intervalo (`alert`) e para a sugestão do bot, salvo pedido explícito do dono (`alert.frequent: true`, que o modelo só põe quando o dono pediu). O intervalo comum (não alerta) segue de 5 min a 24 h como no legado ("a cada 50 min" para monitorar PR). Alerta só combina com cron ou intervalo.
- **Adaptador**: `create`/`update` mapeiam para `createRoutine`/`updateRoutine`/`convertRoutineToGenericWebhook` do db, sincronizam o agendador (`onRoutineMutated`) e o webhook do GitHub (`ensureGithubHook`): se o webhook não liga, a rotina criada é desfeita e a edição volta ao gatilho anterior (como o legado), com o motivo real; sair de um repositório (ou trocar de repo) encolhe o hook antigo. Sem o gancho no run, gatilho GitHub falha antes de gravar.
- **Webhook genérico**: o segredo é gerado e selado no db e nunca sai de lá. O resultado da tool e o cartão têm só o endereço. (O marcador `{{secret:rotina:slug}}` para ligar n8n por conector fica fora, ver abaixo.)

### Painel atualizado por rotina
No run de rotina com `pageId`, o adaptador de entregas (`createV4Deliverables`, `routinePageId`) só aceita atualizar ESSE painel (outro, mesmo do dono e do bot, é recusado com o id certo) e grava com `refreshed: true` (a "atualizado em" do painel), como o legado. Usa o `panel_update` de sempre (`capabilities-builtin/deliverables/panel-tools.ts`, sem mudança).

### Permissão de login na rotina (decisão do dono, 09/11)
1. **Declarar.** Ao criar ou editar, o modelo declara `loginAccess: { login, site }` (campo declarado, sem regex sobre texto). A tool confere contra o cofre do dono: o login existe, tem site salvo e esse site (normalizado por `siteKey`) é o declarado. Login de outro dono ou inexistente = "não achei".
2. **Aprovar.** Declarar muda o efeito da chamada para `credential`: o cartão de aprovação aparece em qualquer autonomia, com "Usar o login X para entrar em Y nesta rotina" (a web e o celular passaram a mostrar o alvo no cartão de credencial). Sem dono presente a tool nem existe.
3. **Guardar.** Aprovado, a rotina grava `loginPermissionJson = { login, site, approvedAt }` (migration só aditiva, coluna JSON nula, `20261218000000_routine_login_permission`). Editar a rotina sem `loginAccess` mantém a permissão; `loginAccess: null` a tira.
4. **Usar.** No run da rotina, o worker lê a permissão do dono do run (`getRoutineLoginPermissionForAgentRun`) e o registro ganha um `login_fill` só para aquele login (fixo: o modelo não escolhe nome nem site) e SÓ naquele site. O tratador da VM recebe `onlySite` e só digita quando o site da página bate (mesma normalização), conferindo de novo antes de CADA campo, além de tudo o que já vale (https, site salvo do login, campo e origem na VM). Efeito `write_internal` (a aprovação foi a da criação): sem dono não há cartão por uso. O valor nunca passa pelo modelo.
5. **Sem permissão ou site diferente:** o run só tem `secret_list` (e a instrução manda dizer, no resultado da rotina, que não entrou); site diferente, a VM recusa com o motivo e a tool manda dizer que não entrou. Rotina com permissão para o site A e login salvo em outro site é recusada na criação e no uso.

### Riscos da parte 2
- **Escopo por dono:** testes B×A para criar/editar (`routine-save.test.ts`, `routines-save.test.ts`), webhooks, a permissão de login (B não declara nem usa o login de A, no cofre e no tratador) e o painel (B continua "não existe").
- **Deploy com versões mistas:** a única mudança de banco é uma coluna JSON nula; api e worker antigos ignoram. Rotina criada pelo legado não tem permissão (sem login na rotina, como hoje no v4).
- **Edição concorrente do GitHub:** igual ao legado (melhor esforço, reverte quando o hook falha).
- **Custo:** sem chamada extra ao modelo. A capacidade segue lazy ("Bom dia" intacto, ver `economy.test.ts`); `report_alert`/`notify_user` só existem em run de rotina que precisa deles.

### O que ficou de fora
- `alert.rule` (regra determinística lida sem modelo, com teste ao vivo na criação): depende de `testAlertRule`/leitores que vivem no `agent-runtime`. No v4 o alerta é o de condição (o modelo confere e chama `report_alert`).
- Modelos de rotina `daily_brief` e `github_security_review` e o campo `model` por rotina: o plano do dia tem a capacidade `brief` própria; o resto não foi pedido.
- Remendo parcial do gatilho GitHub/e-mail na edição (o v4 exige o gatilho completo).
- Marcador `{{secret:rotina:slug}}` (ligar n8n/Zapier por conector sem colar o segredo): `routine_webhook_info` mostra só o endereço. Fica para a frente do cofre.
- `notify_user` no chat (push no meio de uma tarefa longa) e na reflexão do legado: no v4 os avisos de lembrete e vigia saem pelo `agenda_result` (`update`), que a agenda já cobre; só o push da rotina "só importante" foi trazido.
- Modo de aviso (`notify_always`/`notify_important`) no `routine_control`: agora se muda por `routine_update` (`notify`).

## Como testar
```bash
pnpm --filter @workspace/shared test
pnpm --filter @workspace/agent test
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/v4-adapters/*.test.ts" src/engine-v4.test.ts
```
