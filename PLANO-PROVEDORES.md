# Plano Provedores — assinatura ChatGPT como provedor de modelo (SIWC) e seletor por provedor

**Status: PROPOSTO em 04/10/2026.** Nada aqui está implementado. Itens marcados **(hipótese)** exigem verificação (teste real ou leitura de doc) antes de depender deles.

## Cabeçalho da rodada
- **Branch base:** `rodada/desempenho`. Worktree por agente: `agente-v4/<agente>` criada a partir dela (ver `10-git-worktree.md`).
- **Regras:** `.agents/rules/` (fonte única). Leia `00-core`, `10-git-worktree`, `20-commits`, `30-componentizacao`, `40-seguranca`, `50-testes` e `60-agente`. Convenções de issue em `docs/agents/issue-tracker.md`.
- **Commits:** atômicos, Conventional Commits em pt-BR, `git add` explícito, sem push.
- **Texto para o modelo** (prompts, descrições de tools, mensagens injetadas): inglês neutro e genérico, sem exemplos de nicho. **Texto para o usuário:** pt-BR.
- **Todo item vem com teste**, no mesmo commit (ver `50-testes.md`). Nada de rede real em teste unitário.
- **Dono da execução:** GPT/Codex. Revisão: o orquestrador.
- **Spike de referência (descartável, fora do repo):** `C:\Dev\Personal\atlas-spike-siwc\` (`src/auth.ts`, `store.ts`, `models.ts`, `login.ts`, `test-tools.ts`, `README.md`). Ele codifica o protocolo confirmado. **Não copiar o código às cegas:** reaproveitar o protocolo, escrever de novo nos pacotes certos, com cofre, escopo por dono e testes.

---

## Contexto
Hoje todo modelo passa pelo OpenRouter (cobrança por token, `apiKey` única do worker). O dono tem uma assinatura ChatGPT Plus/Pro e quer usá-la como segundo provedor, pelo fluxo oficial **Sign in with ChatGPT (SIWC), modo token sharing para apps open-source / projetos pessoais locais** (https://developers.openai.com/siwc). A OpenAI emite ao app um token que consome a cota do plano do usuário via `POST /v1/responses`.

Um spike descartável já validou o protocolo com o modelo `luna`: function tools, tool calls paralelas (2 `function_call` numa resposta), multi-turn com `function_call_output` e itens `reasoning` ecoados, visão e streaming funcionam. O `usage` traz tokens de entrada/saída/cache/cache_write/reasoning com atribuição por item; **não há custo em USD nem headers de cota**.

Objetivo: o dono escolhe, por bot, entre modelos do OpenRouter e modelos do ChatGPT (plano), em um seletor agrupado por provedor, sem mudar o loop do agente (`agent-runtime` continua agnóstico de provedor) e sem quebrar os ids de modelo já gravados.

### Política e conformidade (importante)
- O recurso é **preview** e a doc o permite para "open-source projects, personal projects that run locally, and selected private apps". App pago ou hospedado remotamente precisa da lista de espera da OpenAI. **O Atlas só pode usar isto como projeto pessoal local, com o dono como único usuário.** Abrir para multiusuário/hospedado está **fora de escopo** e exige a waitlist.
- A flag nasce **desligada** e a rota exige o dono (`ATLAS_OWNER_EMAIL`).
- A UI mostra um aviso curto: "Uso pessoal: consome a cota do seu plano ChatGPT. Recurso em preview."

### Fatos confirmados (spike + docs)
- OAuth 2.0 PKCE S256. Authorize `https://auth.openai.com/api/accounts/authorize`; token `POST https://auth.openai.com/api/accounts/oauth/token` (form-urlencoded: `client_id`, `code`, `code_verifier`, `redirect_uri`, `resource`; sem client secret).
- Primeiro login com `client_id=dynamic_agent_client` + `ext_agent_host_id` (`urn:uuid:…`, **persistido e estável**) + `agent_name_hint`. O `client_id` emitido (`oaiapp_…`) volta no callback e **deve ser salvo**; `dynamic_agent_client` nunca é persistido como credencial.
- Escopos: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`. `resource=https://api.openai.com/v1`. Validar que a resposta do token contém `chatgpt.tokens.use.direct` antes de habilitar inferência.
- Redirect: `http://127.0.0.1:<porta>/callback`. Esquema, host e caminho são fixos; **só a porta varia**; `localhost` não vale; o mesmo URI vai no authorize e na troca do code. O `id_token` é validado por JWKS (`https://auth.openai.com/.well-known/jwks.json`, issuer `https://auth.openai.com`, audience = client_id emitido).
- Access token dura 1 h. Refresh token dura 30 dias e é **rotativo**. Erros fatais: `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_reused`. A resposta pode trazer `earliest_refresh_at`.
- `GET /v1/models` lista slugs (`slug`, `display_name`, `visibility`). `POST /v1/responses` com `stream:true`, `store:false`, histórico completo em `input`, `instructions` no lugar do system.
- **Ausentes:** `max_output_tokens`, `temperature`, `top_p`, `previous_response_id`; sem MCP hospedado, file search nem tool_search. Function tools e web search existem.
- Erros: `subscription_sharing_usage_limit_exceeded` (429), `subscription_sharing_unsupported_capability` (400), `subscription_sharing_not_eligible` (403), `subscription_sharing_invalid_user` (401).
- Cache: `prompt_cache_retention: "24h"`, mas o `prompt_cache_key` voltou aleatório por request. Se podemos enviar uma chave estável nossa é **(hipótese)**.

### Fora de escopo (explícito)
- **Assinatura da Anthropic (Claude Pro/Max): uso PROIBIDO pelos termos deles. Não implementar, não pesquisar contorno, não deixar gancho "para depois".**
- Reaproveitar tokens, client id ou `auth.json` do Codex CLI. Só o fluxo oficial SIWC com client dinâmico.
- Multiusuário ou hospedagem remota com a assinatura (exige waitlist).
- Troca do Jev, resumo, revisão de memória e reconciliação de custo para o ChatGPT (ficam no OpenRouter).
- Geração de imagem e embeddings pelo ChatGPT.
- Renomear a coluna `Bot.openRouterModel` (continua guardando o id de modelo, agora com prefixo opcional).

---

## Mapa do código (onde cada coisa entra)
| Ponto | Onde | Observação |
|---|---|---|
| Seam do LLM | `packages/agent-runtime/src/computer-use.ts:4234,4390,4916` (`params.streamChat ?? streamChatWithTools`) | O loop já recebe `streamChat` por injeção. O adaptador entra **aqui**, sem mexer no loop. Hoje passa `apiKey` única do worker (`apps/worker/src/processors/agent-run.ts:357,599`). |
| Chat Completions | `packages/llm/src/chat-tools.ts` (`LlmMessage`, `ChatTool`, `LlmUsage`, `streamChatWithTools`, `usageFrom`) | Formato interno de mensagens = Chat Completions. O adaptador traduz de/para Responses. |
| Prazo, retry, abort | `decision-budget.ts` (`createDecisionBudget`, `abortable`), `config.ts` (`withLlmStepRetry`, `isRetryableLlmError`), `signal.ts`, `timing.ts` | Reaproveitar. **`isRetryableLlmError` trata 429 como retentável: o `usage_limit` do plano não pode ser retentado.** |
| Cache de prompt | `prompt-cache.ts` (breakpoints Anthropic/OpenRouter), `sessionId` | Não se aplica ao ChatGPT; ver P1.7. |
| Escolha do modelo | `packages/shared/src/effective-model.ts` (`pickEffectiveModel`), `Bot.openRouterModel`, `Routine.model`, `OPENROUTER_FALLBACK_MODELS` (`llm/config.ts`) | Id de modelo é uma string livre. |
| Catálogo | `apps/api/src/routes/models.ts` (`GET /v1/models`), `apps/worker/src/openrouter-models.ts`, `llm/model-catalog-cache.ts` | Single-flight/stale/cooldown já existem: reaproveitar. |
| Cofre | `packages/agent-runtime/src/mcp/secret-box.ts` (`sealSecrets`/`openSecrets`, AES-256-GCM, `CONNECTOR_ENCRYPTION_KEY`) e `McpConnection.secretsEnc` | Tipos hoje são de MCP; extrair o núcleo genérico. |
| OAuth de conectores | `apps/api/src/routes/mcp.ts:~270-300,~515-575` (state de uso único em hash, claim por dono, TTL 15 min), `mcp/oauth-provider.ts` | Reaproveitar os padrões de `state` e PKCE (não o SDK MCP). |
| Auth do dono | `apps/api/src/auth.ts` (`ATLAS_OWNER_EMAIL`), `middleware/auth.ts` (`requireUser`, `isPublicV1Request`), `scopeFor(session)` | |
| Telemetria | `shared/src/run-telemetry.ts` (`StepTelemetry`), `agent-runtime/src/telemetry/step-telemetry.ts`, `computer-use.ts:~4936` (`costUnknownCalls`), `db/src/run-cost.ts` (reconciliação por `generationId`) | |
| UI | `apps/web/components/model-picker.tsx` (142 linhas), `ai-elements/model-selector.tsx` (226), `lib/openrouter-models.ts` (`groupModelsByProvider`), `lib/atlas-api.ts:379`, `packages/ui/src/components/collapsible.tsx` | |
| Manutenção | `apps/worker/src/processors/{summary,memory-review}.ts`, `llm/jev-decisions.ts`, `worker/src/image-vision.ts` | Continuam no OpenRouter. |

---

## P1 — Abstração de provedor e adaptador Responses (`packages/llm`, `packages/shared`)

### Decisão: namespace do id de modelo
- Formato canônico de referência: **`chatgpt/<slug>`** para o ChatGPT. **Id sem prefixo conhecido = OpenRouter** (ids OpenRouter já têm a forma `vendor/model`, ex.: `openai/gpt-4o-mini`).
- Compatibilidade: nenhum id existente muda. `Bot.openRouterModel`, `Routine.model`, `requested` do composer e `OPENROUTER_FALLBACK_MODELS` continuam válidos como OpenRouter.
- Função pura em `packages/shared` (`model-ref.ts`): `parseModelRef(id) -> { provider: "openrouter" | "chatgpt"; slug: string }` e `formatModelRef(provider, slug)`. `pickEffectiveModel` não muda (continua devolvendo string).
- **(hipótese)** Nenhum vendor do OpenRouter se chama `chatgpt`. Verificar contra o catálogo real antes de fixar; se houver colisão, usar `chatgpt:<slug>`.
- Slug com caracteres fora de `[A-Za-z0-9._:-]` é rejeitado (vai para corpo de request, ver `40-seguranca.md`).

| # | Item | Onde | Como |
|---|---|---|---|
| P1.1 | `parseModelRef`/`formatModelRef` | `packages/shared/src/model-ref.ts` | Funções puras; vazio, prefixo desconhecido, slug inválido, caixa. Teste de limites e de retrocompatibilidade com ids reais do OpenRouter. |
| P1.2 | Roteador de provedor | `packages/llm/src/provider-router.ts` | `createProviderStreamChat({ openrouter, chatgpt })` devolve uma função com a **mesma assinatura** de `streamChatWithTools` (`CompleteChatWithToolsParams` -> `CompleteChatWithToolsResult`). Despacha por `parseModelRef(params.model)`. É o valor passado em `params.streamChat` do `runComputerUse`; **o loop do agente não muda**. |
| P1.3 | Credencial por provedor, injetada | `llm/provider-router.ts`, worker | O `chatgpt` não usa `apiKey` string: recebe `getAccessToken(): Promise<string>` por injeção (resolvido no worker com o `userId` do run). Nenhum token entra em `CompleteChatWithToolsParams` nem em log. |
| P1.4 | Tradução de entrada | `llm/responses/to-responses.ts` (puro) | `LlmMessage[]` -> `{ instructions, input }`. `system` vira `instructions` (concatenar vários); `user` texto/`image_url` -> `input_text`/`input_image` (`image_url` Data URL); `assistant.content` -> item de mensagem `output_text`; `assistant.tool_calls[]` -> itens `function_call` **preservando `call_id` = `tool_call.id`**; `role:"tool"` -> `function_call_output` com o mesmo `call_id`. Tools -> `{ type:"function", name, description, parameters }` (formato Responses, sem o envelope `function`). `screenshot_ref`/`image_ref` nunca chegam aqui (o runtime já expandiu). Teste: ida e volta preserva ids e ordem; par `function_call`/`function_call_output` sempre casado (órfão -> erro claro, não request inválido). |
| P1.5 | Itens `reasoning` | `llm/responses/*`, `shared` (tipo) | O resultado do adaptador devolve, junto da mensagem `assistant`, os itens `reasoning` e `function_call` crus na ordem recebida em um campo opaco `providerItems` (tipo novo em `LlmMessage`/resultado, ignorado pelo OpenRouter). Na próxima chamada ao **mesmo provedor/modelo**, `to-responses` os reinjeta em vez de reconstruir. Troca de provedor ou de modelo no meio do run: **descarta** `providerItems` (reasoning de um modelo não vale em outro). O spike mostrou que ecoá-los funciona; **(hipótese)** descartá-los também funciona, medir antes de tornar obrigatório. Higiene/compactação (`hygiene.ts`) tem de manter `providerItems` casados com as mensagens que os originaram (ou descartar o conjunto). |
| P1.6 | Leitura do SSE Responses | `llm/responses/sse.ts` | Reaproveitar o leitor de SSE (`sse-stream.ts`) estendendo para eventos nomeados. Eventos: `response.output_text.delta` -> `onDelta`; `response.output_item.done` com `function_call` -> tool call completa (`call_id`, `name`, `arguments` string; vazio -> `"{}"`); `response.completed`/`incomplete`/`failed`; evento `error`. Um `function_call` por item (sem `index` parcial como no Chat Completions). Stream que termina sem evento terminal = erro retentável (não resposta vazia). Qualquer chunk útil marca `attempt.markUseful()`/TTFT como hoje. |
| P1.7 | Mapeamento de `usage` | `llm/responses/usage.ts` (puro) | `input_tokens` -> `promptTokens`; `output_tokens` -> `completionTokens`; `input_tokens_details.cached_tokens` -> `cachedTokens`; cache_write -> `cacheWriteTokens`; `output_tokens_details.reasoning_tokens` -> novo `reasoningTokens` (opcional em `LlmUsage`). **Sem custo:** marcar `costKind: "plan"` (novo, ver P4.4), nunca `costUnknown` nem `costUsd: 0`. Nomes exatos dos campos: conferir contra fixture do spike. |
| P1.8 | Parâmetros não suportados | `llm/responses/request.ts` | O corpo só leva `model`, `instructions`, `input`, `tools`, `tool_choice`, `parallel_tool_calls` (se aceito), `stream:true`, `store:false`, `prompt_cache_key`/`prompt_cache_retention` (P1.9). **Nunca** `max_output_tokens`, `max_tokens`, `temperature`, `top_p`, `previous_response_id`, `reasoning.max_tokens`. Teste de snapshot do corpo garante a ausência. `maxOutputTokens`/`reasoningMaxTokens` recebidos são ignorados e o resultado informa `appliedOutputCap:false` (ver riscos: L22 não se aplica). Tools que o ChatGPT não suporta (MCP hospedado, file search, tool_search) nunca são enviadas. Web search nativo só se o runtime já o usa como tool nativa **(hipótese: avaliar depois, fora do MVP)**. |
| P1.9 | Chave de cache de prompt | `llm/responses/request.ts` | **(hipótese)** enviar `prompt_cache_key = <runId>` (estável por run, vindo de `params.sessionId`) melhora o `cached_tokens` entre passos do mesmo run. O spike viu a chave voltar aleatória, então pode ser ignorada ou sobrescrita. Verificar com 2 chamadas seguidas com prefixo igual e comparar `cached_tokens`. Se não funcionar, não enviar a chave (sem efeito colateral) e confiar no cache automático. Não vazar o `runId` de outro dono: a chave é só o id do run do próprio dono. |
| P1.10 | Prazo, abort, retry | `llm/responses/stream.ts` | Usar `createDecisionBudget(params)` (deadline por decisão, 1º evento, inatividade — L8), `modelCallSignal`, `abortable` e `createCallTimer` como o caminho OpenRouter, para TTFT e `timing` idênticos na telemetria. `withLlmStepRetry` com `retryIf` próprio: **não retentar** `subscription_sharing_usage_limit_exceeded`, `_unsupported_capability`, `_not_eligible`, `_invalid_user`; 5xx e rede sim; 401 vira "renovar token e repetir uma vez" (P2). Erros viram `ChatgptProviderError { status, code }` (subclasse que preserva `status` para `isRetryableLlmError` e `code` para o roteamento da P4). Mensagem de erro passa por `redactSecrets` antes de sair. |
| P1.11 | Capacidades do modelo | `llm/responses/capabilities.ts` | `supportsVision`/`supportsTools`/`supportsOutputCap` por provedor, consultáveis pelo runtime (substitui suposições do tipo "este modelo aceita `max_tokens`"). Imagem para modelo sem visão -> mesmo comportamento que o OpenRouter hoje (caller verifica). |

- **Áreas permitidas:** `packages/llm/src/responses/**` e `provider-router.ts` (novos), `packages/llm/src/{index,chat-tools}.ts` (só tipos/exports mínimos), `packages/shared/src/model-ref.ts`, `packages/agent-runtime/src/{computer-use.ts (só tipos de `providerItems`), hygiene.ts}`.
- **Não tocar** a lógica de `chatRequestBody`/fallbacks OpenRouter (pertence às rodadas de desempenho F3/F3b/F6).
- **Testes:** ver P6 (fixtures). Cada item acima tem teste no próprio commit.
- **Commits:** `feat(shared): referência de modelo por provedor`, `feat(llm): adaptador Responses (tradução, stream e usage)`, `feat(llm): roteador de provedor para streamChat`.

---

## P2 — Autenticação SIWC, tokens no cofre e refresh seguro (`packages/db`, `apps/api`, `packages/agent-runtime`)

### Fluxo de login ("Conectar ChatGPT")
1. A UI chama `POST /v1/providers/chatgpt/connect` (sessão do dono). A API cria o `state` aleatório, o PKCE (`code_verifier`, `code_challenge` S256) e o `nonce`, grava **hash do state** + verifier + nonce no cofre (padrão de `mcp.ts`, TTL 15 min, uso único) e devolve `authorizeUrl`.
2. A UI abre o `authorizeUrl` (popup). O usuário aceita o consentimento ("usar seu plano ChatGPT").
3. O navegador volta para **`http://127.0.0.1:<porta>/callback`**. Esse host é diferente de `localhost:3000`/`ATLAS_URL`, então **o cookie de sessão do Atlas não é enviado**: o callback não pode exigir sessão. Ele se autentica por `state` de uso único + PKCE + posse (o state está ligado ao `userId` que iniciou). Isso é uma exceção deliberada à regra de `requireUser`; registrar a justificativa no código e em `REVIEW`.
4. O callback troca o `code` por tokens (`resource` e `redirect_uri` idênticos), valida o `id_token` por JWKS (issuer, audience = client_id emitido, nonce), confere o escopo `chatgpt.tokens.use.direct`, grava no cofre e redireciona o navegador para `${ATLAS_URL}/…?provider=chatgpt&status=ok|error` (sem token na URL).

### Decisão: quem escuta o callback
**Listener loopback dedicado dentro do processo da API**, não uma rota pública na porta principal:
- `ATLAS_SIWC_CALLBACK_PORT` (porta fixa, padrão 53682, configurável; **(hipótese)** a OpenAI aceita qualquer porta, como a doc indica). Sobe só durante um login pendente (ou fica ligado quando a flag está ligada) e **atende só `GET /callback`**. Não expõe nenhuma outra rota nem o resto da API.
- Rodando local (processo na máquina): bind em `127.0.0.1`. Rodando em Docker: bind em `0.0.0.0` dentro do container com publicação `127.0.0.1:<porta>:<porta>` no compose (nunca `0.0.0.0` no host). Documentar nos `.env.example`.
- Requer que o **navegador esteja na mesma máquina** que a API (projeto pessoal local). Em VM/servidor remoto o fluxo não funciona; a doc "self-hosted VMs" trata disso e fica **fora de escopo** (registrar como limitação, ver riscos).
- Alternativa descartada: helper local separado (mais um processo para instalar e autenticar) e rota pública em `/v1` (amplia a superfície pública).

### Armazenamento, refresh e desconexão
| # | Item | Onde | Como |
|---|---|---|---|
| P2.1 | Modelo de dados | `packages/db/prisma` (migration) + `db/src/provider-connections.ts` | Tabela `ProviderConnection` (`id`, `userId` FK, `provider`, `status` `connected|needs_login|error`, `secretsEnc`, `accountEmail`, `scopes`, `accessExpiresAt`, `lastError` sanitizado, `lastLimitAt`, timestamps). Único `(userId, provider)`. Toda função recebe `userId` e filtra `where: { id|provider, userId }` (nada de `findUnique` por id e checar depois). Migration e código juntos num commit; não misturar com outra feature. |
| P2.2 | Cofre | extrair o núcleo genérico de `mcp/secret-box.ts` para um módulo reutilizável (`seal/open` de um objeto qualquer) mantendo `sealSecrets/openSecrets` do MCP | Segredos do provedor: `accessToken`, `refreshToken`, `idToken`, `clientId` emitido, `hostId`, `codeVerifier`/`nonce`/`stateCreatedAt` (login pendente). Mesma chave `CONNECTOR_ENCRYPTION_KEY`; sem chave -> flag/rota respondem 503. `ext_agent_host_id` é gerado uma vez e persistido por instalação (no registro do dono). |
| P2.3 | Refresh single-flight entre processos | `db/src/provider-connections.ts` (`withProviderRefreshLock`) + `llm`/`agent-runtime` | `getAccessToken(userId)`: se faltar > 2 min para expirar, devolve o token do cofre (ler do banco; **não** cachear token além de uns segundos em memória). Senão: (1) single-flight em processo (`Map<userId, Promise>`); (2) dentro de uma transação Postgres, `pg_advisory_xact_lock(hashtext('provider-refresh:'+id))` (padrão já usado em `db/src/runs.ts:389,1045`); (3) **relê** a linha depois do lock — se outro processo (API ou worker) já renovou, usa o novo; (4) só então chama o token endpoint, grava o par novo (access + refresh rotativo + `earliest_refresh_at`) **antes de soltar o lock**. Respeita `earliest_refresh_at`. Timeout curto no fetch do refresh. Como o refresh antigo morre ao rotacionar, falha de rede **depois** de a OpenAI responder e **antes** do commit perde o token novo: gravar imediatamente e tratar o caso como `needs_login` (aceitar o risco; documentar). **(hipótese)** existe janela de tolerância do refresh antigo, não contar com ela. |
| P2.4 | Erros fatais -> relogin | mesmo módulo | `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_reused` marcam `status=needs_login`, limpam os tokens (mantêm `clientId` e `hostId`) e fazem o provedor falhar com `ChatgptProviderError code=needs_login`, sem retry. A UI mostra "Reconecte o ChatGPT". Erro transitório (rede, 5xx) não muda o status. |
| P2.5 | 401 durante inferência | `llm/responses/stream.ts` | 401 uma vez -> `getAccessToken(userId, { force:true })` (mesmo lock) -> repete a chamada **uma** vez. Depois disso, `needs_login`. `_invalid_user` (401 do SIWC) vai direto a `needs_login`. |
| P2.6 | Desconectar | `DELETE /v1/providers/chatgpt` | Apaga tokens do cofre e marca `disconnected`; best-effort de revogar na OpenAI **(hipótese: existe endpoint de revogação; senão orientar o usuário a revogar em Configurações do ChatGPT)**. Bots que usavam `chatgpt/*` passam a cair no fallback OpenRouter da P4 (nunca falham em silêncio). |
| P2.7 | Rotas | `apps/api/src/routes/providers.ts` | `GET /v1/providers` (status, e-mail da conta, sem tokens), `POST /v1/providers/chatgpt/connect`, `DELETE /v1/providers/chatgpt`, `GET /v1/providers/chatgpt/models` (P3). Todas atrás de `requireUser` + `scopeFor`. Só o dono (`ATLAS_OWNER_EMAIL`) e só com `ATLAS_PROVIDER_CHATGPT_ENABLED=true`; flag desligada -> 404 (a feature não "existe"). `userId` nunca de body/query. Recurso de outro dono -> 404. |
| P2.8 | Flag e config | `.env.example` (raiz, api, worker) | `ATLAS_PROVIDER_CHATGPT_ENABLED` (default `false`), `ATLAS_SIWC_CALLBACK_PORT` (padrão **53682**, configurável; decisão 6), reuso de `ATLAS_URL` e `CONNECTOR_ENCRYPTION_KEY`. Sem valores reais. |
| P2.9 | Segredos | todo o caminho | Tokens nunca em log, `tool_result`, SSE, erro, URL de redirect nem commit. Corpo de erro da OpenAI passa por `redactSecrets` (JWTs, `Bearer …`, tokens salvos), como o `redact.ts` do spike. Não logar objetos de request/sessão/conexão. |
| P2.10 | Teste de IDOR | `apps/api/src/routes/providers.test.ts` (padrão `scope.test.ts`) e `db` | Usuário B: não vê status, não desconecta, não usa nem renova a conexão do usuário A; `state` de A usado na sessão de B (ou sem sessão com state errado/expirado/reusado) é recusado; callback sem `state` ou com `state` já consumido não grava nada. |

- **Áreas permitidas:** `packages/db/prisma/**`, `packages/db/src/provider-connections.ts` (+ `index.ts`), `packages/agent-runtime/src/mcp/secret-box.ts` (extração do núcleo, sem mudar o comportamento do MCP), módulo novo de auth do provedor (em `packages/llm/src/responses/auth/**` ou `packages/agent-runtime/src/providers/**`, o que respeitar as camadas: `llm` não importa `db`, então o lock vem **injetado**), `apps/api/src/routes/providers.ts`, `apps/api/src/index.ts` (montar), `apps/api/src/middleware/auth.ts` (nada, o listener loopback é separado), `.env.example` x3.
- **Testes:** ver P6 (corrida de refresh, IDOR). Fatais, 401 e desconexão cobertos aqui.
- **Commits:** `feat(db): conexões de provedor escopadas por dono`, `feat(api): login SIWC do ChatGPT e callback loopback`, `feat(llm): refresh rotativo com single-flight entre processos`, `feat(api): desconectar ChatGPT`.

---

## P3 — Catálogo de modelos por provedor (`apps/api`, `packages/shared`, `apps/worker`)

| # | Item | Onde | Como |
|---|---|---|---|
| P3.1 | Tipo de catálogo por provedor | `packages/shared` | Generalizar o contrato de `ListModelsResponse` (hoje só `OpenRouterModel[]`): cada modelo ganha `provider: "openrouter" | "chatgpt"` e o `id` já é a referência canônica (`chatgpt/<slug>`). Compatível: clientes antigos ignoram o campo novo. `groupModelsByProvider` do web continua agrupando o vendor dentro do OpenRouter. |
| P3.2 | Listagem ChatGPT | `apps/api/src/routes/providers.ts` | `GET /v1/providers/chatgpt/models`: chama `GET https://api.openai.com/v1/models` com o token do **dono da sessão**, usando `createModelCatalogCache` (TTL 1 h, stale em falha, cooldown 30 s, single-flight) **uma cache por usuário** (chave `userId`), nunca compartilhada. Mantém `visibility === "list"` na lista do seletor (ocultos só se já selecionados). Falha ou desconectado -> lista vazia + `status`, não 500. |
| P3.3 | Capacidades | mesmo | Se `/v1/models` trouxer flags de capacidade, mapear para `{ tools, vision }`. **(hipótese)** o spike só viu `slug/display_name/visibility`; sem flag, marcar `capabilities: "unknown"` e tratar visão pelo erro `_unsupported_capability` (400) com mensagem clara, sem derrubar o run. Nunca assumir visão por nome de modelo. |
| P3.4 | Validação de modelo na escrita | `routes/bots.ts`, `routes/runs.ts`, `isKnownModelId` | `chatgpt/<slug>` só é aceito se a flag está ligada, o dono tem conexão `connected` e o slug está no catálogo (se o catálogo estiver indisponível, aceita com aviso: não bloquear por catálogo fora, como `isKnownModelId` já devolve `null`). `peekModelContextLength` e `supportsImageInput` (worker) passam a considerar o provedor; janela de contexto do ChatGPT **(hipótese)**: usar o campo do `/v1/models` se existir, senão valor conservador configurável. |
| P3.5 | Modelos recomendados | `packages/shared/src/recommended-models.ts` | Lista curada (id, rótulo pt-BR, nota curta) por provedor, para a UI mostrar primeiro. Pura, testada. Slugs reais do ChatGPT só depois de lidos de `/v1/models` do dono; a lista curada referencia por slug e some se o slug não existir no catálogo. |

- **Áreas permitidas:** `apps/api/src/routes/{models,providers,bots,runs}.ts`, `apps/worker/src/openrouter-models.ts` (só o necessário para considerar o provedor), `packages/shared`.
- **Testes:** catálogo com fetch mockado (formato do spike), cache por usuário (A não vê o cache de B), cooldown/stale, desconectado, modelo oculto.
- **Commits:** `feat(shared): catálogo de modelos com provedor`, `feat(api): lista de modelos do ChatGPT por usuário`.

---

## P4 — Política de roteamento, fallback, manutenção e telemetria (`apps/worker`, `packages/agent-runtime`, `packages/db`, `packages/shared`)

| # | Item | Onde | Como |
|---|---|---|---|
| P4.1 | Provedor por bot | `Bot.openRouterModel` guarda `chatgpt/<slug>`; worker/api usam `parseModelRef` | Sem coluna nova de provedor. `pickEffectiveModel` inalterado. O worker monta `streamChat = createProviderStreamChat(...)` (P1.2) e injeta em `runComputerUse`; o `apiKey` do OpenRouter segue para o ramo OpenRouter, e o ramo ChatGPT usa `getAccessToken(run.userId)`. O `userId` vem **do run**, nunca de param (worker/subagente herdam o dono). |
| P4.2 | Fallback no limite do plano | `llm/provider-router.ts` + config do bot | Em `ChatgptProviderError code=subscription_sharing_usage_limit_exceeded` (429), `needs_login`, `_not_eligible` ou indisponibilidade persistente: se o bot tem **fallback habilitado** (padrão: ligado com `deepseek/deepseek-v4.1-flash` no OpenRouter, configurável por bot: `none` ou outro modelo OpenRouter; decisão 4), repetir a decisão no modelo OpenRouter escolhido, emitir um evento/aviso visível ("Limite do plano ChatGPT atingido: usando <modelo>") e registrar `fallbackFrom` na telemetria. Só antes de qualquer `onDelta` entregue (mesma regra do `delivered` de `chat-tools.ts`); depois de texto entregue, falhar com mensagem amigável em vez de trocar no meio da resposta. Sem fallback -> run falha/pausa com mensagem acionável em pt-BR. Onde guardar a config: campo novo no bot ou JSON de configuração existente (implementador confere o padrão de `shared/src/bot.ts`; migration junto, se coluna). |
| P4.3 | Cooldown do limite | `db` (`lastLimitAt`) + roteador | Sem headers de cota, após um 429 `usage_limit` não tentar o ChatGPT de novo a cada passo: cooldown configurável (padrão 15 min **(hipótese: a janela de reset do plano não é documentada)**), persistido em `ProviderConnection.lastLimitAt` para valer entre processos. Passos seguintes do mesmo run vão direto ao fallback. |
| P4.4 | Telemetria com provedor e custo "plano" | `shared/src/run-telemetry.ts`, `agent-runtime/src/telemetry/step-telemetry.ts`, `computer-use.ts` (soma de usage), `db/src/run-cost.ts` | `StepTelemetry` ganha `provider`, `costKind?: "plan"`, `reasoningTokens?`, `fallbackFrom?`. `TokenUsage` ganha `planCalls` (contador) e **não** incrementa `costUnknownCalls` para chamadas do plano; custo USD continua não preenchido (nunca 0). `listStepsMissingCost` ignora passos `provider="chatgpt"` (não têm `generationId` mesmo, mas o filtro explícito evita reconciliar errado). Só metadados, nunca conteúdo. |
| P4.5 | Manutenção fica no OpenRouter | `worker/processors/{summary,memory-review}.ts`, `llm/jev-decisions.ts`, `image-vision.ts`, reconciliação de custo | Função pura `resolveMaintenanceModel(configured)` em `shared`: se receber `chatgpt/*`, **lança/ignora** e usa o modelo de manutenção OpenRouter. Jev, resumo, revisão de memória, descrição de imagem e reconciliação nunca chamam o ChatGPT. Teste garante que `streamChat` do ChatGPT não é invocado nesses caminhos. |
| P4.6 | Rotinas | `worker/processors/routine.ts` (`routine.model ?? bot.openRouterModel`) | **Decidido (04/10/2026): OpenRouter por padrão, plano só por opt-in.** Rotina que resolve para `chatgpt/*` roda no modelo OpenRouter de fallback do bot, a menos que a rotina tenha opt-in explícito "Usar plano ChatGPT" (campo da rotina, desligado por padrão). Rotinas rodam sem humano e podem queimar a cota do plano; opt-in consciente. Sem fallback configurado e sem opt-in -> `markRoutineRunSkipped` com motivo claro. |
| P4.7 | Subagentes | `agent-runtime/src/tools/delegate-task.ts` | **Decidido (04/10/2026):** subagentes herdam o provedor do run; leituras em paralelo (concorrência 3) multiplicam o consumo do plano. Reaproveitar o limite de concorrência atual e contar `planCalls`. Se a cota for um problema na medição, subagentes caem para o OpenRouter. |
| P4.8 | Orçamento sem teto de saída | `agent-runtime/src/budget.ts`, `computer-use.ts` (`agentOutputBudget`) | `maxOutputTokens`/L22 não se aplicam ao ChatGPT (P1.8). O orçamento de tokens do run passa a ser verificado **depois** de cada chamada com o `usage` real e a trava de orçamento (`budget.maxTokens`) continua válida; documentar que uma chamada pode ultrapassar o resto do orçamento. Teste com adaptador mockado devolvendo usage acima do saldo. |

- **Áreas permitidas:** `apps/worker/src/processors/{agent-run,routine,summary,memory-review}.ts`, `packages/agent-runtime/src/{telemetry/**,tools/delegate-task.ts,budget.ts}` e a fiação mínima em `computer-use.ts` (só passar `streamChat` e somar `planCalls`; **não engordar** o arquivo), `packages/llm/src/provider-router.ts`, `packages/db/src/{provider-connections,run-cost,bots,routines}.ts` + migration, `packages/shared`.
- **Testes:** fallback no 429 (antes e depois de delta), cooldown entre processos, manutenção nunca chama ChatGPT, rotina sem opt-in, telemetria `provider/costKind`, `costUnknownCalls` intacto, orçamento excedido por chamada sem teto.
- **Commits:** `feat(agent): roteamento de provedor com fallback para OpenRouter`, `feat(agent): telemetria com provedor e custo do plano`, `feat(routines): rotina usa o plano ChatGPT só com opt-in`, `fix(worker): manutenção e Jev sempre no OpenRouter`.

---

## P5 — UI: seletor agrupado por provedor e conexão (`apps/web`, `packages/ui`)

Estilo: **dropdown compacto** como Modelo/Idioma (sem cards de opção nem pílulas redundantes). Todos os textos em pt-BR. Ícones de marca como SVG com `fill="currentColor"`.

| # | Item | Onde | Como |
|---|---|---|---|
| P5.1 | Seletor por provedor | `apps/web/components/model-picker.tsx`, `ai-elements/model-selector.tsx` | Estrutura do conteúdo: (1) **modelo atual** fixo no topo, fora dos grupos; (2) um `Collapsible` (`@workspace/ui/components/collapsible`, Base UI) por provedor: "OpenRouter" e "ChatGPT (plano)", **todos FECHADOS por padrão**, com contagem; (3) dentro de "OpenRouter", **Recomendados primeiro** (lista curada da P3.5) e depois o restante por vendor; (4) campo de busca no topo cobrindo a lista longa: enquanto há texto, mostra resultados **planos entre provedores** (sem exigir abrir grupos; decisão 5). `groupModelsByProvider` segue agrupando vendor dentro do OpenRouter. Reaproveitar `Dialog`/`Command` já usados; teclado e `aria-expanded`/`aria-label` nos gatilhos. Componente de tela passando de ~250 linhas -> extrair subcomponentes (ex.: `provider-group.tsx`). |
| P5.2 | Estados do grupo ChatGPT | mesmo | Flag desligada: grupo **não aparece**. Desconectado: grupo visível, fechado, com a linha "Conectar ChatGPT" que leva à tela de conexão. `needs_login`: aviso "Reconecte o ChatGPT". Catálogo vazio/indisponível: mensagem curta. Modelo `chatgpt/*` selecionado com a conexão caída: mostra o rótulo e o aviso, nunca some. |
| P5.3 | Conexão e desconexão | `apps/web/components/ui/templates/template-4/*` (Configurações → Provedores, seção nova separada do Marketplace de MCP; decisão 1) | Entrada "ChatGPT" na seção "Provedores": estado (Conectado como <e-mail> / Não conectado / Reconectar), botão "Conectar ChatGPT" (abre o `authorizeUrl` em popup, escuta o retorno `?provider=chatgpt&status=…`), "Desconectar" com confirmação, e o aviso de uso pessoal e preview. Antes de editar `template-4/*`, **conferir mudanças não commitadas do usuário** (nunca stage/format o que não é seu). |
| P5.4 | Configuração do bot | `chat-context-panel/agent-settings.tsx` | Um dropdown para "Se o limite do plano acabar": "Usar <modelo OpenRouter>" (padrão `deepseek/deepseek-v4.1-flash`) / "Parar e avisar"; o aviso de fallback é visível na UI. Um dropdown "Rotinas usam o plano" só na rotina (opt-in). Nada de modos internos (cron, polling) expostos. |
| P5.5 | Custo "plano" | onde a UI exibe custo/uso do run | Chamadas do plano exibem "plano" no lugar de `$` e **não** entram como "custo desconhecido" nem como `$0,00`; tooltip: "Consome a cota do seu plano ChatGPT". |
| P5.6 | Cliente | `apps/web/lib/atlas-api.ts`, `hooks/use-atlas-chat.ts` | Funções tipadas para `/v1/providers*` e o catálogo por provedor (tipos de `packages/shared`). Sem `fetch` solto em componente. Tipo de evento do aviso de fallback compartilhado com `shared`. |

- **Testes:** componente do seletor (grupos fechados por padrão; atual no topo; busca; flag off; desconectado), fluxo conectar/desconectar com API mockada, rótulo "plano", acessibilidade básica. Teste visual manual no checklist.
- **Commits:** `feat(web): seletor de modelo agrupado por provedor`, `feat(web): conectar e desconectar ChatGPT nas configurações`, `feat(web): custo "plano" e aviso de fallback`.

---

## P6 — Testes, replay e checklist manual

### Testes automatizados (todos sem rede; LLM e `fetch` mockados)
| # | Teste | Onde |
|---|---|---|
| P6.1 | **Fixtures gravadas** com o formato do spike (SSE de texto, SSE com 2 `function_call`, SSE com `reasoning` + `function_call`, SSE `response.failed`, `usage` completo) em `packages/llm/src/responses/__fixtures__/*.sse` (sem tokens, sem ids reais de conta). Unit: tradução de entrada (ids e ordem), leitura do stream, mapeamento de usage (cached, cache_write, reasoning), corpo sem parâmetros proibidos (snapshot), mapeamento dos 4 códigos de erro, 401 -> refresh único. | `packages/llm` |
| P6.2 | **Corrida de refresh:** N chamadas concorrentes (mesmo processo) fazem 1 refresh; dois "processos" simulados (duas conexões ao Postgres de teste) disputam o lock e o segundo usa o token novo; refresh que devolve `refresh_token_reused`/`invalid_grant` -> `needs_login` sem retry; falha transitória não muda status; `earliest_refresh_at` respeitado; token nunca aparece em erro/log capturado. | `packages/db`, `llm` |
| P6.3 | **IDOR:** B não lê status, desconecta, usa, renova nem lista modelos da conexão de A; cache de catálogo por usuário; `state` cruzado/expirado/reusado/sem sessão; flag off -> 404; e-mail não-dono -> 403/404. | `apps/api` (padrão `scope.test.ts`) |
| P6.4 | **Replay do loop do agente** com `streamChat` do ChatGPT mockado por SSE Responses gravado: pedido -> 2 tool calls paralelas -> resultados -> resposta final; confere que o loop (provider-agnostic) executa as tools, devolve `function_call_output` com o `call_id` certo e reinjeta os itens `reasoning`; troca de modelo no meio descarta `providerItems`; 429 `usage_limit` antes do 1º delta vira fallback OpenRouter e gera o aviso; depois do 1º delta falha com mensagem; telemetria `provider=chatgpt`, `costKind=plan`, `costUnknownCalls` = 0. | `packages/agent-runtime` (`computer-use*.test.ts`, padrão de replay) |
| P6.5 | Regras de manutenção: Jev, resumo, memória, visão e reconciliação nunca invocam o ChatGPT; rotina sem opt-in cai no OpenRouter. | `apps/worker` |
| P6.6 | Retrocompatibilidade: ids antigos (`openai/gpt-4o-mini` etc.) seguem OpenRouter; nenhum snapshot do caminho OpenRouter muda. | `shared`, `llm` |

### Checklist manual (dono, na própria máquina, flag ligada)
1. Com a flag **desligada**: o seletor não mostra ChatGPT e `/v1/providers` responde 404.
2. Ligar a flag, "Conectar ChatGPT": popup abre, consentimento, volta ao Atlas conectado com o e-mail; nenhum token aparece em URL, console, logs ou resposta de rede.
3. Seletor: grupos **fechados**; modelo atual no topo; abrir "ChatGPT (plano)"; busca encontra modelos do OpenRouter sem abrir grupos.
4. Bot com `chatgpt/<slug>`: conversa com tools (ex.: 2 tools em paralelo), imagem anexada, rotina com e sem opt-in.
5. Rodar um run longo (> 1 h) e conferir a renovação do token sem erro; iniciar run no **worker** e usar o app na **API** ao mesmo tempo (sem `refresh_token_reused`).
6. Forçar o limite (ou simular 429) e ver o fallback com o aviso; custo aparece como "plano".
7. Desconectar: tokens somem; bot cai no fallback; reconectar funciona.
8. Verificar **(hipóteses)**: `prompt_cache_key` estável aumenta `cached_tokens`; descartar `reasoning` entre passos funciona; janela de contexto; flags de capacidade em `/v1/models`.
9. Registrar o resultado das hipóteses em `PLANO-PROVEDORES/REVIEW.md`.

---

## Ordem de execução (fases)
Dono = GPT/Codex. Cada fase: worktree `agente-v4/<agente>` a partir de `rodada/desempenho`, commits atômicos com teste no mesmo commit, sem push. Tudo atrás da flag `ATLAS_PROVIDER_CHATGPT_ENABLED` (padrão `false`).

| Fase | IDs | Dono | Áreas permitidas | Testes e commits |
|---|---|---|---|---|
| **P1 Abstração e adaptador Responses** | P1.1–P1.11 | GPT/Codex | `packages/llm/src/{responses/**,provider-router.ts,index.ts}`, `packages/shared/src/model-ref.ts`, tipos em `chat-tools.ts`/`computer-use.ts`/`hygiene.ts` (mínimo) | Fixtures SSE, tradução, usage, corpo sem params proibidos, erros. `feat(shared)`, `feat(llm)`. |
| **P2 Auth SIWC e refresh** | P2.1–P2.10 | GPT/Codex | `packages/db` (schema, `provider-connections.ts`), `mcp/secret-box.ts` (extração), `apps/api/src/routes/providers.ts`, listener loopback, `.env.example` | Corrida de refresh, fatais, 401, IDOR. `feat(db)`, `feat(api)`, `feat(llm)`. |
| **P3 Catálogo por provedor** | P3.1–P3.5 | GPT/Codex | `apps/api/src/routes/{models,providers,bots,runs}.ts`, `apps/worker/src/openrouter-models.ts`, `packages/shared` | Cache por usuário, capacidades, validação. `feat(shared)`, `feat(api)`. |
| **P4 Roteamento, fallback e telemetria** | P4.1–P4.8 | GPT/Codex | worker (agent-run, routine, summary, memory-review), `agent-runtime/{telemetry,tools/delegate-task,budget}`, `llm/provider-router.ts`, `db` | Fallback, cooldown, manutenção no OpenRouter, telemetria, rotina opt-in. `feat(agent)`, `feat(routines)`, `fix(worker)`. |
| **P5 UI** | P5.1–P5.6 | GPT/Codex | `apps/web/components/{model-picker,ai-elements/model-selector}*`, configurações/Marketplace, `lib/atlas-api.ts`, `hooks/use-atlas-chat.ts` | Seletor, conexão, "plano". `feat(web)`. |
| **P6 Replay e checklist** | P6.1–P6.6 + checklist | GPT/Codex | testes e fixtures; `PLANO-PROVEDORES/REVIEW.md` | Replay do loop, regressão OpenRouter, checklist manual registrado. `test(agent)`, `docs(plano)`. |

**Dependências:** P1 e P2 são independentes entre si (o adaptador recebe `getAccessToken` por injeção). P3 depende de P1 (contrato de referência) e P2 (token). P4 depende de P1, P2 e P3. P5 depende de P3 (contrato do catálogo) e usa o estado de P2/P4 (pode começar com API mockada). P6 fecha depois de P1–P5 (os testes unitários de cada fase vão no commit da fase; P6 reúne replay e checklist).
**Ordem:** P1 e P2 em paralelo -> P3 -> P4 -> P5 -> P6.
**Coordenação com a rodada de desempenho:** `packages/llm/src/chat-tools.ts`, `prompt-cache.ts`, `computer-use.ts` e `hygiene.ts` também são tocados por F3/F3b/F6 (#14, #17). O adaptador vive em arquivos novos; tocar nesses só no mínimo e fazer rebase antes de commitar. Registrar conflito em `REVIEW.md`.

---

## Verificação
- Suítes: `pnpm --filter @workspace/shared test`, `@workspace/llm test`, `@workspace/agent-runtime test`, `@workspace/db test`, API e worker (`NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`), `pnpm exec turbo typecheck`. Mudou `shared`/`db`/`llm`: `pnpm exec tsc` no pacote antes dos testes de api/worker (usam `dist/`).
- Regra de teste: nada de rede real, OpenAI nem OpenRouter; datas com `now` injetado.
- Regressões obrigatórias:
  - caminho OpenRouter idêntico (ids antigos, fallbacks, cache breakpoints);
  - o loop do agente não importa nada de `chatgpt`;
  - cancelamento durante chamada, stream e backoff do ChatGPT em até 2 s;
  - nenhum token em log, evento, erro ou fixture (`rg "eyJ|Bearer "` nas fixtures e nos snapshots).

## Riscos
| Risco | Mitigação |
|---|---|
| **API em preview** muda campos, eventos, erros ou some. | Adaptador isolado em `llm/responses/**`; parser tolerante a campos novos; erros desconhecidos viram falha amigável com fallback; flag desliga tudo sem migração destrutiva. |
| **Refresh de 30 dias:** sem uso por 30 dias, o refresh expira. | Status `needs_login` com aviso claro na UI; relogin em um clique. Sem renovação "de manutenção" automática. |
| **Refresh rotativo e concorrência** (API + worker): `refresh_token_reused` é fatal. | Lock Postgres + releitura + single-flight (P2.3); teste de corrida; perda de token por falha entre resposta e commit -> `needs_login`. |
| **Cota do plano não documentada** (sem headers, sem custo, reset desconhecido). | Cooldown configurável após 429, fallback OpenRouter, contador `planCalls`, custo exibido como "plano". **(hipótese)** janela de reset. |
| **Uso pessoal apenas:** app pago/hospedado/multiusuário precisa da waitlist. | Flag off por padrão, só o dono (`ATLAS_OWNER_EMAIL`), aviso na UI, fora de escopo explícito. Login só com navegador na mesma máquina da API. |
| **Parâmetros ausentes:** sem `max_output_tokens`, o orçamento de saída (L22) não se aplica; sem `temperature`. | `appliedOutputCap:false`; orçamento checado após a chamada; uma chamada pode ultrapassar o saldo; documentado e testado (P4.8). |
| **Itens `reasoning` aumentam o histórico** e o custo de contexto. | Reinjetar só no mesmo provedor/modelo; compactação os descarta junto com as mensagens; medir se descartá-los é aceitável **(hipótese)**; contar `reasoningTokens` na telemetria. |
| Callback loopback em Docker/VM. | Publicar só em `127.0.0.1`; documentar; fluxo remoto fora de escopo. |
| Callback sem sessão (host `127.0.0.1` ≠ `localhost`). | `state` de uso único em hash + PKCE + TTL + vínculo ao `userId`; só a rota `/callback` no listener dedicado. |
| Colisão do prefixo `chatgpt/` com vendor do OpenRouter. | **(hipótese)** não existe; teste contra o catálogo real; fallback `chatgpt:`. |
| Vazamento de token em log/erro. | `redactSecrets` em todo erro da OpenAI; testes de captura de log; cofre AES-GCM. |

## Decisões do usuário (04/10/2026)
1. **Conectar ChatGPT:** o botão fica em **Configurações → Provedores**, seção nova e separada do Marketplace de MCP (P5.3).
2. **Rotinas:** usam o **OpenRouter por padrão**. Usar o plano ChatGPT é opt-in por rotina (P4.6).
3. **Subagentes (`delegate_task`):** **herdam o provedor do run**. Run no ChatGPT, filhos também (P4.7).
4. **Limite do plano (429 `subscription_sharing_usage_limit_exceeded`):** fallback **ligado por padrão** para `deepseek/deepseek-v4.1-flash` no OpenRouter, configurável por bot, com aviso visível na UI (P4.2, P5.4).
5. **Busca do seletor:** mostra resultados **planos entre provedores** enquanto houver texto (P5.1).
6. **`ATLAS_SIWC_CALLBACK_PORT`:** padrão fixo **53682**, documentado como configurável nos `.env.example` (P2.8).
