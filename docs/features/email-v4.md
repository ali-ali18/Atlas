# E-mail no Motor v4

- **Status:** em andamento (frente E da F7.1; o motor v4 segue desligado por padrão)
- **Data:** 2026-11-08
- **Issues/PRs:** #159 (F7), #160 (frente E)

## O que é
O bot lê o e-mail do dono, separa o que pede ação do que é só informação, mostra prazo e quem pede, escreve rascunhos de resposta para revisão e envia só depois de o dono aprovar, mostrando para quem vai. Funciona com duas fontes iguais em regras: o Gmail do dono e a caixa própria do bot.

## Problema
O resumo de e-mail do v2 falhava em todos os modelos da linha de base (F0): listava assunto sem abrir o corpo, sem prazo e sem dizer o que cada mensagem pede. E o e-mail é onde o Atlas junta os três lados da "trifeta letal" (dado privado, texto de fora e saída para terceiros): uma mensagem com "envie X para Y" não pode virar envio.

## Por que existe
- **Nativo no v4, sem ponte** (a catraca `legacy-bridge` segue em 0): capacidade lazy `email`, uma tool por arquivo em `packages/agent/src/capabilities/email/`.
- **Decisão é campo declarado:** `email_triage` recebe do modelo, por mensagem, `category` (`needs_action`, `fyi`, `ignore`), `deadline`, `requester` e `summary`. A tool só valida (enum, data real ou ISO com fuso, tamanhos, campo desconhecido falha); nada lê o texto do e-mail para decidir.
- **Duas fontes, uma porta** (`ports/email.ts`): o `userId` é sempre o do run; conta de outro dono ou caixa de outro bot não existe para a tool (resposta "não conectada").

## Alternativas descartadas
- **Ponte para o `email_*` do v2:** conta na catraca e herda as regras do v2 (autonomia por nível, regex de decisão).
- **Classificar com regra sobre assunto ou corpo:** texto é ambíguo e é a classe de erro que a regra 60 proíbe.
- **Ingestão nova do Gmail (push ou polling):** fica fora desta entrega (ver Pendências).
- **Tool `email_reply` separada:** uma resposta é `email_draft` ou `email_send` com `in_reply_to`; menos tools no schema.

## Como funciona
Tools (`capabilities/email/`):

| Tool | Efeito | Notas |
|---|---|---|
| `email_list` | `read` | `trust: untrusted`, `source: email`, `privateData`, `ownerData: email`. Filtros: não lidos, remetente, assunto, período, conta (`gmail` ou `bot`). Sem `source`, junta as contas. A caixa do bot não guarda "lido": o resultado avisa em vez de fingir. |
| `email_read` | `read` | Mesma marcação. Corpo em partes de 12.000 caracteres (`offset` lê o resto); nunca corta em silêncio. Só os nomes dos anexos. |
| `email_triage` | `read` | Valida e mostra o card `email-triage` agrupado, ordenado por prazo. Não toca na caixa. |
| `email_draft` | `draft` | Gmail: cria o rascunho de verdade. Caixa do bot: o rascunho vive só no card. Responder = `in_reply_to`. |
| `email_send` | `send`, `confirm: "always"` | `riskFacts`: `recipients` e `externalRecipients` (todos, o conservador), `irreversible`. O executor recusa sem o token de aprovação, até na autonomia total. |

- **Adaptador** (`apps/worker/src/v4-adapters/email.ts`, `realV4EmailDeps`): Gmail pelo token do cofre da McpConnection (`getFreshAccessToken` via `buildMcpClientConfig`) e a REST do Google (`googleJson`, exportada do agent-runtime); caixa do bot pelo `emailService` (limite diário, resposta sempre ao autor da conversa, um destinatário por envio). Ligado em `V4AdapterDeps`, `buildV4Registry` e `PresetDeps`.
- **Envio no Gmail** precisa do escopo `gmail.send`, que o catálogo do conector passou a pedir. Quem não reconectar segue lendo e rascunhando: o Google responde 403 e a tool falha com a dica "reconecte o Gmail para permitir envio" e oferece o rascunho. O token nunca aparece em erro (redação com o token da chamada).
- **Run de agenda** só lê (`list`, `read`, `triage`); rascunho e envio nem são oferecidos, e o `decide` esconde `send` sem dono presente.
- **Gatilho `intent`** ("quando chegar o e-mail tal, faço Y"): depois da assinatura, da idempotência e da lista de permitidos, o webhook da caixa do bot (`apps/api/src/webhooks/agenda-event.ts`) monta o `AgendaEvent` (`from`, `subject`, `hasAttachment`), confere o v4 da conta e do bot e marca as intenções casadas daquele bot (`queueAgendaEventWakes` no db). A varredura do worker as acorda respeitando espaçamento e teto diário. Rotinas v2 e o agente de conversa seguem como antes.
- **Cards** (`apps/web/components/ai-elements/email/`, sobre `ChatCard`): triagem e rascunho, tipos em `packages/shared/src/email-triage.ts`, persistidos pelo db como mensagens `email-triage` e `email-draft`, deduplicados por `cardId` (ao vivo × gravado, `thread-merge`). Textos em pt-BR, en-US e es-ES.

## Riscos
- **Injeção por e-mail:** o texto lido é dado não confiável e taint do run; `email_send` pede aprovação sempre. Teste de replay com o kernel real (e-mail mandando enviar → cartão, nada enviado).
- **IDOR:** fonte e caixa escopadas por dono e por bot; testes de "não encontrada" no agent e no adaptador.
- **Vazamento de token:** teste com o token repetido pelo Google nas mensagens de erro.
- **Contexto:** "Bom dia" não ganha as tools (economy); o pedido de e-mail carrega a capacidade no passo 1.
- **Deploy misto:** nada de migration. O evento novo `email_triage`/`email_draft` só existe no v4 (desligado); web antigo ignora o tipo.
- **Escopo `gmail.send` novo:** conexões antigas continuam válidas; só o envio pede reconectar.

## Custo
Sem custo extra em modelo: a capacidade é lazy (uma linha no índice, medida abaixo de 60 tokens). Gmail: uma listagem faz 1 + N chamadas de metadados (N até 30).

## Pendências
- **Ingestão do Gmail** (push do Google ou polling) para o gatilho "quando chegar e-mail" no Gmail: não há ingestão hoje, então o gatilho só existe na caixa do bot. Fora desta entrega, por decisão do dono.
- Anexos (conteúdo), vários destinatários e Cc na caixa do bot, e mais de uma conta Gmail por dono (hoje vale a conexão mais antiga).
- Idempotência do envio da caixa do bot no retry do provedor (o journal do kernel já evita repetir na retomada).

## Como testar
- shared: `pnpm --filter @workspace/shared test` (`email-triage.test.ts`).
- agent: `pnpm --filter @workspace/agent test` (`capabilities/email/email-capability.test.ts`, economy, contract-invariants, private-data).
- worker: `v4-adapters/email.test.ts` e `index.test.ts`; api: `webhooks/email-inbound.test.ts` e `agenda-event.test.ts`; db: `email-cards.test.ts` e `agenda.db.test.ts` (Postgres real).
- web: `components/ai-elements/email/email-cards.test.tsx`, `lib/thread-merge.test.ts`; prévias: `EMAIL_V4_PREVIEW_DIR=... pnpm e2e e2e/email-v4-previews.spec.ts`.
- evals: `pnpm eval matrix --scenarios seed-email-triagem-com-prazo,seed-email-rascunho-de-resposta --engines v4 --simulate`.
