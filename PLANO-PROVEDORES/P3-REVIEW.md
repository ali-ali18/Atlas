# P3 — catálogo por provedor

Base inicial: `4fe6e44`, branch `agente-v3/gpt-p3`. P1/P2 serão incorporadas como pré-requisitos locais antes da validação e entrega; sem merge na base e sem push.

## Coordenação antes de alterar código

- `packages/shared/src/model.ts`: preservar o tipo legado, acrescentar contrato do catálogo por provedor e vendor separado; o web continua podendo agrupar vendors do OpenRouter.
- `apps/api/src/routes/models.ts`: conservar catálogo público, single-flight, stale e cooldown. Novo catálogo ChatGPT será isolado por dono e registro da conta, sem tokens em resposta/cache público.
- `apps/api/src/routes/providers.ts`: estender apenas a factory da P2 com a rota de catálogo autenticada. Flag off e usuário fora do dono recebem 404.
- `apps/api/src/routes/bots.ts`: validação de referência ChatGPT sem bloquear seleção OpenRouter legada.
- `apps/api/src/routes/runs.ts`: Sonnet F4 é o dono concorrente; tocar apenas a validação do modelo resolvido antes de criar/enfileirar o run, sem alterar pause/resume, controls ou stream.
- `apps/worker/src/openrouter-models.ts`: preservar exports legados. Catálogo ChatGPT autenticado separado, sem fetch público com ids ChatGPT.

## Hipóteses e fontes

Catálogo público OpenRouter consultado sem credenciais em 04/10/2026: 466 modelos, nenhum prefixo `chatgpt/`.

SIWC usa slugs retornados pelo catálogo da própria conta. Sem flags de capacidade ou janela de contexto, registrar unknown e não deduzir por nome. Referência: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference . O cache de prompt estável não foi medido; não ativar por hipótese. Nenhuma inferência paga ou login será executado pelos testes.

## Validação

Pendente implementação e execução dos testes. Nenhuma migration aplicada ao banco real.

- Integração mínima adicional: `packages/llm/src/provider-model-catalog.ts` novo, com cache por dono/registro e transporte/token injetados, compartilhado por API e worker. Evita duplicar fetch/autorização e não importa db. Export mínimo no índice llm. Parser puro de catálogo ChatGPT em shared.

## Integração e impedimentos da revisão automática

Contrato/cache inicial: `92b4f97` (shared 399 passed, LLM 98 passed na execução de 04/10; depois incorporadas correções P1/P2). API: 135 passed, 0 fail, 0 skipped, duration_ms 5791.5029. Turbo typecheck: 12 successful / 12 total, 9 cached, 13.806s. Teste API preexistente github.test.ts exige ATLAS_OWNER_EMAIL e BETTER_AUTH_SECRET antes do import: executado com owner@example.com e segredo sintético além de NODE_ENV=test/ATLAS_HOOK_PEPPER=test-pepper. Sem essas variáveis falha antes dos testes; nenhum banco/rede real.

A revisão automática recusou o comando que tocaria routes/runs.ts, área da F4/Sonnet, embora P3.4 preveja esse delta no plano. Nenhuma alteração foi aplicada em runs.ts. Autorização explícita pedida ao usuário; até chegar, criação de run ainda requer chave OpenRouter e não valida modelo ChatGPT. Hunk necessário: validar modelo após resolveRunModel (antes de efeitos), condicionar a exigência da chave ao provedor OpenRouter, só criar Jev quando chave disponível e devolver warning se catálogo indisponível. Não marcar P3 completa ainda.

Rotas de catálogo e gravação do bot usam somente userId da sessão. PATCH verifica ownerId antes do catálogo. Bot criado/atualizado pode devolver warnings sem alterar o id legado. ListModelsResponse agora contém ProviderModel[], com provider canônico e vendor separado. Cache privado rejeita redirects e não retorna nem registra tokens.

LLM após integração dos fixes P1 e redirect:error no catálogo: 19 arquivos, 105 passed, duração 1.83s. Delta bot fallback: 4 pass, 0 fail, duration_ms 3544.394. Commits P3: 92b4f97 contrato/cache, afdeae2 catálogo/API/validação bot, 192365d fallback somente OpenRouter. Integração worker do catálogo/contexto/capacidade segue junto da P4 para manter uma factory única.

## Delta autorizado de criação do run

Autorização explícita do usuário em 04/10/2026: delta mínimo em routes/runs.ts. Branch conferida e rebase sobre rodada/desempenho (9a5f0eb) antes da alteração: já atualizada, nenhum commit revisado reescrito. Validação do modelo resolvido antes de efeitos, catálogo ChatGPT confirmado obrigatório na criação, chave OpenRouter somente no ramo OpenRouter, Jev opcional sem chave. Questionário resolve/valida uma vez antes de alterar o card. Demais controles, limites S2, pause retrying 409 e eventos paused preservados. Factory recebe apenas validador opcional para testes HTTP sem rede/cofre real.

Verificação do delta: HTTP novo 6 passed, 0 fail, 0 skipped, duration_ms 4120.5147. API completa 141 passed, 0 fail, 0 skipped, duration_ms 7092.5055. pnpm exec turbo typecheck: 12 successful / 12 total, 3 cached, Time 42.726s. Ambiente sintético NODE_ENV=test, ATLAS_HOOK_PEPPER=test-pepper, ATLAS_OWNER_EMAIL=owner@example.com e BETTER_AUTH_SECRET de teste; nenhuma rede ou banco real. Delta autorizado aplicado, impedimento histórico de runs.ts resolvido. Sem push/merge/migration.
