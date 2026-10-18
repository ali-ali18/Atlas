# Plano Configurações — modal de configurações da conta (provedores, modelos, JEV, execução, uso)

**Status: PROPOSTO em 04/10/2026; decisões do usuário registradas em 04/10/2026 (ver "Decisões do usuário (perguntas em aberto)").** Nada aqui está implementado. Itens marcados **(hipótese)** exigem verificação (leitura de código ou teste) antes de depender deles.

## Cabeçalho da rodada
- **Branch base:** `rodada/desempenho`. Worktree por agente: `agente-v5/<agente>` criada a partir dela (ver `10-git-worktree.md`).
- **Regras:** `.agents/rules/` (fonte única). Leia `00-core`, `10-git-worktree`, `20-commits`, `30-componentizacao`, `40-seguranca`, `50-testes` e `60-agente`. Convenções de issue em `docs/agents/issue-tracker.md`.
- **Commits:** atômicos, Conventional Commits em pt-BR, `git add` explícito, sem push. Teste no mesmo commit da mudança.
- **Texto para o modelo:** inglês neutro e genérico. **Texto para o usuário:** pt-BR.
- **Dono da execução:** Sonnet (um agente por fase). Revisão: o orquestrador.
- **Next.js:** o `apps/web` usa uma versão com breaking changes (16.x). Antes de mexer em APIs do Next, ler `apps/web/node_modules/next/dist/docs/` (ou `node_modules/next/dist/docs/` na raiz).
- **Issues:** mapa #29; S0 #30, S1 #31, S2 #32, S3 #33, S4 #34.

---

## Contexto
Hoje a configuração do Atlas está espalhada: flags no `.env` (provedor ChatGPT, Jev, disciplina de execução, modelos de manutenção/visão/imagem, timeouts do LLM), a seção "Provedores" dentro das configurações **de cada bot** (`chat-context-panel/agent-settings.tsx:183` renderiza `ProvidersSettings`, que é da conta), autonomia da conta num dialog separado (menu da conta → Autonomia) e `sandboxAutoStart` que existe na API (`/v1/settings`) mas **sem UI** (hipótese: confirmar com `rg sandboxAutoStart apps/web`).

Objetivo: um **modal de configurações da conta** (estilo Claude): nav à esquerda com busca no topo e seções agrupadas ("Configurações" / "Personalização"), conteúdo à direita. A configuração passa a ser feita **na UI**; o `.env` continua como padrão do servidor e para uso headless.

### Decisões do usuário (04/10/2026)
1. **Seções da v1:** Geral + Conta, Provedores + Modelos, JEV + Execução, Uso; mais atalhos para Memória, Conectores (Marketplace) e Rotinas, que já existem.
2. **Precedência:** configuração do usuário > env (padrão do servidor) > padrão do código.
3. **Segredos ficam fora da UI:** chave do OpenRouter, `CONNECTOR_ENCRYPTION_KEY`, `DATABASE_URL`, `BETTER_AUTH_SECRET` (e demais credenciais). Só **escolhas** vão para a UI.
4. **Estilo:** compacto, **um** dropdown/switch por configuração (como Modelo/Idioma/Autonomia); sem cards de opção nem pílulas de resumo redundantes; primitivos de `packages/ui` (Dialog, Select/Dropdown, Switch, Collapsible, Item/Field); textos pt-BR; a11y (Esc fecha, foco preso pelo Dialog do ui); ícones de marca no mesmo padrão dos existentes (SVG `fill="currentColor"`, fonte thesvg.org).
5. **Configurações do bot ficam só com o que é do bot:** nome, descrição, modelo, idioma, override de autonomia, notificações (e as que já são por bot: modelo dos subagentes, fallback do limite do plano). **A seção Provedores sai do bot** e vai para o modal.

### Fora de escopo
- Qualquer segredo na UI ou no `configJson`. Gerenciar usuários/convites/cobrança. Reescrever autonomia ou conectores (só atalhos/embeds). Alterar o protocolo SIWC (rodada Provedores).
- Valores brutos (ms, tokens) de timeouts e raciocínio: ficam no `.env`; a UI expõe presets.

---

## Mapa do código (onde cada coisa entra)
| Ponto | Onde | Observação |
|---|---|---|
| Settings do usuário (já existe) | `packages/db/prisma/schema.prisma` `model UserSettings` (`userId @unique`, `sandboxAutoStart Boolean`, `autonomyJson Json?`); `packages/db/src/settings.ts`; `packages/shared/src/settings.ts` (`UserSettings`, `UpdateUserSettingsInput`); `apps/api/src/routes/settings.ts` (`GET`/`PATCH /v1/settings`, validação manual do body) | **Estender** esta linha com `configJson Json?` versionado. Sem tabela nova. `getUserSettings` faz fallback de leitura para a linha legada `id="default"`: **o `configJson` não pode herdar dela** (ler só `where: { userId }`, como `autonomy.ts`). |
| Autonomia da conta | `packages/db/src/autonomy.ts` (`getAccountAutonomy`/`setAccountAutonomy`, lê só a linha do próprio usuário), `apps/api/src/routes/autonomy.ts`, `apps/web/.../autonomy/{autonomy-dialog,autonomy-settings}.tsx`, `hooks/use-autonomy.ts`, worker `run-autonomy.ts` (bot > conta > Equilibrado) | Reaproveitar `AutonomySettings scope="account"` dentro da seção Execução. Não migrar dados. |
| Config do worker | `apps/worker/src/config.ts` (`loadWorkerConfig` **lido uma vez no boot**: `openRouterModel`, `summarizerModel`, `maintenanceModel`, `jevMcpMode`, `jevModes` via `parseJevModes`) | Só o que é boot/infra (redis, concorrência, segredos) permanece aqui. O que for escolha do usuário passa por resolver **por run/job**. |
| Run no worker | `apps/worker/src/processors/agent-run.ts` (`getUserSettings` ~l.391; `ATLAS_VISION_FALLBACK_MODEL` ~l.401; `resolveRunAutonomy` ~l.564; `runComputerUse({ jevMcpMode, jev.modes, … })` ~l.589; orçamento request > bot > padrões ~l.489) | Ponto único onde o snapshot da config do run é resolvido e injetado. |
| Manutenção | `processors/summary.ts` (`config.summarizerModel`), `processors/memory-review.ts` (`config.maintenanceModel ?? summarizerModel`), `shared/src/provider-policy.ts` (`resolveMaintenanceModel`: nunca `chatgpt/*`) | Resolver por job a partir do dono da conversa. |
| Leituras de env fora do worker | `packages/llm/src/decision-budget.ts` (`readDecisionTimeouts(options, env)`: `LLM_DECISION/FIRST_EVENT/IDLE_TIMEOUT_MS`), `llm/src/chat-tools.ts:~37` (`LLM_REASONING_MAX_TOKENS`), `llm/src/config.ts` (`readOpenRouterFallbackModels(env)`), `agent-runtime/src/computer-use.ts:~4986` (`LLM_MAX_OUTPUT_TOKENS`), `:~4577` (`ATLAS_IMAGE_MODEL`), `:~4400` (`params.executionDiscipline ?? executionDisciplineEnabled()`), `execution/flag.ts`, `mcp/runtime.ts:~161`, `apps/api/src/chat/{jev-intent,skill-intent}.ts` (`JEV_INTENT_MODE`, `ATLAS_IMAGE_MODEL`), `apps/api/src/config.ts` (`OPENROUTER_MODEL`) | A maioria **já aceita parâmetro** (`maxOutputTokens`, `executionDiscipline`, `timeoutMs`/`firstEventTimeoutMs`/`idleTimeoutMs`, `env` injetável). O worker/API passam o valor resolvido; o env continua como último recurso embaixo. |
| ChatGPT (gate) | `apps/api/src/routes/providers.ts` (middleware: flag + dono `ATLAS_OWNER_EMAIL`), `apps/api/src/providers/siwc-loopback.ts` (`ensureSiwcLoopback`, handler checa a flag por request), `agent-runtime/src/providers/siwc-service.ts` (`configured()`/`authorize(userId)`), worker `provider-services.ts` | Ver S2. |
| Telemetria / custo | `shared/src/run-telemetry.ts` (`StepTelemetry`, `RunTelemetryMeta`: `requestedModel`/`servedModel`, `formatCostLabel`, `applyReconciledCost`, `summarizeRunTelemetry`), `agent-runtime/src/budget.ts` (`RunUsage`: `costUsd`, `costUnknownCalls`, `planCalls`), `db/src/runs.ts:~1725` (`usage` → `AgentRun.usageJson`, `usageJson.telemetry`), `db/src/run-cost.ts` (reconciliação soma no `usageJson`), `AgentStep.outputJson.telemetry` | Uso agrega de `AgentRun.usageJson`, **nunca** varre `AgentStep`. |
| Índices de `AgentRun` | `@@index([conversationId, status])`, `[userId, status]`, `[status, leaseUntil]`, `[parentRunId]` | **Não há índice por `(userId, createdAt)`** → migration em S4. |
| Subagentes | `db/src/subagent-runs.ts` (`parentRunId`, `origin` subagent), `agent-runtime/src/tools/delegate-task.ts` (`ctx.addUsage(tally)` no pai) | Provável que o `usageJson` do pai já inclua o dos filhos → agregar só `parentRunId IS NULL` (hipótese: confirmar para não contar em dobro). |
| Web: menu da conta | `chat-sidebar/chat-sidebar-footer.tsx` (`UserAvatar`, `DropdownMenu`: "Settings" → `onOpenSettings` **abre o painel do bot**, "Autonomia" → `onOpenAutonomy`); `template-4-client.tsx` (`openSettings`, `autonomyDialog`, `marketplaceOpen`, evento `atlas:open-provider-settings`) | O item "Settings" do menu passa a abrir o modal; o painel do bot segue pelo seu caminho. |
| Web: componentes | `components/providers/providers-settings.tsx` (250 linhas, `useChatgptProvider`, `lib/provider-connect`), `components/model-picker*` e `model-picker/*`, `template-4/settings-picker.tsx` (dropdown compacto), `lib/atlas-api.ts` (`listProviders`, `getAccountAutonomy` …), `hooks/use-chatgpt-provider.ts`, `components/icons/*`, `components/theme-provider.tsx`, `packages/ui/src/components/{dialog,sheet,select,dropdown-menu,switch,collapsible,field,item,command}.tsx` | Reaproveitar; não recriar dropdown, modal nem item. |
| Memória | `apps/api/src/routes/memory.ts` | Não há tela de Memória no web hoje (só tool/API): o atalho é **omitido** até a tela existir (decisão 6 do usuário). |

---

## Contrato de configuração (S0)

**Armazenamento:** `UserSettings.configJson Json?` (migration `ADD COLUMN`, nulo = tudo herdado). Forma versionada `{ v: 1, … }`, definida e validada em `packages/shared/src/account-config.ts` (validação manual no padrão de `autonomy.ts`/`parseAutonomyPolicy`; **(hipótese)** `zod` não é dependência do shared, conferir antes de adicionar). Regras:
- **Escrita estrita:** chaves desconhecidas, tipos errados, enum inválido, `v` ≠ 1, JSON > 4 KB → 400. Ids de modelo: `[A-Za-z0-9._:/-]`, ≤ 200 chars.
- **Leitura tolerante:** chave desconhecida ou `v` futuro é ignorado (campo cai no env/padrão), nunca derruba run.
- **PATCH = merge patch:** `null` remove a chave (volta a herdar), ausente não muda. Escrita em transação com lock (padrão `pg_advisory_xact_lock` de `db/src/runs.ts`) para duas abas não perderem alteração.
- **Resolver puro** `resolveEffectiveConfig({ user, env })` em `packages/shared` (sem `process.env` na lógica: o `env` entra por parâmetro). Devolve cada campo como `{ value, source: "user" | "env" | "default" }`. Valor inválido do env é ignorado (cai no padrão), o do usuário é validado na escrita.
- **Snapshot por run:** o worker resolve **uma vez** ao assumir o run (com o `userId` do run e o env do worker), grava em `AgentRun.checkpointJson.configSnapshot` (**hipótese:** confirmar que o writer do checkpoint preserva a chave; senão, `budgetJson.configSnapshot`) e injeta nos params do `runComputerUse`. Retomada do run reutiliza o snapshot. Subagentes herdam o snapshot do pai. Rotinas/webhooks resolvem por run. Mudar a config no meio do run **não** o afeta; vale para o próximo.
- **Config do boot x por run:** `loadWorkerConfig` fica só com infra/segredos. `summary`/`memory-review` resolvem por job (dono da conversa). A API resolve por request (jev-intent, geração de imagem, modelo padrão) com o env da API.
- **Rotas:** `GET /v1/settings` passa a devolver `{ settings, config, effective, capabilities }`: `config` = o que o usuário gravou; `effective` = valor + `source` (a UI mostra "Padrão do servidor: X" na opção "Herdar"); `capabilities` = booleanos não secretos (`openrouterKey`, `chatgptAvailable`, `isOwner`). `PATCH /v1/settings` aceita `{ sandboxAutoStart?, config? }`. Escopo **sempre** `scopeFor(session)`; `userId` nunca vem de body/query. Não há recurso de terceiros (rota só do próprio usuário), mas o teste de IDOR prova que B nunca lê/altera/vê o `config` de A.

### Tabela: configuração → seção → controle → armazenamento → quem lê → precedência
Legenda de precedência: **U** = `configJson` do usuário, **E** = env do processo que lê, **C** = padrão do código. "Herdar" = opção que remove a chave.

| Configuração | Env hoje | Seção | Controle na UI | Armazenamento | Quem lê | Precedência |
|---|---|---|---|---|---|---|
| Usar plano ChatGPT (SIWC) | `ATLAS_PROVIDER_CHATGPT_ENABLED` (padrão `false`; **só o padrão**: com `false` o dono ainda liga na UI) | Provedores | Switch (só o dono); desligar **mantém** a conexão e os tokens; ação separada "Desconectar da conta" remove os tokens | `config.providers.chatgptEnabled` | API (`providers.ts`, `siwc-loopback.ts`), `siwc-service.ts`, worker (`provider-services.ts`) | U > E > `false`; **sempre** exige dono (`ATLAS_OWNER_EMAIL`, segue env) |
| Modelo padrão (bots novos e runs sem bot) | `OPENROUTER_MODEL` (web: `NEXT_PUBLIC_OPENROUTER_MODEL`) | Modelos | ModelPicker (agrupado por provedor) | `config.models.default` | API (criação de bot/run), worker (`chat-completion`), web (`DEFAULT_OPENROUTER_MODEL`) | U > E > `openai/gpt-4o-mini` |
| Modelos de reserva (fallback OpenRouter) | `OPENROUTER_FALLBACK_MODELS` | Modelos (Collapsible "Avançado") | Lista curta, até 3 ModelPickers | `config.models.fallbacks` | `llm/config.ts` via params do worker | U > E > vazio |
| Modelo de manutenção (resumo + revisão de memória) | `ATLAS_MAINTENANCE_MODEL`, `SUMMARIZER_MODEL` | Modelos | ModelPicker (só OpenRouter) | `config.models.maintenance` | worker `summary`/`memory-review` | U > `ATLAS_MAINTENANCE_MODEL` > `SUMMARIZER_MODEL` > `openai/gpt-6-luna`; nunca `chatgpt/*` (`resolveMaintenanceModel`) |
| Modelo para ler imagens (quando o do bot não vê) | `ATLAS_VISION_FALLBACK_MODEL` | Modelos | ModelPicker (só OpenRouter, com visão) | `config.models.vision` | worker `agent-run.ts` (`imageVisionForRun`) | U > E > `openai/gpt-4o-mini` |
| Modelo de geração de imagem | `ATLAS_IMAGE_MODEL` | Modelos | ModelPicker (só OpenRouter) | `config.models.image` | `computer-use.ts` (`generate_image`), API `skill-intent.ts` | U > E > desligado (mensagem acionável já existe) |
| Revisão de conectores pelo Jev | `JEV_MCP_MODE` (`off\|shadow\|gate`) | Jev e execução | Dropdown: Desligado / Observar / Bloquear | `config.jev.mcp` | worker → `runComputerUse({ jevMcpMode })` | U > E > `off` |
| Jev — decisões auxiliares (geral) | `JEV_*_MODE` (6) | Jev e execução | Dropdown: Desligado / Observar / Ativo | `config.jev.all` | worker (`jev.modes`), API (`jev-intent.ts`) | U > E > `off` |
| Jev — por recurso (intenção, tools, verificação, página de bloqueio, delegar, travado) | `JEV_INTENT/TOOLS/VERIFY/BLOCKPAGE/DELEGATE/STUCK_MODE` | Jev e execução (Collapsible "Por recurso", **fechado por padrão**) | 6 dropdowns (opção "Igual ao geral") | `config.jev.features.<x>` | idem | U(recurso) > U(geral) > E(recurso) > `off` |
| Disciplina de execução (ledger, estagnação, lote) | `ATLAS_EXECUTION_DISCIPLINE` (padrão on) | Jev e execução | Switch | `config.execution.discipline` | `computer-use.ts`, `mcp/runtime.ts` via `params.executionDiscipline` | U > E > `true` |
| Paciência com o modelo (prazos de resposta) | `LLM_DECISION_TIMEOUT_MS`, `LLM_FIRST_EVENT_TIMEOUT_MS`, `LLM_IDLE_TIMEOUT_MS` | Jev e execução | Dropdown de preset: Padrão / Curto / Estendido | `config.execution.llmTimeoutPreset` | `llm/decision-budget.ts` via `timeoutMs`/`firstEventTimeoutMs`/`idleTimeoutMs` | U(preset→ms) > E(ms exatos) > 90s/30s/20s. Presets (hipótese de valores): Curto 45/15/10 s, Estendido 180/60/40 s |
| Tamanho máximo da resposta | `LLM_MAX_OUTPUT_TOKENS` | Jev e execução | Dropdown de preset (2k/4k/8k/16k/32k) + Herdar | `config.execution.maxOutputTokens` | `computer-use.ts` (`agentOutputBudget`), via `params.maxOutputTokens` | U > E > `undefined` (sem teto) |
| Limite de passos e tempo do run (padrão da conta) | (nenhum env; `maxSteps` do request, `budget.ts` `BUDGET_WALL_DEFAULT_MS` 30 min) | Jev e execução | 2 dropdowns (passos; tempo) | `config.execution.maxSteps`, `maxWallMinutes` | worker `agent-run.ts` (~l.489) | request > bot (`policyJson`) > **U** > código |
| Iniciar o navegador (sandbox) automaticamente | — (coluna `sandboxAutoStart`) | Jev e execução | Switch | `UserSettings.sandboxAutoStart` (já existe) | worker `agent-run.ts` | U > `true` |
| Autonomia padrão da conta | — | Jev e execução (embed) | `AutonomySettings scope="account"` | `UserSettings.autonomyJson` (já existe) | worker `run-autonomy.ts` | bot > conta > Equilibrado |
| Tema | — | Geral | Dropdown Claro/Escuro/Sistema | `ThemeProvider` (navegador) | web | local |
| Idioma padrão de bots novos | — | Geral | Dropdown (`BOT_LANGUAGE_OPTIONS`) | `config.general.defaultBotLanguage` | web (criação de bot) | U > `pt-BR` |
| Nome, e-mail, sair | — | Conta | Texto (somente leitura) + botão Sair | sessão (better-auth) | web | — |
| Fallback do limite do plano; modelo dos subagentes | — | **continuam no bot** | (já existem) | `Bot.policyJson` | worker | bot |

**Ficam só no env (não vão para a UI):**
- Segredos: `OPENROUTER_API_KEY`, `CONNECTOR_ENCRYPTION_KEY`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ATLAS_HOOK_PEPPER`, `SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, credenciais Google.
- Infra: `REDIS_URL`, `AGENT_RUN_CONCURRENCY`, `ATLAS_URL`, `ATLAS_OWNER_EMAIL`, `SANDBOX_IMAGE`, `SEARCH_PROVIDER`, `ATLAS_SIWC_CALLBACK_PORT`/`_BIND`.
- Ajuste fino/depuração: `LLM_REASONING_MAX_TOKENS` (depende do modelo; risco de custo/erro), `ATLAS_CHATGPT_CONTEXT_TOKENS`, `ATLAS_CHATGPT_LIMIT_COOLDOWN_MS`, `JEV_*_DEBUG`, `JEV_MCP_DEBUG`, `ATLAS_IMAGE_MAX_PER_RUN`, ms exatos dos timeouts.
- A UI mostra "Chave do OpenRouter não configurada no servidor" (via `capabilities.openrouterKey`, booleano) quando falta; nunca o valor.

---

## S0 — Contrato, resolver, API e snapshot por run (`packages/shared`, `packages/db`, `apps/api`, `apps/worker`, libs que leem env)
Sem mudança de comportamento quando não há `configJson`.

| # | Item | Onde | Como |
|---|---|---|---|
| S0.1 | Contrato e validação | `packages/shared/src/account-config.ts` (+ `index.ts`) | Tipo `AccountConfigV1`, `parseAccountConfig` (leitura tolerante), `validateAccountConfigPatch` (escrita estrita), `mergeAccountConfig` (merge patch). Testes: vazio, `null` remove, chave desconhecida, enum inválido, modelo com caractere inválido, > 4 KB, `v` futuro. |
| S0.2 | Resolver puro | `packages/shared/src/effective-config.ts` | `resolveEffectiveConfig({ user, env })` com `source` por campo; presets de timeout; `jev` (U recurso > U geral > E recurso > off); manutenção (cadeia de 4); inválido no env é ignorado. Teste de tabela cobrindo **cada linha** da tabela acima, e "sem user config = valores de hoje" (regressão). |
| S0.3 | Persistência | `schema.prisma` + migration + `packages/db/src/settings.ts` | `configJson Json?`; `getAccountConfig(userId)` (só a linha do usuário, nunca a legada), `patchAccountConfig(userId, patch)` em transação com lock. Migration e código juntos. A reivindicação do legado (`claim-default.ts`) não pode copiar `configJson` de outro dono. |
| S0.4 | API | `apps/api/src/routes/settings.ts` | `GET`/`PATCH /v1/settings` estendidos (ver contrato). Validação de modelo na escrita: OpenRouter-only onde indicado; `models.default` pode ser `chatgpt/*` só com ChatGPT habilitado e conectado (reusar a validação da rodada Provedores); catálogo fora do ar aceita (como `isKnownModelId` devolvendo `null`). 400 com mensagem pt-BR por campo. |
| S0.5 | Snapshot no worker | `apps/worker/src/{run-config.ts (novo),processors/agent-run.ts,processors/summary.ts,processors/memory-review.ts,processors/routine.ts}`, `config.ts` | `resolveRunConfig({ userId, env })` lê o `configJson` do dono do run, resolve e grava o snapshot; injeta `jevMcpMode`, `jev.modes`, `executionDiscipline`, `maxOutputTokens`, timeouts, `fallbackModels`, `imageModel`, `visionFallback`, orçamento (U entre bot e padrão). `summary`/`memory-review` resolvem por job. Falha ao ler config = cai em env/padrão (como `getUserSettings` já faz), com `console.error` sem objeto de config. |
| S0.6 | Libs sem leitura direta de env para o que é surfaced | `llm/{decision-budget,chat-tools,config}.ts`, `agent-runtime/src/{computer-use.ts (só passar params; **não engordar**),execution/flag.ts}`, `apps/api/src/chat/{jev-intent,skill-intent}.ts`, `apps/api/src/config.ts` | Passar o valor resolvido por parâmetro (a maioria já existe); o env continua como último recurso na lib (compatibilidade). `OPENROUTER_FALLBACK_MODELS` e `ATLAS_IMAGE_MODEL` ganham param novo. API resolve por request. |
| S0.7 | `.env.example` | raiz, api, worker | Comentário "padrão do servidor; a UI sobrescreve" nas variáveis surfaced. Sem valores reais. |

- **Gate do ChatGPT:** o backend (leitura U > E > `false` + dono, listener sob demanda) entra na S0; a UI (switch e "Desconectar da conta") fica na S2. Decisões 1 e 2 do usuário.
- **Testes:** unitários (S0.1, S0.2); db (round-trip, lock com 2 PATCH concorrentes, linha legada ignorada); API: caminho feliz + **IDOR** (padrão `routes/scope.test.ts`: B não lê, altera nem apaga o config de A; PATCH com `userId` no body é ignorado); worker: dois usuários com configs diferentes no mesmo processo → cada run usa a sua; config alterada no meio do run não muda o run; retomada reusa o snapshot; sem config = comportamento atual (replay existente intacto); subagente herda; nada de `process.env` mutado.
- **Commits:** `feat(shared): contrato e resolver de configuração da conta`, `feat(db): configuração da conta em UserSettings.configJson`, `feat(api): GET e PATCH /v1/settings com configuração efetiva`, `feat(worker): snapshot da configuração por run`, `refactor(llm): timeouts, fallbacks e imagem por parâmetro`.

## S1 — Casca do modal, nav, busca e Geral/Conta (`apps/web`)
| # | Item | Onde | Como |
|---|---|---|---|
| S1.0 | Seção na URL | `settings-dialog.tsx` | A seção ativa da nav fica na URL (`?settings=jev`); recarregar mantém a seção aberta (decisão 4). |
| S1.1 | Casca | `apps/web/components/settings/settings-dialog.tsx` (novo) | `Dialog` do `packages/ui` (Esc e foco já tratados), `sm:max-w-4xl`, altura ~`80dvh`. Esquerda: busca + nav (grupos "Configurações": Geral, Conta, Provedores e modelos, Jev e execução, Uso; "Personalização": Memória, Conectores, Rotinas). Direita: seção ativa com rolagem própria. Mobile: nav vira dropdown no topo (hipótese de layout; conferir com o usuário se fugir do padrão). |
| S1.2 | Registro e busca | `settings/settings-registry.ts` (puro) | Lista `{ id, group, label, keywords[], section }` de cada seção **e** de cada configuração; busca sem acento/caixa filtra a nav e destaca a seção; sem resultado → "Nada encontrado". Testado em unidade. |
| S1.3 | Estado do servidor | `lib/atlas-api.ts` (`getAccountSettings`, `patchAccountSettings`), `hooks/use-account-settings.ts` | Padrão de `use-autonomy.ts`; PATCH imediato por controle, otimista com rollback e erro inline em pt-BR. Sem `fetch` solto. |
| S1.4 | Geral e Conta | `settings/sections/{general,account}.tsx` | Geral e Conta são duas entradas de nav (decisão 5). Geral: Tema (dropdown), Idioma padrão de bots novos. Conta: nome/e-mail (somente leitura, da sessão), Sair. Cada configuração = um `Field` + `SettingsPicker`/`Switch`. |
| S1.5 | Atalhos | `settings/sections/shortcuts.tsx` | Conectores → fecha o modal e abre `MarketplaceDialog`; Rotinas → abre o fluxo/painel de rotinas existente; Memória → omitido até existir a tela (decisão 6). Item com ícone de "abrir" (não é seção interna). |
| S1.6 | Pontos de entrada | `chat-sidebar-footer.tsx`, `template-4-client.tsx` | Item "Configurações" do menu da conta abre o modal; "Autonomia" abre o modal em Jev e execução (e o `AutonomyDialog` continua para o fluxo do Marketplace com `connectorFilter`); evento `atlas:open-provider-settings` abre o modal em Provedores. **Antes de editar `template-4/*`, conferir mudanças não commitadas do usuário** (nunca stage/format o que não é seu). |
| S1.7 | Ícones | `components/icons/*` | Conferir o que existe; marcas novas (OpenRouter, OpenAI/ChatGPT, se faltarem) como SVG `currentColor`, fonte thesvg.org. |

- **Testes:** componente (abre/fecha com Esc, foco preso, busca filtra e acha configuração por palavra-chave, troca de seção, atalhos disparam callbacks, erro de PATCH faz rollback), registry puro, `aria-label` nos botões de ícone.
- **Commits:** `feat(web): modal de configurações da conta com nav e busca`, `feat(web): seções Geral e Conta`, `feat(web): menu da conta abre as configurações`.

## S2 — Provedores e Modelos (`apps/web`, `apps/api`, `packages/agent-runtime`)
| # | Item | Onde | Como |
|---|---|---|---|
| S2.1 | Mover Provedores | `settings/sections/providers-models.tsx`; `agent-settings.tsx` | Renderizar `ProvidersSettings` na seção; **remover** `<ProvidersSettings />` e o import de `agent-settings.tsx`. Manter o fallback "Se o limite do plano acabar" e o modelo dos subagentes no bot. `ProvidersSettings` ganha o Switch "Usar plano do ChatGPT" (só dono) e perde o `Collapsible` próprio se ficar redundante (um controle, sem pílula). Ajustar `id="atlas-provider-settings"`/evento de expansão para o novo local. |
| S2.2 | Modelos | `settings/sections/providers-models.tsx` | `ModelPicker` para: modelo padrão, manutenção, leitura de imagens, geração de imagem; Collapsible "Avançado" com até 3 modelos de reserva. Cada picker tem a opção "Herdar" mostrando "Padrão do servidor: <valor>" (de `effective.source`). Pickers de manutenção/visão/imagem só listam OpenRouter. |
| S2.3 | Gate do ChatGPT por usuário | `siwc-service.ts` (`configured()`/`authorize`), `routes/providers.ts` (middleware), `siwc-loopback.ts`, worker `provider-services.ts` | Trocar a leitura do env por `chatgptEnabledFor(userId)` (U > E > false) **e** dono. Middleware de `/v1/providers*` resolve pelo usuário da sessão (404 se desligado ou não dono). Worker usa o snapshot do run. |
| S2.4 | Ciclo de vida do listener | `siwc-loopback.ts` | (Estado atual) o listener **já sobe sob demanda**: `ensureSiwcLoopback()` só roda no `POST /v1/providers/chatgpt/connect` e fica ligado até o fim do processo (`unref`); a flag é checada por request, não no boot. Com o toggle: (a) ligar o switch **não** sobe nada; sobe no primeiro "Conectar"; (b) o handler do callback **não pode** depender do env (não há sessão): validar `state` de uso único → `userId` → `chatgptEnabledFor(userId)` dentro do `service.callback`; (c) desligar o switch chama `stopSiwcLoopback()` (fecha o `Server`, zera `listener`) para a porta não ficar aberta sem uso; (d) religar sobe de novo no próximo "Conectar". Tokens do cofre **permanecem** ao desligar o switch (a conexão é mantida; decisão 2 do usuário); a ação separada "Desconectar da conta" desconecta e remove os tokens (caminho existente). O gate impede qualquer uso enquanto desligado. |
| S2.5 | Validação de modelo | `routes/bots.ts`, `routes/runs.ts` | `config.models.default` com `chatgpt/*` exige habilitado + conectado; ids de manutenção/visão/imagem/reserva rejeitam `chatgpt/*` (400 claro). |
| S2.6 | Cliente | `lib/atlas-api.ts`, `hooks/use-chatgpt-provider.ts` | Reaproveitar `listProviders`/`connectChatgptProvider`/`disconnectChatgptProvider`; popup e `?provider=chatgpt&status=` seguem como estão. |

- **Testes:** gate por usuário (A habilitado, B não: B recebe 404 em `/v1/providers*`; não-dono recebe 404 mesmo habilitado); callback com `state` de usuário com toggle desligado não grava nada; listener sobe só no `connect` e fecha ao desligar (servidor fake em porta efêmera); `agent-settings` não renderiza mais Provedores; pickers só OpenRouter onde indicado; "Herdar" mostra o padrão do servidor; fluxo conectar/desconectar com API mockada (existente) continua verde.
- **Commits:** `feat(api): plano ChatGPT habilitado por usuário (listener sob demanda)`, `feat(web): provedores e modelos nas configurações da conta`, `refactor(web): provedores saem das configurações do bot`.

## S3 — Jev e Execução (`apps/web`)
| # | Item | Onde | Como |
|---|---|---|---|
| S3.1 | Jev | `settings/sections/jev-execution.tsx` | Dropdown "Revisão de conectores" (Desligado/Observar/Bloquear); dropdown "Decisões auxiliares" (Desligado/Observar/Ativo) + Collapsible "Por recurso" (fechado por padrão) com 6 dropdowns ("Igual ao geral"). Sem chave do OpenRouter (`capabilities.openrouterKey=false`): controles desabilitados com a nota "Chave do OpenRouter não configurada no servidor". Textos pt-BR curtos explicando o que cada modo faz, sem jargão (Observar = registra sem agir). |
| S3.2 | Execução | idem | Switch "Disciplina de execução"; dropdowns "Paciência com o modelo" (preset), "Tamanho máximo da resposta", "Limite de passos", "Tempo máximo do run"; Switch "Iniciar o navegador automaticamente". Cada um com "Herdar". |
| S3.3 | Autonomia | idem | Embed `AutonomySettings scope="account"` (mesmo componente do dialog), título "Autonomia". |

- **Testes:** cada controle envia o PATCH certo e faz rollback no erro; estado "Herdar" mostra o padrão do servidor; controles do Jev desabilitados sem chave; busca encontra "Jev", "passos", "autonomia"; teste de integração S0 (config → snapshot do run) já cobre o efeito no worker.
- **Commits:** `feat(web): seção Jev e execução nas configurações da conta`.

## S4 — Uso (`apps/api`, `packages/db`, `packages/shared`, `apps/web`)
**Fonte de dados:** `AgentRun.usageJson` (já tem `costUsd`, `costUnknownCalls`, `planCalls`, tokens e `telemetry.servedModel`), nunca `AgentStep`. O custo reconciliado já é somado no `usageJson` (`run-cost.ts`), então os números convergem sozinhos.

| # | Item | Onde | Como |
|---|---|---|---|
| S4.1 | Índice | migration | `@@index([userId, createdAt])` em `AgentRun` (hoje só há `[userId, status]`). Migration + consulta no mesmo commit. |
| S4.2 | Períodos puros | `packages/shared/src/usage-period.ts` | `usagePeriodRange(period: "today"\|"7d"\|"30d", now, tz)`: início/fim e buckets diários no fuso informado (IANA validado; `now` injetado). Testes de virada de dia/DST. |
| S4.3 | Agregação | `packages/db/src/usage.ts` | Uma consulta por período com `$queryRaw` em **template tag** (nada de `Unsafe`): `WHERE "userId" = ${userId} AND "createdAt" >= ${from} AND "createdAt" < ${to} AND "parentRunId" IS NULL AND "usageJson" IS NOT NULL`, somando `("usageJson"->>'costUsd')::numeric`, `costUnknownCalls`, `planCalls`, tokens; agrupado por dia (`date_trunc('day', "createdAt" AT TIME ZONE ${tz})`), `botId` e modelo (`coalesce(usageJson->'telemetry'->>'servedModel', model)`). Top 10 modelos + "Outros". Agrega só runs raiz: o `usageJson` do pai já inclui o custo dos filhos (decisão 8). Moeda: USD (decisão 7). Nomes de bots por `findMany({ where: { id: { in }, ownerId: userId } })`; bot removido = "Bot removido". Custo ausente fica **ausente** (nunca 0): somar só quem tem e expor `costUnknownCalls` para `formatCostLabel`. Medir com `EXPLAIN` em 30d **(hipótese: suficiente para uso pessoal; se não, colunas desnormalizadas em `AgentRun`)**. |
| S4.4 | Rota | `apps/api/src/routes/usage.ts` | `GET /v1/usage?period=today\|7d\|30d&tz=<IANA>` atrás de `requireUser` + `scopeFor`; `userId` só da sessão; `period`/`tz` validados (enum/lista IANA); resposta `{ period, totals, byDay, byBot, byModel }` tipada em `shared`. Resposta vazia = zeros, não erro. |
| S4.5 | UI | `settings/sections/usage.tsx`, `lib/atlas-api.ts`, `hooks/use-usage.ts` | Dropdown de período; total do período com `formatCostLabel` (parcial quando há chamadas sem custo), "Chamadas no plano ChatGPT" (`planCalls`, sem `$`), listas por bot e por modelo com barra proporcional simples (sem biblioteca de gráfico nova), estado vazio ("Sem uso neste período") e de erro. Consultar o skill `dataviz` se houver gráfico. Reusar `components/providers/provider-run-cost.tsx` para o rótulo "plano". |

- **Testes:** `usagePeriodRange` (limites, fuso); db com fixtures de runs (custo parcial, plano, sem usage, filho de subagente não conta em dobro, run de outro usuário **não** entra); API: caminho feliz + **IDOR** (B nunca vê números de A; `userId` na query ignorado), `period`/`tz` inválidos → 400, vazio → zeros; componente com resposta mockada (parcial, plano, vazio, erro).
- **Commits:** `perf(db): índice de runs por usuário e data`, `feat(db): agregação de uso por período, bot e modelo`, `feat(api): GET /v1/usage escopado por usuário`, `feat(web): seção Uso nas configurações da conta`.

---

## Ordem de execução (fases)
Dono = Sonnet. Cada fase: worktree `agente-v5/<agente>` a partir de `rodada/desempenho`, commits atômicos com teste no mesmo commit, sem push.

| Fase | Issue | Itens | Depende de | Áreas permitidas |
|---|---|---|---|---|
| **S0** | #30 | S0.1–S0.7 | — | `packages/shared`, `packages/db` (`settings.ts`, schema, migration), `apps/api/src/{routes/settings.ts,config.ts,chat/*}`, `apps/worker/src/**`, `packages/llm/src/{decision-budget,chat-tools,config}.ts`, `packages/agent-runtime/src/{computer-use.ts (só params),execution/flag.ts}`, `.env.example` x3 |
| **S1** | #31 | S1.1–S1.7 | S0 | `apps/web/components/settings/**`, `lib/atlas-api.ts`, `hooks/use-account-settings.ts`, `chat-sidebar-footer.tsx`, `template-4-client.tsx` (mínimo), `components/icons/*` |
| **S2** | #32 | S2.1–S2.6 | S0, S1 | `apps/web/components/{providers,settings}/**`, `agent-settings.tsx`, `apps/api/src/{routes/{providers,bots,runs}.ts,providers/siwc-loopback.ts}`, `packages/agent-runtime/src/providers/siwc-service.ts`, `apps/worker/src/provider-services.ts` |
| **S3** | #33 | S3.1–S3.3 | S0, S1 | `apps/web/components/settings/sections/jev-execution.tsx` e testes |
| **S4** | #34 | S4.1–S4.5 | S0, S1 | `packages/db/{prisma,src/usage.ts}`, `packages/shared/src/usage*.ts`, `apps/api/src/routes/usage.ts`, `apps/web/components/settings/sections/usage.tsx`, `lib/atlas-api.ts`, `hooks/use-usage.ts` |

**Ordem:** S0 -> S1 -> (S2, S3 e S4 em paralelo; S2 e S4 mexem em `lib/atlas-api.ts`, então rebase antes de commitar). A API de Uso (S4.1–S4.4) não depende da casca e pode começar logo após S0, mas fica atrás de S1 no rastreador por simplicidade.
**Coordenação com a rodada de desempenho:** `computer-use.ts`, `chat-tools.ts` e `agent-run.ts` também são tocados por outras rodadas. Em S0 mexer o mínimo (passagem de parâmetros), rebase antes de commitar e registrar conflito em `REVIEW.md`.

---

## Verificação
- Suítes: `pnpm --filter @workspace/shared test`, `@workspace/db test`, `@workspace/llm test`, `@workspace/agent-runtime test`, web (`pnpm --filter web test` ou o script do pacote), API e worker (`NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`), `pnpm exec turbo typecheck`. Mudou `shared`/`db`/`llm`: `pnpm exec tsc` no pacote antes dos testes de api/worker (usam `dist/`). Windows: `prisma generate` pode dar EPERM; pare o processo que usa o client, não mascare.
- Regressões obrigatórias:
  - sem `configJson`, todos os valores efetivos são idênticos aos de hoje (teste de tabela do resolver + replays existentes do agente intactos);
  - nenhum segredo no `configJson`, na resposta de `/v1/settings` ou em log (`rg "apiKey|secret|token"` nos serializadores novos);
  - B nunca lê nem altera config/uso de A;
  - `agent-settings.tsx` não importa mais `ProvidersSettings`.
- Checklist manual (dono): abrir o modal pelo avatar; Esc fecha e devolve o foco; busca "jev"/"passos"/"plano"; mudar um dropdown, recarregar e ver persistido; mudar o modelo de manutenção e ver o próximo resumo usar; desligar/ligar o plano ChatGPT e conferir a porta 53682 (sobe só no Conectar, fecha ao desligar); run longo com config alterada no meio (o run em curso não muda); Uso de 7d bate com a soma dos runs.

## Riscos
| Risco | Mitigação |
|---|---|
| Mudança de comportamento por engano na migração de leitura de env. | Resolver puro com teste de tabela de cada linha; "sem config = hoje" como regressão; libs mantêm env como último recurso. |
| Worker lê config no boot (singleton) e a UI "não pega". | Resolução por run/job com snapshot; teste com dois usuários no mesmo processo. |
| Vazamento entre usuários via linha legada `id="default"`. | `configJson` lido só por `userId`; `claim-default` não copia; teste. |
| Segredo parar no `configJson`. | Validação estrita (só chaves conhecidas, modelos/enums/números); sem campo de texto livre; teste de snapshot da resposta. |
| Listener SIWC aberto sem necessidade / callback dependente do env. | Sobe só no Connect, fecha ao desligar, gate pelo `userId` do `state`. |
| Consulta de Uso lenta ou contando em dobro (subagentes, reconciliação). | Índice `(userId, createdAt)`, só `parentRunId IS NULL`, `EXPLAIN`, teste com filho. Plano B: colunas desnormalizadas. |
| Custo "desconhecido" virar `$0`. | Soma só de valores presentes + `costUnknownCalls` + `formatCostLabel`; teste. |
| Conflito de arquivos com rodadas paralelas (`computer-use.ts`, `agent-run.ts`, `template-4/*`, `lib/atlas-api.ts`). | Fases pequenas, rebase antes de commitar, registrar em `REVIEW.md`, não commitar mudanças do usuário. |
| Presets de timeout/saída com valores ruins. | **(hipótese)** valores sugeridos; validar com o usuário (pergunta 5); ms exatos seguem no env. |

## Decisões do usuário (perguntas em aberto)
Respostas de 04/10/2026 às perguntas abaixo; prevalecem sobre qualquer trecho anterior do plano.
1. **Env é só padrão para o ChatGPT.** Com `ATLAS_PROVIDER_CHATGPT_ENABLED=false` no servidor, o dono ainda pode ligar o plano ChatGPT na UI. O gate de dono (`ATLAS_OWNER_EMAIL`) permanece sempre.
2. **Desligar o switch mantém a conexão.** Os tokens ficam no cofre. Há uma ação separada, "Desconectar da conta", que desconecta e remove os tokens.
3. **Jev:** um dropdown geral, mais os 6 dropdowns por recurso dentro de um `Collapsible` fechado por padrão.
4. **A seção da nav do modal fica na URL** (ex.: `?settings=jev`), para que recarregar mantenha a seção aberta.
5. **Geral e Conta são duas entradas** de nav.
6. **Memória:** não há tela ainda; o atalho é omitido até existir.
7. **Moeda:** USD.
8. **Uso conta só runs raiz** (`parentRunId IS NULL`), porque o `usageJson` do pai já inclui o custo dos filhos.

A pergunta 5 (presets) segue com os valores sugeridos da tabela até o usuário pedir ajuste.

## Perguntas em aberto (resolvidas, ver acima)
1. **Geral e Conta**: uma entrada de nav ou duas? (O plano assume duas, ambas na S1.)
2. **Memória**: não achei tela de Memória no web (só `apps/api/src/routes/memory.ts` e a tool). O atalho abre o quê? Sugestão: omitir o item até existir a tela, ou abrir uma lista simples somente leitura (fora desta rodada).
3. **Plano ChatGPT e env `false`**: o env funciona só como padrão (o usuário dono pode ligar na UI) ou como trava do servidor (env `false` explícito bloqueia)? O plano assume padrão (decisão 2), mantendo sempre o gate de dono.
4. **Desligar o plano ChatGPT** mantém os tokens no cofre (assumido) ou desconecta junto?
5. **Presets** de prazo (Curto/Padrão/Estendido) e de saída máxima: valores sugeridos servem?
6. **Jev**: dropdown geral + 6 por recurso recolhidos é compacto o bastante, ou só o geral na v1?
7. **Moeda**: Uso mostra US$ como o resto do app (`formatCostLabel`); precisa de BRL?
8. **Subagentes**: confirmar se `usageJson` do pai já soma os filhos (afeta a agregação do Uso).
