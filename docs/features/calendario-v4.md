# Calendário no Motor v4: ler, criar, mover e apagar eventos do Google Agenda

- **Status:** em andamento (F7.1, parte calendário; a parte de e-mail é de outra frente)
- **Data:** 2026-11-08
- **Issues/PRs:** #159, #161

## O que é
O bot lê e muda a agenda do Google do dono pelo chat: "o que tenho hoje?", "marca almoço com a Ana amanhã às 12h30", "passa a reunião para as 16h", "cancela o dentista". Ao criar ou mover, avisa na hora se o horário bate com outro compromisso.

## Problema
No v2 o Google Agenda só existe como ponte de conector: sem cartão, sem aviso de conflito e sem saber a data de hoje, o que fazia o bot errar o dia.

## Por que existe
Agenda é o dado mais útil do plano do dia e a escrita nela tem efeito em terceiros (convite por e-mail). Por isso virou uma capacidade nativa com efeito declarado por tool, e o conflito é calculado por código, por horário.

## Alternativas descartadas
- Manter a ponte do conector: o modelo escolhia a tool pelo nome, sem efeito `send` para convite e sem conflito.
- Recusar a criação quando há conflito: o dono pode querer dois compromissos juntos. A tool cria e informa; o bot oferece mover.
- Injetar a data no prompt de todo run: custo em toda conversa. `calendar_list` devolve "Now: ... (fuso)" e `calendar_create` recusa data no passado dizendo a data de hoje.
- Avisar os convidados por padrão ao alterar: reagendar incomodaria pessoas sem o dono saber. O padrão é não avisar; `notifyGuests` (ou passar convidados) vira `send` e pede aprovação.

## Como funciona
- `packages/shared/src/calendar.ts`: validação pura (data ISO, fuso do dono, convidados, duração), mescla de alteração, conflito por horário (livre, cancelado, recusado e dia inteiro não bloqueiam) e o cartão `calendar`.
- `packages/agent/src/capabilities/calendar/` (lazy, uma tool por arquivo): `calendar_list` e `calendar_get` (read, `untrusted/mcp`, `privateData`), `calendar_create` e `calendar_update` (`write_external`; com convidados ou aviso, `send`, com `recipients`/`externalRecipients`), `calendar_delete` (`destructive`, `confirm: "always"`; não avisa convidados e diz isso). A chave da chamada vira o id do evento no Google, então a retomada não duplica.
- Run de agenda (sem dono): o `decide` esconde criar, alterar e apagar; a capacidade é montada `readOnly` (só `calendar_list` e `calendar_get`, sem cartão). Testado.
- `apps/worker/src/v4-adapters/calendar.ts` (`realV4CalendarDeps`): token do cofre da conexão `google_calendar` **do dono do run** (`getFreshAccessToken`), chamadas por `googleFetch/googleJson` do conector embutido do v2. O escopo OAuth do catálogo (`calendar.readonly` + `calendar.events`) cobre inserir, alterar e apagar. Login expirado vira "reconecte"; erro do Google passa por `sanitizeErrorMessage`.
- Web: `ai-elements/calendar/` (`CalendarCard`, sobre `ChatCard`), evento SSE `calendar`, cartão persistido `calendar` com dedupe por `cardId` (uma alteração por chamada = um cartão).

## Riscos
- Só a agenda principal (`primary`) e a primeira conta Google conectada. Várias contas/agendas ficam para depois.
- Evento recorrente: alterar ou apagar vale para a ocorrência dada.
- Descrição, título e convidados são texto de terceiros: dado, nunca instrução; ler a agenda faz o run "contaminado" e criar evento depois pede aprovação, mesmo em autonomia total.
- Deploy com versões mistas: cartão e evento novos são aditivos; um web antigo ignora o papel desconhecido.

## Custo
Lazy: "Bom dia" ganha só uma linha do índice (teste em `calendar-capability.test.ts`).

## Como testar
`pnpm --filter @workspace/shared test`, `pnpm --filter @workspace/agent test`, worker `tsx --test src/v4-adapters/calendar.test.ts`, `cd apps/web && pnpm test`, `pnpm eval matrix --engines v4 --simulate`, prévias em `apps/web/e2e/calendar-brief-previews.spec.ts`.
