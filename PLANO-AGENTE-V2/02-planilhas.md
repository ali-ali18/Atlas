# F2 — Planilhas: criar e editar pelo conector, erros acionáveis

**Dono:** Bot A · **Depende de:** F1 (recomendado, não obrigatório) · **Status:** pronta para revisão

## Diagnóstico
- O agente tenta a planilha `1wfGr7S29JHpiX1fAvTNjonslMAeQhpXGmbedOpbcwhQ` e recebe `HTTP 403: The caller does not have permission`.
- A planilha foi **criada pelo agente** em 20/09 (run `cmu9nakj7000plglcj4s8h16o`, `navigate https://sheets.new`) no **navegador do sandbox**, logado em outra conta Google. O link ficou no resumo da conversa, e agora o conector (conta do usuário) não tem acesso.
- O conector Sheets só tem `get_spreadsheet`, `read_range` e `append_rows` (`packages/agent-runtime/src/mcp/builtin/google.ts:498-600`). Sem uma tool de criar, o agente cai no navegador.
- Os escopos estão ok: `spreadsheets drive.readonly` (`packages/shared/src/mcp-catalog.ts:284`).
- Erros do Google chegam crus: `errorResult("Erro ao chamar a API do Google: HTTP 403: …")` (`google.ts:621-625`, `google-api.ts:62-63`).
- `isAuthFailure` (`mcp/call.ts:16-21`) trata **qualquer** mensagem com "403" como falha de autenticação e muda a conexão para `pending_auth` (`mcp/runtime.ts:113-121,149`). Um 403 de permissão de arquivo pode desconectar o conector.
- A Agenda devolve `list_events` 404 por `calendarId` inválido (`google.ts:132` só usa `primary` quando vazio).

## Tarefas
- [x] Novas tools Sheets em `google.ts`, marcadas como escrita (não read-only):
  - `create_spreadsheet({ title, sheets?: string[], header?: string[] })` → `POST https://sheets.googleapis.com/v4/spreadsheets`, devolve `spreadsheetId` e a URL `https://docs.google.com/spreadsheets/d/<id>/edit`;
  - `update_range({ spreadsheetId, range, values })` → `PUT .../values/{range}?valueInputOption=USER_ENTERED`;
  - `add_sheet({ spreadsheetId, title })` → `POST ...:batchUpdate` com `addSheet`.
- [x] Mapear os erros do Google para mensagens acionáveis (em `google-api.ts`, função pura testável):
  - 403 + "does not have permission" → "A conta Google conectada não tem acesso a esse arquivo (ele pode ter sido criado por outra conta ou pelo navegador). Crie um novo com create_spreadsheet ou peça ao usuário para compartilhar o arquivo com a conta conectada.";
  - 403 + "has not been used" / "disabled" → "A API do Google está desativada no projeto do Google Cloud. O usuário precisa ativá-la.";
  - 403 + "insufficient authentication scopes" → "Falta permissão no conector: reconecte no Marketplace.";
  - 404 na Agenda → "calendarId inválido: use list_calendars ou 'primary'."; 404 genérico → "não encontrado (id errado ou sem acesso)".
- [x] `isAuthFailure` (`mcp/call.ts`): só 401, `invalid_token`/`invalid_grant` ou `insufficient authentication scopes`. **Um 403 de permissão de arquivo não desconecta.**
  - Extrair um predicado único e compartilhado.
  - Usar esse predicado também em `isAuthError` (`mcp/connect.ts:33-36`), que tem o mesmo regex `401|403`.
- [x] Skills do catálogo Sheets (`mcp-catalog.ts`): acrescentar "Criar planilha de acompanhamento".
- [x] **Prompt (texto do Bot C):** deixar anotado em `REVIEW.md` para C incluir na F3 ou F6: "Com um conector conectado, crie e grave recursos (planilhas, docs, eventos) pelo conector, nunca pelo navegador. Ao criar um recurso, salve em `memory` o link e qual conector é o dono."

## Testes obrigatórios
Com `GoogleFetchFn` mockado, seguindo os testes existentes do builtin Google:
- [x] `create_spreadsheet` monta o body certo e devolve o id e a URL.
- [x] `update_range` e `add_sheet` usam o método, a URL e o body certos.
- [x] Mapeamento de 403 (3 variantes) e 404 (Agenda e genérico).
- [x] `isAuthFailure`: 401 → true; 403 de permissão → false; `insufficient scopes` → true.

## Commits
1. `feat(connectors): Planilhas cria planilha, atualiza intervalo e adiciona aba`
2. `fix(connectors): erros do Google acionáveis e 403 de arquivo não desconecta`

## Critérios de aceite
- No `/run`: "cria uma planilha de histórico de preços do MacBook" → `mcp__google_sheets__create_spreadsheet`, e o link abre na conta conectada.
- Pedir para ler a planilha antiga (`1wfGr7…`) → o agente explica que ela é de outra conta e oferece criar uma nova.
- O conector Sheets continua `connected` depois do 403.

## Commits feitos
- 301b5c5 `feat(connectors): Planilhas cria planilha, atualiza intervalo e adiciona aba`
- 1171636 `fix(connectors): erros do Google acionáveis e 403 de arquivo não desconecta`
