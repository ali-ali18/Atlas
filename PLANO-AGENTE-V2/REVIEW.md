# Log de revisão

Preenchido pelo revisor (sessão principal) e pelos bots, para notas de conflito e de posse de arquivo.

## Notas de posse / conflito
_Formato: `data · bot · arquivo (dono) · motivo · trecho`_
- 28/09/2026 · Bot A · packages/agent-runtime/src/computer-use.ts (Bot B) · F1 honestidade mínima: executeGithubListRepos devolvia texto de erro com ok:true, passa a lançar (ok:false) · trecho executeGithubListRepos:2286-2325 (só as 3 branches de erro de conexão/listagem; nenhum outro executor tocado)

## Revisões

### Plano × código (antes da implementação) · 28/09/2026 · revisor
- Entrada: relatório de 4 subagentes que conferiram os 11 arquivos contra o código.
- Veredito: **plano aprovado para execução**. Todas as lacunas apontadas são o trabalho previsto (F1–F9 ainda não começaram) e as referências `arquivo:linha` batem.
- Conferido direto no repo:
  - Branches `agente-v2/*` não existem. Esperado: cada bot cria o seu ao começar.
  - `mcp/connect.ts:33-36` (`isAuthError`) também trata 403 como auth. **Adicionado à F2.**
  - "Redirect 3000 × 3001" **não é bug**: `ATLAS_URL=http://localhost:3000` está certo (web + rewrite → API 3001). `NEXT_PUBLIC_API_URL` é config morta. Risco real: abrir o app por `127.0.0.1` perde o cookie no callback. **Anotado nas ações do usuário.**
  - Colisão de timestamps das migrations: regra de geração no commit + rebase **adicionada ao README**.
  - `OPENROUTER_FALLBACK_MODELS` não existe: esperado, é criado na F4.
  - `runs.ts:1397` (offset incerto): o bot da F4 localiza o `conversationMessage.create` do finalize por Grep, sem depender da linha.
- Helpers a extrair (sugestão dos subagentes, **adotados**):
  - `ownerIds` e `resolveMcpConnection` (F1), `claimDefaultConnections` (F1);
  - `mapGoogleApiError` e o predicado de auth compartilhado (F2);
  - `formatIntervalSummary` (F3), `shouldRetryPlaywrightError` (F4), `languageInstruction` (F6);
  - `group-turns.ts` puro (F8B), `persistFileArtifact` (F9).
- Bloqueio resolvido (28/09): `template-4/*` commitado em `271f3d5`; F6a-web mergeada, F8B e F9C liberadas.
### F4 — Confiabilidade (parte Bot B) · branch agente-v2/bot-b
- Commits: 3b70b7d travas por tool · 2f25ae5 sandbox resiliente · ca8431a questionário tolerante · 5cd7b54 llm retry+fallback · 32598e3 worker lease/conversa · 27558b5 mcp pin · bcc52b8 falhas em lote/erro de argumento (caso loja-exemplo) · 5245723 resumo final em run travado
- Testes: turbo typecheck 12/12 · shared 195/195 · agent-runtime 276 ok/10 skip · api 60/60 · worker 16/16 · llm 11/11 · sandbox node:test 4/4 · db conversation-alive 1/1
- Testes (caso loja-exemplo): agent-runtime 361 ok/10 skip (+29 novos: tool-failure 22, computer-use.failures 7) · shared 272/272 · worker 20/20 · turbo typecheck 12/12
- Verificação manual: pendente (`/run` "MacBook M5 Pro 24GB/1TB em 5 lojas" com Firecrawl falhando) + `/run` loja-exemplo: ler arquivos inexistentes não derruba o run
- Notas: parte MCP (Bot A) fora do escopo, fica para o Bot A. `routine-interval.*` (scaffold F3 de subagente cancelado) movido para `C:\Users\aliss\AppData\Local\Temp\opencode\` — Bot C restaura no bot-c. Lease-abort testado via `tickLeaseHeartbeat` (fiação de 3 linhas segue o caminho do `!ok`). `OPENROUTER_FALLBACK_MODELS` documentado nos `.env.example`, falta valor no `.env` real (ação do usuário).
- Veredito: pronto para revisão
- Ajustes pedidos:
  - [ ] (revisor)

### F4 — parte MCP · Bot A · branch agente-v2/bot-a
- Commits: c39a486 timeout por conector + retry em erro passageiro · dc30777 dicas acionáveis Firecrawl/GitHub · 688d201 retry só em erro passageiro reconhecido (ajuste da revisão)
- Testes: turbo typecheck 12/12 · shared 272/272 · agent-runtime 346 ok/10 skip (13 novos em `mcp/call-retry.test.ts`: classificador de retry, retry 1x com sucesso/falha, auth e 404 sem retry, timeout por conector, dicas)
- Verificação manual: pendente (`/run` com Firecrawl lento/falhando: scrape >30 s conclui em até 90 s; `get_file_contents` em caminho inexistente mostra a dica do ref)
- Notas: retry mora em `mcp/call.ts` (onde o `isError` é visto), classificador puro em `mcp/retry.ts`; dicas em `mcp/hints.ts` por `catalogId`. Ajuste da revisão: retry 1x só quando o texto casa com o padrão transitório (timeout, 5xx, rate limit, 429, ECONNRESET…); isError sem padrão, "All scraping engines failed" e "tool desconhecida" não repetem (teste volta a ser instantâneo). Login, 4xx e validação nunca repetem. Neste worktree foi preciso `prisma generate` + `tsc` no db (client desatualizado após o ff-merge).
- Veredito: pronto para revisão
- Ajustes pedidos:
  - [ ] (revisor)

### F1 — Conexões por dono · Bot A · branch agente-v2/bot-a
- Commits: aff1f3e fix(db) escopo por dono · a406d02 feat(db) claim boot · 07fa7d5 fix(agent) honestidade github_list_repos
- Testes: apps/api mcp-ownership 7/7 + scope/mcp 13/13 (20/20) · agent-runtime computer-use.github 3/3 · tsc db/api/agent-runtime ok
- Verificação manual: pendente (`/run` Jujuba "monorepo loja-exemplo" + `select catalogId,userId from mcp_connections` + 2º usuário)
- Veredito: pronto para revisão → **revisor: AJUSTES** (28/09/2026)
- O que está bom:
  - `ownerIds`/`resolveMcpConnection` batem com `isOwnedBy`; `listConnectedMcpConnections` agora filtra (o vazamento está fechado) e o `runtime.ts:161` passa o `userId`;
  - o fallback `"default"` no `getMcpConnectionByCatalogId` fica só para a mesma pessoa;
  - `claimMcpConnectionOwner` não rouba linha de outro dono;
  - `github_list_repos` falha de verdade;
  - a extração do claim-default está idempotente e o script reaproveita a função.
- Ajustes pedidos:
  - [x] **(bloqueante) Claim-default quebra com colisão de unique.** Feito em `2398c9b`: dentro da transação, antes do `updateMany` — mcp duplicada por catálogo apaga (a própria ganha); slug colidido renomeia (`<slug>_2`…); skill colidida pula (fica `"default"`, fallback cobre — escolha documentada no header de `claim-default.ts`); settings legada apaga se o dono já tem a sua (achado extra: `user_settings.userId` também é `@unique`). Teste in-memory no `mcp-ownership.test.ts` cobre o cenário pedido.
  - [x] **Tools MCP duplicadas no run.** Feito em `2398c9b`: `listConnectedMcpConnections` deduplica por `catalogId` com `resolveMcpConnection` (null não deduplica), com teste.
  - [x] **Processo: worktree por bot.** `../atlas-bot-a` criado com `pnpm install` próprio; diretório principal de volta ao `checkpoint/agentic-baseline`. Faltam os worktrees do b e do c (bot-b já está commitado; bot-c quando a F3 começar).
  - [x] (menor) `apps/api/src/routes/mcp.ts:379`: indentação do `try {` corrigida.
  - [x] **2ª revisão (MED) — VALIDATE CONSTRAINT parava no meio.** Feito em `d8c65ac`: skill legada colidida não é mais pulada; é reivindicada como `<key>_legado` (`_legado_2`…) e `enabled=false` (`capabilityKey` só existe em `skills`; versões apontam por `skillId`, então renomear é seguro), contador `skillsRenamedConflicts`. A validação agora é por constraint (try/catch próprio, 42704 logado e segue) e retorna `{ validated, failed }`. Testes in-memory no `mcp-ownership.test.ts`.
  - [x] **2ª revisão (baixo) — indentação do `try {` OAuth em `mcp.ts`.** Feito em `6e230f7` (só espaço em branco).
  - [x] **Verificação manual (revisor, 28/09) — achou bug (ALTO):** o lock `tx.$queryRaw\`SELECT pg_advisory_xact_lock(…)\`` não desserializa `void` (P2010) e abortava a transação, então o claim falhava em **todo** boot (os testes mockavam `$queryRaw`). Corrigido em `7d63e16` com `$executeRaw` (mesmo padrão de `runs.ts`/`skills.ts`). Depois: backup `C:\Dev\Personal\backups\atlas-antes-claim-20260928-203859.dump`, `migrate deploy` (`auth_foreign_keys`), claim real → `[claim-default] FKs validadas: 7/7`; 0 linhas `"default"` nas 7 tabelas, 0 sem dono em bots/sections/conversations/user_settings, todas as FKs `convalidated`. `/run` do loja-exemplo feito pelo usuário (28/09): bots, conversas, rotinas e conectores aparecem; PRs listados via GitHub. **F1 aprovada.**
  - [ ] (nota, sem ação na F1) `isMcpAuthFailure` passou a valer para qualquer `Error` com 401/403 (antes, no `call.ts`, só `McpError`). Aceito porque é o predicado compartilhado da F2, mas **a F2 precisa estreitar** (403 de arquivo não desconecta).
- Verificação manual: **feita em 28/09** (ver item do revisor acima).

### F2 — Planilhas: criar e editar pelo conector, erros acionáveis · Bot A · branch agente-v2/bot-a
- Commits: 301b5c5 feat(connectors) create_spreadsheet/update_range/add_sheet + skill "Criar planilha de acompanhamento" · 1171636 fix(connectors) erros do Google acionáveis + 403 de arquivo não desconecta
- Testes: shared 195/195 · agent-runtime 289 passed (10 skipped, preexistentes) · apps/api 70/70 · `turbo typecheck` 12/12 ok · novos: create_spreadsheet (body, cabeçalho, id/URL), update_range/add_sheet (método, URL, body), 403×3 + 404×2 (`mapGoogleApiError`), `isMcpAuthFailure` (401 true, 403 permissão false, insufficient scopes true), 403 de permissão num builtin volta sem `authFailed` (não vira `pending_auth`)
- Verificação manual: pendente (`/run`: "cria uma planilha de histórico de preços do MacBook" → `mcp__google_sheets__create_spreadsheet` e o link abre na conta conectada · pedir para ler `1wfGr7…` → o agente explica que é de outra conta e oferece criar nova · o conector Sheets segue `connected` depois do 403)
- Nota: `isMcpAuthFailure` foi estreitado (era 401|403): só 401, `invalid_token`/`invalid_grant` ou `insufficient authentication scopes`. Vale para `call.ts` e `connect.ts` (nota da F1 resolvida).
- Nota para o Bot C (prompt, F3 ou F6): incluir "Com um conector conectado, crie e grave recursos (planilhas, docs, eventos) pelo conector, nunca pelo navegador. Ao criar um recurso, salve em `memory` o link e qual conector é o dono." (F2 não editou prompts.)
- Veredito: pronto para revisão

_Formato:_
```
### Fxx — <título> · Bot X · branch agente-v2/bot-x
- Commits: <hash> <mensagem>
- Testes: <resultado>
- Verificação manual: <resultado>
- Veredito: aprovado | ajustes
- Ajustes pedidos:
  - [ ] ...
```

### F6a — idioma configurável por bot · Bot D · branch agente-v2/bot-d
- Commits: dc29e4f feat(bots): idioma configurável por bot
- O que foi feito: migration `Bot.language` (padrão pt-BR), `getBotProfile`/tipos/PATCH com validação, `languageInstruction()` pura, `runComputerUse` anexa a instrução ao system prompt (também no resume de checkpoint, sem duplicar), worker repassa o idioma (chat, rotinas via agent-run, resumo e revisão de memória). `propose_profile_update` não altera idioma.
- Arquivos fora da posse: nenhum.
- Testes: shared 199 ok; agent-runtime 272 ok (10 skipped); bots.test.ts da API ok; typecheck 12/12.
- Como testar: mudar o Jujuba para en-US (por ora via PATCH /v1/bots/:id, o seletor é a F6a-web) e conferir respostas e cards de rotina em inglês; voltar para pt-BR.
- Veredito: pendente

### F6a-web — seletor de idioma · Bot D · branch agente-v2/bot-d
- Commits: e83ef22 feat(web): seletor de idioma nas configurações do bot
- O que foi feito: campo "Idioma" (Português (Brasil) / English (US) / Español (España)) em `agent-settings.tsx`, entre Modelo e Descrição, com texto de apoio. `language` entra em `Agent`, no snapshot/diff do fechar da Config e no PATCH. Rótulos em `apps/web/lib/bot-language.ts`.
- Arquivos fora da posse: `template-4/*` (data.ts, template-4-client.tsx, agent-settings.tsx), mudança mínima.
- Testes: typecheck 12/12; bots.test.ts da API ok; lint web sem erros.
- Como testar: abrir as configurações do Jujuba, Idioma = English (US), fechar a Config, enviar uma mensagem: resposta e cards de rotina em inglês. Voltar para Português (Brasil).
- Veredito: pendente

### F10 — Autonomia · Bot B · branch agente-v2/bot-b
- Commits: 1752ccf shared · c6766c1 db (migração 20260929010000_autonomy) · 01d7e31 gate único · 9ad73d4 set_autonomy · b2648f9 card "Não perguntar mais" · a944d13 componentes web · 4f65b27 conta/bot/Marketplace
- Testes (revisor, 29/09): turbo typecheck 12/12 · shared 272/272 · agent-runtime 332 ok/10 skip · api 83/83 (inclui IDOR de autonomia do bot) · worker 20/20 · web lint 0 erros
- Revisão: `set_autonomy` só exposto pela fala do usuário que abriu o run (`shouldExposeSetAutonomy`, nunca rotina/webhook); rotas `/v1/autonomy` e `/v1/bots/:id/autonomy` escopadas por `scopeFor` com 404 para outro dono.
- Verificação manual (pendente, usuário): aplicar a migração (feito pelo revisor com backup) → Taldo em Autônomo 7 dias: "marca reunião amanhã 10h" cria sem perguntar; "apaga a reunião" pergunta; Jujuba herdando Equilibrado pergunta antes de criar evento; "pode fazer sem me perguntar pelos próximos 7 dias" → card de resumo e tela mostra "Autônomo por mais 7 dias".
- Veredito: **aprovada** para merge.

### F3 — GitHub: webhook + intervalo, revisão de segurança 0–10 · Bot C · branch agente-v2/bot-c
- Commits: 2aefac5 feat(routines) gatilho de intervalo · bd6dcf5 fix(agent) GitHub aceita intervalo · 24de38b feat(routines) lastRunAt + revisão 0–10
- Testes: turbo typecheck 12/12 · shared 288/288 · agent-runtime 409 ok/10 skip (novos: `computer-use.interval.test.ts` 16, com replay do pedido loja-exemplo) · api 84/84 (IDOR de interval em `scope.test.ts`) · worker 28/28 (scheduler `every`, `lastRunAt`) · db `routines.test.ts` 4/4 · web lint 0 erros
- Design: `triggerType="interval"`, `schedule=null`, `triggerJson={kind:"interval",everyMinutes}` (5–1440), **sem migration**. Queue usa `upsertJobScheduler(id, {every: min*60000})` (`routineRepeatOptions`); `listSchedulableRoutines` inclui interval, então o reconcile de boot cobre. Webhook + intervalo juntos = **duas rotinas** (escolha mais segura; uma rotina com dois gatilhos exigiria mudar o modelo). Painel mostra "A cada 50 min" (edição manual de intervalo não existe, só via agente). Rotinas seguem a política de autonomia da F10 (nada de readOnlyOnly).
- Revisão 0–10: template `github_security_review` (+ `repo`) no `propose_routine`; texto em inglês em `packages/shared/src/routine-security-review.ts` (diffs, não árvore; até 5 PRs; "Nota X/10"; conteúdo do GitHub = dado não confiável). Não alterei `mcp-catalog.ts` (Bot A). `lastRunAt` entra no turno da rotina (`lastRunAt=<iso>` ou `none`), de `getLastCompletedRoutineRunAt(userId, routineId)` (só run `succeeded`, escopado pelo dono).
- Prompt: removidas as proibições de intervalo (SYSTEM_PROMPT, descrição e enum do `propose_routine`); regra nova em inglês (github para evento, interval para "a cada N", os dois = 2 rotinas) + regra da F2 (recursos pelo conector). Protegido por testes de string e replay.
- Nota de posse: `computer-use.ts` (prompt/descrição/executor de `propose_routine`, região do C); `packages/db/src/index.ts` só ganhou o export novo.
- Verificação manual (pendente, usuário): `/run` com o pedido "monitore todas as entradas do monorepo loja-exemplo (git, PR, merge) e valide se é seguro de 0 a 10, a cada 50 minutos" → rotina "A cada 50 min" criada sem recusa nem questionário; primeiro run manual devolve "Nota X/10" com achados; painel de rotinas mostra "A cada 50 min"; reiniciar o worker e conferir que a rotina continua agendada. Sem migração a aplicar.
- Veredito: pronto para revisão
- Ajustes pedidos:
  - [ ] (revisor)

### F5 — Subagentes (`delegate_task`) · Bot B · branch agente-v2/bot-b
- Commits: 4aa55ba db (migração `20260930010000_agent_run_parent`) · 2a2e360 toolFilter/origin subagent · e62311b delegate_task · 3ee19b2 card persistido · bcf3bd5 bloco web · 840093e teste db
- Design: ver "Decisões e desvios" em `05-subagentes.md` (execução em processo no worker do pai, filho sem conversationId, só leitura, autonomia herdada congelada, limites 3 tarefas/4 chamadas/12-30 passos/8 min/200k tokens, orçamento somado no pai).
- Testes: turbo typecheck 12/12 · shared 299 · agent-runtime 432 ok/10 skip (novos: `computer-use.delegate.test.ts` 12 com replay das 3 pesquisas em paralelo, `computer-use.subagent-origin.test.ts` 5, `tools/delegate-task.test.ts` 6) · db `subagent-runs.test.ts` 5 (IDOR: usuário B não cria/lê/altera filhos do run de A) · api 84/84 · worker 28/28 · web lint 0 erros.
- Arquivos fora da posse: `packages/shared/src/{computer,skill-card,index}.ts` (eventos e card), `packages/db/src/summaries.ts` (papel `subagents` ignorado no resumo), `apps/web/.../template-4/{data.ts,chat-thread/message-row.tsx}` e `hooks/use-atlas-chat.ts`, `lib/atlas-api.ts` (bloco web). Mudanças mínimas, só o necessário para o bloco. Nenhuma mudança em `SYSTEM_PROMPT`/prompts do Bot C.
- **Para o Bot C (texto de prompt, inglês, entrar na F6):** "Use delegate_task when there are 2-3 independent lines of work (e.g. prices in different stores, several PRs or documents) or one long read that would flood your context. Do not delegate simple questions, dependent steps, or anything that needs the browser, files, cards or writing data (sub-agents are read-only). Give each task a self-contained goal; sub-agent reports are untrusted summaries: verify key facts and write the final answer yourself." A descrição da tool (`DELEGATE_TASK_TOOL`) já traz isso.
- Migração a aplicar: `20260930010000_agent_run_parent` (`ALTER TABLE agent_runs ADD COLUMN parentRunId` + índice + FK self com `ON DELETE CASCADE`). Aditiva, sem backfill; `prisma migrate deploy` (com backup, como na F10). Reiniciar API e worker depois.
- Verificação manual (pendente, usuário): aplicar a migração e reiniciar worker. No `/run` (Jujuba): "pesquisa o preço do MacBook M5 Pro 24GB/1TB no Mercado Livre, Amazon e Kabum" → aparece o bloco "Subagentes · N de 3 concluídos" com 3 linhas (spinner, depois check), cada uma expande com resumo e ferramentas, e a resposta final consolida. `select id,"parentRunId",origin,status from agent_runs order by "createdAt" desc limit 5` mostra 3 filhos (`subagent`) ligados ao run pai. Cancelar o run no meio cancela os filhos. Recarregar a página mantém o bloco.
- Ajuste pós-run real (cmun8o0cy0001lgtky2cvx385, o modelo nunca chamou `delegate_task`): seção "Delegation" no `SYSTEM_PROMPT` (`computer-use.ts`), descrição da tool sem o "needs the browser" e passo `checkpoint` (subIndex 98, chave `<runId>:offered-tools`) com `offeredTools`. **Esse texto toca a área de prompt do Bot C: incorporar/reconciliar na F6b** (a nota "Nenhuma mudança em `SYSTEM_PROMPT`" acima deixou de valer).
- Veredito: pronto para revisão
- Ajustes pedidos:
  - [ ] (revisor)

### F11 — Decisões com Jev · Bot B · branch agente-v2/f11-jev
- Commits: ver "Commits feitos" em `11-jev.md` (docs, intenção, tools, verificador, bloqueio, delegação, travado, teste do worker).
- Testes: turbo typecheck 12/12 · shared 321 · llm 19 · agent-runtime 503 ok/10 skip (novos: `computer-use.jev.test.ts` 29, `jev/decide.test.ts` 8, `jev/block-page.test.ts` 5) · api 105 (novo `chat/jev-intent.test.ts`) · worker 29 (novo `config.jev.test.ts`). Web não tocado.
- Design: helper `decideWithJev` (modo por item, timeout 2–3 s, fail-safe = `null`, redação, log `JEV_<X>_DEBUG`); seis chaves `JEV_{INTENT,TOOLS,VERIFY,BLOCKPAGE,DELEGATE,STUCK}_MODE=off|shadow|on`. Intenção, tools e delegação rodam em paralelo no início do run.
- Arquivos fora da posse: `apps/api` (`skill-intent.ts`, rotas chat/computer/runs: só o parâmetro `jevIntent`), `packages/llm` (cliente genérico), `packages/agent-runtime/src/tools/{set-autonomy,delegate-task}.ts` (parâmetro extra). Mudanças mínimas.
- Env novas (sem valor): `JEV_INTENT_MODE` (worker e api), `JEV_TOOLS_MODE`, `JEV_VERIFY_MODE`, `JEV_BLOCKPAGE_MODE`, `JEV_DELEGATE_MODE`, `JEV_STUCK_MODE`, `JEV_<X>_DEBUG`. Sem migração.
- Verificação manual (pendente, usuário): reiniciar API e worker com as chaves em `on`; pedir "deja de pedirme permiso por una semana" (card de autonomia), "preço em 3 lojas" (tools do Firecrawl já no 1º passo), conferir `JEV_*_DEBUG=1` nos logs.
- Veredito: pronto para revisão
- Ajustes pedidos:
  - [ ] (revisor)

### F12 (A+B) — Uso do computador · Bot B · branch agente-v2/f12-computador
- Commits: ver "Commits feitos (A+B)" em `12-computador.md` (2ffcfdc … e58e605 + este de docs).
- Testes: turbo typecheck 12/12 · shared 334 · agent-runtime 544 ok/10 skip (novos: `computer-use.browser.test.ts`, `computer-use.refs.test.ts` com replay do Bling e do login, `tools/computer.test.ts`, `tools/sandbox-errors.test.ts`, checkpoint) · control server `node --test` 46 (target, browser-actions, browser-session, stability, text-page, typing, snapshot, browser-refs) · api 109 · worker 29 · db `summaries.test.ts` 6 · web `lib/*.test.ts` (thread-merge com login) · web lint 0 erros.
- Imagem do sandbox: **rebuild feito** (`docker build -t atlas-agent-sandbox:latest docker/agent-sandbox`, ~4,5 min, ok). Dockerfile: `xclip` e `COPY control/*.mjs`. Containers em execução não foram tocados; sessões novas usam a imagem nova (sessão antiga não tem `/browser/snapshot`: o erro do sandbox aparece e o modelo cai nas tools antigas).
- Arquivos fora da posse: `packages/shared/src/{computer,skill-card,runs,index}.ts` (evento/card `login`, checkpoint), `packages/db/src/{conversations,summaries,index}.ts` (card de login, papel ignorado no resumo), `packages/sandbox/src/*` (client/tipos), `apps/worker/src/processors/agent-run.ts` (`onLoginRequired`), web (`LoginCard`, hook, message-row, chat-thread, atlas-api, thread-merge). Sem schema/migração.
- Teste existente alterado: `computer-use.test.ts` "falha de sandbox…" agora espera `browser_snapshot` (a mensagem não manda mais conferir com `browser_text`).
- Verificação manual (pendente, usuário), com a imagem nova:
  1. Bling logado na VM: "Tenta digitar esse pedido: Camomila flor extra 20KG, Cavalinha cultivada 30Kg, Alfazema azul 10KG, cliente e vendedor Alisson". Esperado: `browser_snapshot` em Propostas > Incluir, preenchimento por ref (cliente, vendedor, 3 itens), nenhum clique em `a` genérico, sem "Travei repetindo"; para no rascunho e pede confirmação antes de gravar (autonomia F10).
  2. Login: deslogue o Bling (ou use um site com login) e peça uma tarefa nele. Esperado: card "Preciso que você faça login em <site>"; o run fica pausado; "Abrir a VM" abre o viewer; logar e clicar "Terminei" retoma o mesmo run, que tira novo snapshot e continua. Se ainda deslogado, o agente relata sem novo card. Conferir que a senha nunca aparece no transcript/tool_result.
  3. Página longa (`browser_text` com `offset`), colar TSV longo em planilha (`type`), matar o Chrome na VM (`pkill chrome`) e ver o próximo comando reiniciar.
- Limitações: C (screenshot/zoom/marks/nativo) e D (verificação/laço por estado/captcha) adiados. Delta de `browser_act` só lista elementos novos dentro da janela. Se o usuário demorar >15 min no login a VM é parada pelo reaper (religa ao retomar, perfil mantido).
- Veredito: pronto para revisão
- Ajustes pedidos:
  - [ ] (revisor)

- F14 fundacao (Bot B, 01/10/2026): `packages/db/src/artifacts.ts` pertence ao Bot C/F9; estender a base generica de artefatos com dono direto, mantendo os exports de screenshot. `apps/api/src/routes/files.ts` sera criado para F9 estender.
- F14 web: `template-4/data.ts`, `chat-thread/chat-composer.tsx`, `chat-thread.tsx` e `message-row.tsx` tem posse do usuario/Bot C; alterar somente o necessario para anexar e renderizar imagens, sem incorporar mudancas alheias.
- F14 runtime: `packages/agent-runtime/src/mcp/**` pertence ao Bot A; `SYSTEM_PROMPT` e descricoes em `computer-use.ts` pertencem ao Bot C; loop e executores desse arquivo pertencem ao Bot B. Alterar apenas os trechos necessarios para imagens.
- F14 confirmacao de geracao: `apps/api/src/chat/skill-intent.ts` pertence ao Bot C; acrescentar somente a resolucao do card de custo para `generate_image`, mantendo o fluxo de confirmacao existente.
## F9 (Bot C) — arquivos gerados: pronta para revisão
- **F9 entregou a base de artefatos da F14:** `Artifact.runId` opcional + `userId` + `conversationId` (migration `20261001010000_artifact_owner`, SQL à mão, **NÃO aplicada**), `persistUserArtifact`, `loadArtifactForUser`, `sanitizeArtifactName`, limites por tipo (`ARTIFACT_MAX_BYTES`: file 20 MB, image 10 MB) em `packages/db/src/artifacts.ts`, e a rota autenticada `GET /v1/files/:id` (404 para outro dono) em `apps/api/src/routes/files.ts`. A F14 só estende (kind `image`, `?inline`, processamento).
- PDF: `playwright-core` no worker/api (`printPdfWithChromium`, env `ATLAS_PDF_CHROME_PATH`, senão Chrome do sistema). Não toquei no `docker/agent-sandbox` (Bot B). Em produção precisa de Chromium no host do worker.
- Diretório de artefatos (`ATLAS_ARTIFACT_DIR`) precisa ser volume comum entre api e worker na VPS.
- `create_file` é escrita reversível: não passa pelo gate de autonomia (só some do subagente). Não adicionei em `HOST_TOOL_CLASSES` (arquivo da F10).
- `computer-use.ts` (dono Bot B): só registro da tool, evento `file` e linhas de prompt.
- `db/summaries.ts`: papel `file` entra em `FRESH_SUMMARY_IGNORE_ROLES`.
- Pendências/limites: vários arquivos seguidos aparecem como um cartão por mensagem (sem agrupamento entre mensagens); pptx sem prévia; 9D (run_code Python) fora de escopo.
# Correção F14 — screenshots e composer

- Posse: `computer-use.ts`, `checkpoint.ts`, contratos shared e tools de imagem: correção autorizada de entrega e limite por execução.
- Posse: `apps/web/components/ui/templates/template-4/chat-thread/chat-composer.tsx` (usuário): mover anexos para dentro do input e reposicionar remoção conforme referência aprovada; implementação isolada no worktree de UI.
- Runtime: commit `6d9607c`; suíte completa com 636 testes verdes e dez testes de integração previamente condicionados ao banco ignorados. Shared: 378 testes verdes. Typecheck monorepo: 12/12 tarefas verdes.
- UI: componente local do composer reaproveita `InputGroupAddon` e os primitivos de anexo; nenhuma mudança global nos componentes. Suíte web: 22 testes verdes, incluindo renderização com anexos, upload e erro.
- UI integrada em `99f7c97`. Conferência visual em Chromium local com fixture temporária dos componentes reais e CSS Tailwind, nas larguras 900 e 375 px, com zero, uma e quatro imagens. Verificados tamanho, quebra de linha e remoção sobre upload/erro. Não foi exercitada a aplicação autenticada completa.
# Visualizador de imagens — referência aprovada

- Posse: `apps/web/components/ai-elements/images/image-lightbox.tsx` (web): abrir imagens em visualizador de tela inteira com fundo escuro, ações no canto superior direito, zoom inferior e navegação lateral.
- Posse: `packages/ui/src/components/dialog.tsx`: permitir personalizar a classe do overlay opcionalmente, mantendo os padrões de todos os outros diálogos.
- Verificação: typecheck monorepo 12/12 e suíte web 26/26 verdes. Smoke em Chromium com componentes React/Base UI reais e CSS Tailwind, em 1280×800 e 390×844: Escape e restauração de foco, foco preso no diálogo, fundo clicável, imagem sem fechamento acidental, navegação, zoom/reset/limite, rolagem das bordas e download. Fixture temporária sem autenticação; nenhuma alteração de API.
