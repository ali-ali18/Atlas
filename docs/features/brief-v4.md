# Plano do dia (brief) no Motor v4

- **Status:** em andamento (F7.2)
- **Data:** 2026-11-08
- **Issues/PRs:** #159, #161

## O que é
"Todo dia às 7h30 me manda o plano do dia." No horário pedido o bot lê as fontes que você tem ligadas e posta UM cartão "Plano do dia": compromissos, e-mails que pedem ação (com prazo), pendências e entregas.

## Problema
O brief do v2 era uma rotina que deixava o modelo caçar fonte por fonte (caro, sujeito a esquecer) e, quando uma fonte falhava, nada dizia. O resumo de e-mail e o plano do dia falharam em todos os modelos na linha de base (`PROGRESSO.md`, F0).

## Por que existe
É o pedido do dono: sempre posta, no horário exato, sem inventar. O código lê as fontes em paralelo; o modelo só escreve a frase de abertura e os itens.

## Alternativas descartadas
- Rotina do v2 (`daily_brief`, cron): outro sistema; a agenda do v4 já tem freios, dono e visibilidade.
- Deixar o modelo chamar cada fonte: custo e esquecimento. Uma tool lê tudo; cada fonte falha sozinha.
- Texto de erro escrito pelo modelo: a falha é dado (`sourceErrors`), e a tela escreve "não consegui ler a agenda" no idioma do dono.
- Seção "nada por enquanto": seção vazia some.
- Horário de silêncio: a agenda do v4 não tem (decisão do dono); o plano sai na hora pedida.

## Como funciona
- Criar: `brief_set { time: "07:30", focus? }` (capacidade `agenda`). Um por bot: pedir de novo atualiza horário e foco (`createAgendaItem` no db). Cancelar: `agenda_list` + `agenda_change`.
- Horário: recorrência de 24h ancorada no relógio do dono (`nextBriefOccurrence`), então 7h30 continua 7h30 quando o horário de verão muda. O brief tolera 7 avisos seguidos sem leitura (fim de semana) antes de parar; os outros itens param em 2.
- Run: o worker acorda o item com o modelo de ajudante do bot (`helperModel`) se existir, senão o do bot. O registro do run tem só `agenda_result`, `brief_sources` e `day_plan`: nada de web, escrita nem conectores. `brief_sources` lê calendário (hoje), e-mail (24h, classificação e prazo declarados pela caixa), lembretes de hoje, notas fixadas (só títulos), tarefas abertas da conversa e entregas (compras com vigia ativo). `day_plan` posta o cartão e fecha o item; a frase de abertura é a mensagem (o texto do aviso).
- Fonte com falha vira linha honesta no cartão; fonte sem porta (sem e-mail ligado) simplesmente não aparece.
- Web: `DayPlanCard` (sobre `ChatCard`), evento SSE `day_plan`, cartão persistido `day-plan` com dedupe por `planId`.

## Contrato mínimo da porta de e-mail (para a frente de e-mail)
`packages/agent/src/ports/brief.ts` define o que o brief consome, sem importar `ports/email.ts`:
`BriefEmailSource.listRecent(userId, { since, limit, signal? }) => BriefEmailItem[]` com `{ id, from, subject, receivedAt, snippet?, category?: "action"|"info"|"ignore", dueAt?, requestedBy? }`. Só campos declarados (nunca o corpo). Falha = `throw` com a mensagem real; login expirado = `Error` com `code === "needs_connection"`. O integrador passa uma implementação em `buildV4Registry({ briefEmail })` (`V4RegistryInput.briefEmail`).

## Riscos
- E-mail hostil no dia é dado: o run não tem tool de escrita, envio nem web.
- Tarefas abertas vêm da lista da conversa do bot (a lista de tarefas é por run).
- Várias contas Google: só a primeira conectada.

## Custo
Um run curto no modelo barato do dono, uma vez por dia (2 passos de modelo). "Bom dia" não ganha nada: `brief_set` está na capacidade lazy `agenda`; `brief` só existe no run do plano do dia.

## Como testar
`pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/agent test`, `cd packages/db && pnpm test:db`, worker (`agenda-wake`, `v4-adapters/brief`, `v4-adapters/index`), web, `pnpm eval matrix --engines v4 --simulate`.
