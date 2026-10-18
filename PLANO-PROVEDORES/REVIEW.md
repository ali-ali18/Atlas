# Provedores — entrega integrada para revisão

## Estado

**Deltas autorizados concluídos e verificados.** Checkpoint preserva o histórico opcional Responses com parse tolerante; criação de runs valida conexão/modelo do próprio dono antes de efeitos; Responses fornece finishReason explícito. A rejeição de aprovação anterior foi resolvida pela autorização do usuário. Código integrado para revisão, mantendo flag desligada e migrations NÃO aplicadas. Ver resultados finais abaixo; as seções de entrega inicial são histórico da rodada anterior.

Base: `rodada/desempenho` em `9a5f0eb`. Todas as fases foram rebased sobre essa base. Integração linear em `agente-v3/gpt-p6`, worktree `C:/Dev/Personal/atlas-gpt-p6`, sem merge na base nem push. Heads das fases antes deste relatório:

| Fase | Branch | Head |
|---|---|---|
| P1 | agente-v3/gpt-p1 | 354618d |
| P2 | agente-v3/gpt-p2 | d6fb58f |
| P3 | agente-v3/gpt-p3 | 6023f5f |
| P4 | agente-v3/gpt-p4 | 57b3453 |
| P5 | agente-v3/gpt-p5 | ef5d932 |
| P6 integrada | agente-v3/gpt-p6 | 3ae81cd |

A P6 inclui cópias locais dos pré-requisitos: não integrar também os mesmos patches das outras branches. Hashes nos relatórios iniciais são históricos, anteriores ao rebase. A base permaneceu intacta; arquivos locais preexistentes excluídos do escopo não foram alterados.

Relatórios: [P1](P1-REVIEW.md), [P2](P2-REVIEW.md), [P3](P3-REVIEW.md), [P4](P4-REVIEW.md), [P5](P5-REVIEW.md). Este relatório prevalece para resultados da integração, capacidades desconhecidas e estado de entrega. O plano congelado não foi editado.

## Resultado implementado

Adaptador Responses separado, autenticação SIWC oficial com PKCE/nonce, cofre, refresh rotativo protegido entre processos, catálogo privado por dono, roteamento por provedor, fallback antes de texto, cooldown persistente, custo do plano separado de USD, opt-in explícito de rotina e seletor/configurações na UI. Flag desligada por padrão, owner-only. Nenhum token/cliente do Codex CLI reutilizado; assinatura Anthropic fora de escopo.

Rebase preservou finishReason/journal da F2b e modelo servido da F4. Fix `354618d` na P1 fornece finishReason para Responses concluído. A P6 acrescenta replay integrado com imagem, duas tools, reasoning, usage; quota na segunda decisão com fallback sem histórico opaco e aviso único; cancelamento do pai sem tools nem fallback pago. Commits próprios: `48ee936` e `282024f`.

## Registro histórico dos deltas antes da autorização — agora aplicados

### 1. Checkpoint: P1 / posse F2b

Arquivos: `packages/shared/src/runs.ts`, `packages/agent-runtime/src/checkpoint.ts` e teste correspondente. Revisão automática rejeitou por posse concorrente do Sonnet e falta de autorização explícita para essa área.

Adicionar ao tipo SerializedLlmMessage:

```ts
providerItems?: {
  provider: "chatgpt";
  model: string;
  items: Record<string, unknown>[];
};
```

Em serializeLlmMessages e nos dois objetos de hydrateLlmMessages, copiar o campo opcional junto dos demais metadados:

```ts
...(message.providerItems ? { providerItems: message.providerItems } : {}),
```

Preservar integralmente journal/checkpoint da F2b. Testar serialize → JSON roundtrip → hydrate → resolve → Responses com content null e array, reasoning + call/output preservados no mesmo modelo e removidos na troca. Até aplicar, retomada perde itens opacos, embora decisões em memória preservem os itens.

### 2. Criação de runs: P3 / posse F4

Arquivo: `apps/api/src/routes/runs.ts` e teste de rota. Revisão automática rejeitou o hunk por posse concorrente do Sonnet/F4. Até aplicar, ambas as rotas exigem OPENROUTER_API_KEY antes de resolver o modelo e não validam o modelo ChatGPT na API.

Delta de revisão, restrito a POST /v1/runs e POST /v1/questionnaire/submit:

1. Importar parseModelRef de shared e validateProviderModel de `../providers/model-catalog.js`.
2. Retirar a checagem global antecipada da chave. Após posse das referências e resolveRunModel, validar o modelo pelo userId da sessão, antes de efeitos; devolver o erro/status seguro do validador (400/404/503) e conservar warnings de catálogo indisponível.
3. Exigir chave somente quando parseModelRef(model).provider for openrouter. Jev é opcional: somente construir buildJevIntent se a chave existir.
4. No questionário, resolver/validar o modelo ANTES de submitQuestionnaireCard; reutilizar o modelo ao criar o run. Não marcar card respondido quando a validação falhar.
5. Incluir warnings quando houver no resultado. Não alterar pause/resume, controles, stream, reconexão ou nota A7.
6. Testar: ChatGPT conectado sem chave OR cria run; OpenRouter sem chave recebe 503; slug inválido recebe 400; B≠A recebe 404 antes de efeitos; feature desligada/desconectada falha sem criar run/responder card; catálogo indisponível devolve warning conforme contrato existente.

O validador, worker e UI já estão disponíveis para esse delta. Nenhum comando rejeitado foi contornado. É necessário autorizar GPT nesses hunks ou o Sonnet aplicar o delta, então integrar e repetir testes afetados.

## Verificação integrada real — 04/10/2026

| Suíte | Resultado | Duração |
|---|---|---|
| shared | 419 passed | 4.21 s |
| llm | 114 passed | 2.31 s |
| agent-runtime | 821 passed, 10 skipped existentes | 11.66 s |
| API | 137 pass, 0 fail, 0 skip | 7722.79 ms |
| worker | 75 pass, 0 fail, 0 skip | 4540.5119 ms |
| DB | 74 pass, 0 fail, 0 skip | 885.7974 ms |
| web completa | 56 pass, 0 fail, 0 skip | 1852.7988 ms |
| turbo typecheck final | 12 successful / 12 total, 8 cached | 13.768 s |

Total: **1696 testes passaram, 10 pulados**. Builds de dependências: 8 successful / 8 total, 7 cached, 6.283 s. git diff --check sem erro; busca por eyJ/Bearer nas fixtures Responses: zero ocorrências.

Comandos: pnpm --filter @workspace/shared test; pnpm --filter @workspace/llm test; pnpm --filter @workspace/agent-runtime test; em API/worker, pnpm exec tsx --test "src/**/*.test.ts"; em API, pnpm exec tsx --test "../../packages/db/src/*.test.ts"; web via pnpm --filter api exec tsx --tsconfig ../web/tsconfig.json --test "../../apps/web/**/*.test.ts" "../../apps/web/**/*.test.tsx"; pnpm exec turbo typecheck.

API/worker/DB com NODE_ENV=test e ATLAS_HOOK_PEPPER=test-pepper. API completa também precisa ATLAS_OWNER_EMAIL=owner@example.com e BETTER_AUTH_SECRET sintético pelo import de auth no teste GitHub existente: tentativa sem esses valores falhou antes dos testes; reexecução com fixtures passou. DB mockado; integrações reais existentes ficaram puladas. Testes sem rede, login ou inferência pagos. Logs GitHub existentes capturam ausência de DATABASE_URL; não houve acesso a banco real.

## Migrations — NÃO aplicadas

- packages/db/prisma/migrations/20261004160000_provider_connections/migration.sql
- packages/db/prisma/migrations/20261004170000_routine_plan_opt_in/migration.sql

Somente schema/cliente Prisma locais gerados. Claude faz backup e aplica após revisão. Não habilitar flag antes das migrations e dos deltas pendentes.

## Checklist manual e hipóteses restantes

- Consentimento/login real, refresh rotativo com dois processos/conexões PostgreSQL, callback TCP real e revogação remota: não executados.
- Run real maior que uma hora, retomada após troca de modelo, cenário de quota e layout/foco responsivo: não executados. Retomada depende do delta de checkpoint.
- Custo/usage do plano é medido sem inventar USD zero; reset real da quota ainda desconhecido. Cooldown padrão 15 min configurável.
- Contexto desconhecido usa orçamento conservador 64000 configurável. Capacidade desconhecida permite tentativa; vision:false explícito bloqueia. Sem inferir pelo nome.
- Cache de prompt SIWC não medido; parâmetros sem validação do spike foram omitidos. Fixtures sintéticas no formato do spike não são captura de conta real.
- Referências oficiais: https://developers.openai.com/siwc/token-sharing-open-source/sign-in ; https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference ; https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions ; https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations . Nenhuma credencial existente foi lida.

Sem push, sem merge, sem migration no banco real. A entrega inicial era parcial; os deltas foram autorizados e concluídos na rodada abaixo.

## Rodada de deltas autorizada

Usuário autorizou explicitamente em 04/10/2026 os hunks mínimos de checkpoint/shared runs e routes/runs, com testes, sem alterar demais contratos. Todas as fases já tinham merge-base 9a5f0eb; rebase solicitado é no-op, sem reescrever commits revisados. Novos commits também ajustarão arquivos próprios Responses (sse.ts/stream.ts e testes) para mapear término real em finishReason: completed stop, limite length, recusa content_filter e interrupção incomplete. O histórico do relatório anterior permanece; resultados finais serão acrescentados após integração.

## Delta final autorizado — entrega 04/10/2026

Rebase PRIMEIRO confirmado em todas as branches P1→P6: base já era 9a5f0eb, todos os comandos deram up to date. Nenhum commit revisado foi reescrito. Base do usuário continua 9a5f0eb.

Commits NOVOS na P6 após 9837572 (pré-requisitos já revisáveis preservados):

| Commit integrado | Mensagem | Origem |
|---|---|---|
| 42a0b56 | fix(llm): informe término real das respostas do plano ChatGPT | P6 |
| 7b8605c | fix(llm): impeça execução de tools de Responses não concluído | P6 |
| 91c8ffa | fix(agent): preserve histórico Responses no checkpoint de retomada | P1 6932045 |
| dca1110 | fix(llm): compatibilize leitura Responses com tipos do worker | P6 |
| 25e6a2c | fix(api): valide provedor antes de criar runs e consumir questionários | P3 4f3c97e |

Todos têm testes no commit. O primeiro commit também padroniza os arquivos próprios Responses; os hunks de checkpoint/runs ficaram mínimos. Heads P1/P3 agora 6932045/4f3c97e; P2/P4/P5 não receberam novos deltas, seus heads históricos continuam válidos. A P6 contém os patches equivalentes: não integrar duas vezes.

### Comportamento e preservação

- Campo providerItems opcional em SerializedLlmMessage, serialização/parse/hidratação. Checkpoint antigo carrega; conteúdo inválido perde somente o campo opcional. Reasoning e pares call/output atravessam JSON e retomada; itens opacos não são reutilizados na troca de modelo. Não houve alteração de executionLedger, effects/results, taskState, capabilities, activeElapsedMs ou compact.
- Responses: completed → stop; incomplete por max_output_tokens → length; recusa → content_filter; EOF/erro de leitura antes de terminal → incomplete. Erros de provedor continuam seguros e cancelamento continua abortando. Tools de resposta limitada/recusada/interrompida não são entregues para execução. Não houve alteração no parser OpenRouter, regras L18/L19/L20 ou journal.
- POST /v1/runs e questionário validam o modelo resolvido pelo userId da sessão, ignorando userId no body/query. Sem conexão/modelo ausente recebe 400; catálogo inacessível recebe 409; B≠A/flag desligada recebem 404. Chave OR só é exigida no ramo OpenRouter (503); Jev opcional quando a chave existir. Questionário resolve/valida antes de consumir card. Nenhuma alteração de limites S2, pausa/retrying 409, evento paused, reconexão, nota A7 ou controles F4.

### Suítes finais integradas — outputs reais

| Suíte | Resultado | Duração |
|---|---|---|
| shared | 419 passed, 37 arquivos | 4.68 s |
| llm | 123 passed, 21 arquivos | 3.49 s |
| agent-runtime | 834 passed + 10 skipped, 89 arquivos passed + 1 skipped | 15.94 s |
| API | 143 pass, 0 fail, 0 skip | 8183.6464 ms |
| worker | 75 pass, 0 fail, 0 skip | 6701.0222 ms |
| DB | 74 pass, 0 fail, 0 skip | 963.0576 ms |
| web | 56 pass, 0 fail, 0 skip | 7901.8399 ms |
| turbo typecheck | 12 successful/12, 3 cached | 27.513 s |

Total **1724 passaram e 10 integrações existentes ficaram puladas**. Mesmos comandos/fixtures da verificação integrada acima; sem rede ou banco real. Novos testes HTTP cobrem B≠A e sem conexão; checkpoint cobre compatibilidade antiga e retomada; leitor cobre estados terminais e cancelamento. Build final dependências 8/8, 2 cached, 17.465 s. Primeiro build detectou tipo DOM indisponível no pacote DB; corrigido usando retorno do reader e reexecutado com sucesso. git diff --check limpo.

Não resta hunk bloqueado por aprovação. Permanecem somente verificações manuais descritas acima (OAuth real, múltiplas conexões PostgreSQL, run >1h e interação visual), revisão/merge pelo Claude e aplicação das duas migrations pelo usuário após backup. Nenhuma migration foi aplicada; sem push ou merge. Plano congelado intacto.
