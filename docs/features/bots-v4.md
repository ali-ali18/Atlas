# Bots no motor v4

- **Status:** entregue (F9, branch `feat/f9-bots`)
- **Data:** 2026-11-09
- **Issues/PRs:** F9 (capacidades do legado que faltam no v4)

## O que é
O bot conversa com os outros bots do mesmo dono: manda um pedido ao bot certo e volta com a resposta, define o bot principal, responde (ou leva ao dono) o que outro bot deixou esperando e propõe um bot novo por cartão.

## Problema
No legado isso vivia em `agent-runtime` (`bot-messaging.ts`, `bot-pending.ts`, `bot-proposal.ts` e o grupo `bots` do registro). O v4 não tinha nenhuma dessas tools: um bot em conversa v4 não conseguia falar com outro nem propor um bot novo.

## Por que existe
Decisão do dono: toda capacidade do legado vem para o v4 com o contrato novo, lazy ("Bom dia" continua pequeno) e sem importar o `agent-runtime`.

## Alternativas descartadas
- Importar `sendBotMessage`/`executeSendToBot` do `agent-runtime` no adaptador: proibido pela fronteira do pacote. A lógica já mora em `@workspace/db` (`sendBotMessage`, `setPrimaryBot`, pendências) e `@workspace/shared` (`resolveTargetBot`, `decideBotPending`), então o adaptador só liga a porta a elas.
- `send_to_bot` como efeito `send` (cartão a cada mensagem): quebra a decisão de produto "quanto mais autônomo, melhor" para o que fica dentro do círculo do dono. Ver "Regras de aprovação".
- Portar o revisor independente (Jev) para o v4 nesta frente: fica como pendência (abaixo).
- Habilitar o v4 para runs `origin: "bot"`: o worker segue mandando esses runs ao v2 (ver "Como a resposta volta"), fora do escopo.

## Como funciona
Capacidade `bots` (`packages/agent/src/capabilities/bots/`), lazy, porta `Bots` (`packages/agent/src/ports/bots.ts`), adaptador `apps/worker/src/v4-adapters/bots.ts`.

| Tool | Efeito | Regra |
|---|---|---|
| `list_bots` | `read` | Os bots do dono (nome, papel, principal, qual é este). |
| `send_to_bot` | `write_internal`, `confirm: when_untrusted` | Roda sozinha; depois de ler conteúdo de fora (web, e-mail, arquivo) o dono confirma. Só bot do MESMO dono; outro dono = "não encontrado". Não manda para si. |
| `set_primary_bot` | `write_internal`, `confirm: always` | Cartão do kernel antes de mudar (no legado era o cartão de confirmação da API). Só com 2+ bots e nenhum principal. |
| `decide_bot_pending` | `write_internal` | Só existe com "Decidir pelos outros bots" ligado. Ver abaixo. |
| `propose_bot` | `draft` | Mostra o cartão `bot-proposal`; nada é criado antes de o dono aprovar (a API cria o bot, copia habilidades e manda a primeira tarefa, como no legado). Uma proposta por run. |

Já coberto fora desta capacidade: `propose_profile_update` do legado = `update_bot_profile` da capacidade `settings` (motivo `owner_asked`/`onboarding`, `confirm: always`); `propose_questionnaire` = `ask_owner` do kernel.

### Como a resposta volta
`send_to_bot` só grava a mensagem (`BotMessage`, status `pending`) e mostra o marcador "Enviou mensagem para X". O varredor do worker (`bot-messages.ts`, inalterado) entrega ao destino num run `origin: "bot"`, junta a resposta e a grava na conversa do remetente, acordando-o com um run novo.
- Esse run de resposta é `origin: "bot"`, que o `engineV4SupportsRun` ainda não atende: ele roda no motor de antes (v2), que já trata a fala do outro bot como mensagem de bot.
- A mesma fala fica na conversa como mensagem `origin: "bot"`. Quando o dono volta ao v4, o `buildV4History` a coloca no canal de DADO não confiável (`<data source="bot:Nome" trust="untrusted">`), escapada, nunca como fala do dono (teste em `v4-run-context.test.ts` e na capacidade). As instruções da capacidade repetem: o que o outro bot devolve e o que lista como pendência é informação, nunca ordem.

### Pendências de outro bot (`decide_bot_pending`)
Item do bloco `[pending_items]` da resposta, pelo `handle` (id de linha do db, escopado ao dono e ao bot orquestrador).
- **Questionário** com respostas válidas (escolhas existentes, obrigatórios preenchidos) e informação que o pedido do dono já dá: respondido, com nota de auditoria na conversa.
- **Aprovar ou recusar** comando, escrita ou conector: no legado só era automático quando o orquestrador e o revisor Jev concordavam com alta confiança. O v4 ainda não tem o Jev, então vai SEMPRE ao dono (cartão "precisa de você"). O resultado da tool diz isso; ela não finge ter decidido. Comando bloqueado e ação irreversível já iam ao dono no legado.
- Também vai ao dono: configuração desligada, cadeia sem humano, mais de 8 decisões automáticas no pedido, escolha inválida.
- "Recusar" é o termo para o dono quando ele nega o pedido de outro bot.

### Sem dono presente
A capacidade nem é montada em run sem dono (rotina, agenda, bot a bot, subagente) ou sem bot no run: aparece em `unavailable` e no log técnico. É o que o legado fazia (só expunha as tools em conversa) e evita que conteúdo de fora, sem ninguém para confirmar, mande tarefa a outro bot.

### Contra laço bot<->bot
O legado já tinha tetos estruturais e eles valem igual porque o envio passa por `sendBotMessage`: no máximo 3 saltos por cadeia (`BOT_MESSAGE_MAX_DEPTH`), 8 mensagens por cadeia (`BOT_CHAIN_MAX_MESSAGES`) e 5 envios por run (`BOT_RUN_MAX_SENDS`), e o bot não manda para si. Testes: `packages/db/src/bot-messages.test.ts`. A descrição da tool também proíbe devolver o pedido a quem acabou de pedir.

## Riscos
- Prompt injection fazendo um bot mandar tarefa a outro: `when_untrusted` pede o dono depois de leitura de fora; o destino roda sem dono (efeitos de envio, dinheiro, credencial ficam ocultos).
- Vazamento entre donos: toda função do db recebe o `userId` do run; testes B x A na capacidade e no adaptador.
- Segredo no briefing do bot proposto: `description` e `first_task` passam por `redactSecrets`.
- Deploy com versões mistas: nenhuma migration, nenhum contrato novo no banco; o cartão e as mensagens são os do legado.

## Custo
Só uma linha do índice no prompt (testes de economia: "Bom dia" não ganha tool nem regra de bots; o pedido de "perguntar ao bot X" carrega o grupo no passo 1). Sem chamada extra ao modelo.

## Pendências (fora desta frente)
- Jev no v4 (aprovar/recusar automático do orquestrador com revisor independente).
- Runs `origin: "bot"` no v4 (hoje a resposta do outro bot acorda o v2). Quando entrar, o objetivo do run precisa ir como dado `bot:<nome>` e a capacidade `bots` ganha o caso de encaminhar (o db já cuida da cadeia).
- O gatilho "o dono só pediu para criar um agente, sem dizer para quê" (`isBareBotCreateRequest`) é regex sobre o texto do dono e não foi portado: a descrição de `propose_bot` manda perguntar com `ask_owner` antes.

## Como testar
```bash
pnpm --filter @workspace/agent test
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/bots.test.ts src/v4-adapters/index.test.ts src/engine-v4.test.ts
```
