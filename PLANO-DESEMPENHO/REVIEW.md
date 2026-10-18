# Revisão F1 — segurança e limites de entrada

## Entrega atualizada sobre F0 (02/10/2026)

- Issue: #11, parte do mapa #9. Implementação de S1, S2 e S3; plano congelado preservado.
- Worktree de entrega: `C:/Dev/Personal/atlas-gpt-f1`; branch `agente-v3/gpt-f1`.
- Base: `b7c7fd5` de `rodada/desempenho`, contendo F0 (`2ab43c9`). Os commits anteriores foram reaplicados na nova branch; `git rebase rodada/desempenho` confirmou que a branch está atualizada. As worktrees anteriores não foram alteradas.
- A região `isRealStepRetry`/`appendAgentStep` é idêntica à base. No processor do worker a única alteração F1 é passar `runUserId` ao manager. A revisão cruzada confirmou a preservação de F0.
- Sem push, merge na base, migration ou mudança de schema. O cliente Prisma foi gerado apenas para build/testes.

## Escopo e posse dos arquivos

- DB: criação, consultas de posse, colisão/inputs de runs, conversas e conectores. Nada na gravação de passos F0.
- API: compat/modern runs, guards de entrada, middleware JSON e rotas sandbox. O escopo vem da sessão, sem identidade de dono enviada pelo cliente.
- Sandbox: manager, session-store, labels Docker e volume de perfil separados por dono. Metadata permite conferir posse entre processos sem iniciar/criar container.
- Adaptações mínimas de contrato S3 em `apps/worker/src/processors/agent-run.ts` e `apps/worker/src/sandbox.ts`: factory exige dono explícito. Sem mudança de lifecycle ou telemetria.
- `apps/api/src/index.ts`: somente import/registro do limite JSON antes das rotas; sem alteração do claim de legado existente.
- `packages/db/src/summaries.test.ts`: inclui `file`, já presente na implementação da base; ajuste de expectativa antiga, sem mudança de produção.
- Teste de sandbox ampliado na nova branch para verificar B→A também em `screen`, `navigate`, `type`, `key` e `scroll`, além de viewer, screenshot, click e delete. Todos passam pelo guard comum e retornam 404 antes de efeitos.

## Comportamento entregue

- Runs compat/modern usam o dono da sessão. Bot/conversa/sandbox são validados antes de efeitos. O loop observa somente o run do dono; disconnect encerra observação, não cancela a tarefa. `paused` encerra SSE.
- JSON: teto de 1 MiB (inclusive chunked e tamanho declarado menor); até 200 mensagens e 64 Ki caracteres por mensagem/entrada; `maxSteps` inteiro entre 1 e 100. Modo desconhecido → 400; body acima do teto → 413.
- Upload multipart preserva 10 MiB mais envelope; teste de transporte com imagem de 9 MiB aprovado. Webhooks mantêm política própria.
- Legado não reivindicado é invisível. O claim seguro existente é preservado; não há segundo claim nem compartilhamento automático de `default`.
- Inputs de run próprio validam bot/conversa sem exigir existência da sandbox antiga, permitindo a recuperação pelo worker; criação continua validando sandbox informada. Novo teste cobre steer/queue/cancel após remoção e B bloqueado.

## Verificação na nova worktree, após integrar F0

- API: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"` em `apps/api`: 123 testes, 123 aprovados, 0 falhas, 0 skips; duration_ms 7591.1213. Também foram fornecidos `ATLAS_OWNER_EMAIL` e `BETTER_AUTH_SECRET` sintéticos, necessários ao boot da suíte GitHub, sem credenciais reais.
- Shared: `pnpm --filter @workspace/shared test`: 31 arquivos, 382 testes aprovados; duração 2.42s.
- Typecheck completo: `pnpm exec turbo typecheck`: 12 successful, 12 total; 7 cached; 45.263s.
- DB: 37 testes aprovados, 0 falhas/skips; inclui os testes F0 de retries, durationMs e costUsd.
- Sandbox: 3 arquivos, 12 testes aprovados.
- Worker: 37 testes aprovados, 0 falhas/skips; inclui os seis testes de telemetria F0.
- Build das dependências: 8 successful, 8 total; 2 cached; 27.825s.
- Revisão cruzada de DB/sandbox/MCP e API não encontrou outro bloqueador de posse após corrigir inputs com sessão removida. Rotas MCP autenticadas passam o dono nas atualizações/exclusões.

## Limitações e revisão

- Testes simulam duas contas; autenticação de produção continua limitada ao owner configurado. Não foi exercitado banco PostgreSQL realmente migrado/FKs, Docker real ou modelo pago. O claim foi testado com Prisma dublado.
- Sessões/volumes antigos sem identificação de dono não são adotados nem apagados; exigem nova sessão/login nos sites.
- VNC direto permanece em loopback; não foi implementado gateway autenticado. Reaper distribuído, storage/Chromium/readiness pertencem a D7; atomicidade/leases do ciclo de runs pertencem a F2.
- Esta entrega não demonstra ganho de latência; F1 corrige segurança e entrada. Benchmarks de desempenho pertencem a F10.
- Claude revisa e integra. Nenhum merge, push ou fechamento da issue foi realizado pelo GPT.

# F3 — coordenação (02/10/2026)

- Usuário autorizou F3; Claude possui F2. Base local 405fe74 com F0/F1, branch agente-v3/gpt-f3 e worktree atlas-gpt-f3. Plano congelado intocado; sem push/merge/migration.
- Subagentes: LLM L8/L22; runtime L1/L2 e adapters de deadline; sandbox sinal/deadline. Root: A3 catálogo, L11 manutenção, U2 geração de imagem e integração.
- Root cria packages/llm/src/model-catalog-cache.ts e teste/export como módulo I/O reutilizável para API/worker; restante llm pertence ao subagente.
- apps/worker/src/config.ts: só maintenanceModel opcional vindo de ATLAS_MAINTENANCE_MODEL, fallback summarizerModel. packages/shared/src/chat-jobs.ts: só ledger opcional do resultado de manutenção (sem DB/schema) para conservar modelo/tokens/custo separado do run principal.
- apps/worker/src/processors/memory-review.ts é compartilhado com F2: F3 altera apenas escolha do modelo, deps testáveis e acumulação/retorno do ledger. O ramo add/remove (W7) permanece com Claude. Rebase/revisão final deve preservar o fix F2.
- Campos opcionais de checkpoint para referências de leituras são alteração mínima de contrato se o runtime exigir; journal/leases/gravação de passos F2 não serão alterados.
- .env.example e apps/worker/.env.example: somente documentar configurações novas sem valores reais; README local de testes/limitações será atualizado no fechamento.
- Adapter L8 em apps/worker/src/processors/agent-run.ts: callback getSessionId recebe contexto opcional e usa manager escopado na resolução/inspeção. Sem mudanças em lease/journal/lifecycle F2; necessário para interromper readiness após cancelamento.


## F3 — entrega para revisão (02/10/2026)

Branch: `agente-v3/gpt-f3`. Worktree: `C:/Dev/Personal/atlas-gpt-f3`.
Rebase concluído sobre `a551a09`; `mcp/call.ts` e o corpo de
`executeMemoryTool` permanecem exatamente como na base. Plano congelado
intocado, sem migration, push ou merge. Claude revisa e integra.

### Comportamento entregue

- L1: cache de leituras bem-sucedidas por runtime/dono no `callRecord`,
  TTL de 30s, single-flight e invalidação por qualquer tentativa de escrita.
  Escritas sempre executam individualmente. O loop entrega stub com
  `result_ref`; `read_cached_result` recupera o resultado durável do próprio
  run. `runtime_refresh: true` permite polling e não vai ao conector.
  Resultados com imagens não são cacheados. Duas buscas vazias consecutivas
  deixam orientação persistida para prosseguir com as tools carregadas.
- L2: até três leituras MCP independentes em paralelo. Escritas, navegador,
  duplicatas e argumentos com referências formam barreiras. Resultados
  persistidos por item antes de concluir o lote; retomada usa mensagens e
  resultados duráveis e executa somente as faltantes. Checkpoints são
  serializados; transporte final conserva a ordem das chamadas.
- L8: 90s totais por decisão, incluindo POST, body, stream e até duas
  requisições. Primeiro evento útil em 30s e inatividade em 20s; configuração
  positiva validada. Retry de stream somente antes de publicar texto;
  erros permanentes e cancelamento não retentam. Backoff interrompível.
  Tempo restante do run chega à decisão, inicialização e ações do sandbox.
  HTTP recebe signal; render de PDF encerra Chromium e impede artefato
  tardio após cancelamento.
- L11: revisão de memória usa `ATLAS_MAINTENANCE_MODEL` ou
  `summarizerModel`, sem herdar o modelo caro do bot. Ledger de manutenção
  (modelo, chamadas, tokens, custo informado) fica no resultado do job,
  separado do uso do run principal. Sem inventar custo ausente.
- L22: saída por decisão configurável (padrão 4096 tokens), limitada também
  pelo saldo do run. Reasoning opcional e validado abaixo do teto de saída;
  sem desativação indiscriminada. `parallel_tool_calls: true`.
- A3: API e worker compartilham suas consultas em andamento, preservam
  catálogo válido em falhas e usam cooldown de 30s. API mantém 502 se ainda
  não houver catálogo; contexto/visão do worker usam o mesmo cache.
- U2: ferramenta descreve somente criação de imagem nova; parâmetro de
  referência removido e legado rejeitado antes de chamar o provedor.

### Verificações (output real)

```text
API: NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"
tests 125 | pass 125 | fail 0 | skipped 0 | duration_ms 6353.5826
Worker: NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"
tests 59 | pass 59 | fail 0 | skipped 0 | duration_ms 5168.6019
pnpm --filter @workspace/shared test
Test Files 31 passed | Tests 382 passed | Duration 1.30s
pnpm --filter @workspace/llm test
Test Files 10 passed | Tests 50 passed | Duration 1.98s
pnpm --filter @workspace/sandbox test
Test Files 4 passed | Tests 14 passed | Duration 568ms
pnpm --filter @workspace/agent-runtime test
Test Files 66 passed, 1 skipped | Tests 668 passed, 10 skipped | Duration 7.30s
pnpm exec turbo typecheck
Tasks: 12 successful, 12 total | Cached: 7 cached | Time: 20.332s
Build das dependências do runtime/queue/mail
Tasks: 8 successful, 8 total | Cached: 4 cached | Time: 18.056s
git diff --check: sem erros
```

API também recebeu ATLAS_OWNER_EMAIL e BETTER_AUTH_SECRET sintéticos,
necessários ao boot dos testes. Nenhuma credencial real. Regressões novas
exercitam TTL, refresh, escrita, cache entre instâncias, referência B≠A,
concorrência máxima, ordem, barreiras, resultado individual/replay, buscas
vazias, cancelamento em init/render/HTTP/backoff, retries de stream,
prazo absoluto, orçamento, catálogo nos dois processos e manutenção.

### Limitações e itens fora desta entrega

- Os dez testes de integração do runtime dependem de banco e permanecem
  pulados. Não foi exercitado Docker real, Chromium real ou modelo pago.
  Não há afirmação de redução percentual de latência nem de qualidade
  equivalente entre modelos: comparação controlada pertence à F10.
- Os subagentes iniciaram a exploração, mas esgotaram o limite da conta;
  root integrou os arquivos parciais, implementou o restante e revisou.
  Esta entrega não alega revisão cruzada concluída.
- SDK externo não cooperativo pode terminar após timeout. O runtime
  observa interrupção, interrompe transportes cooperativos e não segue
  para a próxima ação; não afirma que efeitos externos foram desfeitos.
- L1 confia no contrato readOnly do catálogo autorizado. Referências
  usam o replay do run já escopado pelo worker. Se um filtro de subagente
  proibir read_cached_result, o loop não emite stubs inacessíveis; o cache
  de transporte ainda pode evitar chamadas repetidas.
- Download→imagem→PDF com imagem embutida, infraestrutura, reaper e storage
  completos pertencem à F5. Esta fase cobre cancelamento do render existente.
  Compactação por artefatos/prefixo estável pertence à F6.
- Journal/leases/outcome_unknown da F2/F2b não foram alterados. Em
  agent-run.ts há apenas adapter de contexto em inspeção/resolução do
  sandbox, com deadline do run e signal, preservando guards/lease/eventos.

### Commits de implementação

```text
04a4fcf perf(llm): compartilhe consultas ao catálogo com stale e cooldown
44dd139 perf(worker): use modelo independente na revisão de memória
87cdbbe fix(agent): retire promessa de edição de imagens por referência
a41ebe8 fix(llm): torne retries e leitura do stream canceláveis
77b7b2d fix(llm): limite decisões por prazo total e orçamento de geração
0c17f13 fix(sandbox): respeite cancelamento e prazo na inicialização e ações
c41582e fix(files): interrompa render de PDF quando a tarefa for cancelada
45fb166 perf(mcp): reutilize leituras com TTL e invalidação por escrita
1e92b5c perf(agent): execute leituras independentes em paralelo e reutilize resultados
cc48cee docs(plano): registre configuração e posse da F3
```

### Arquivos tocados

```text
.env.example
PLANO-DESEMPENHO/REVIEW.md
apps/api/src/routes/models.test.ts
apps/api/src/routes/models.ts
apps/worker/.env.example
apps/worker/src/config.ts
apps/worker/src/openrouter-models.test.ts
apps/worker/src/openrouter-models.ts
apps/worker/src/processors/agent-run.ts
apps/worker/src/processors/memory-review.model.test.ts
apps/worker/src/processors/memory-review.ts
packages/agent-runtime/src/computer-use.autonomy.test.ts
packages/agent-runtime/src/computer-use.reads.test.ts
packages/agent-runtime/src/computer-use.subagent-origin.test.ts
packages/agent-runtime/src/computer-use.test.ts
packages/agent-runtime/src/computer-use.ts
packages/agent-runtime/src/files/pdf-chromium.ts
packages/agent-runtime/src/files/pdf.ts
packages/agent-runtime/src/mcp/read-cache.test.ts
packages/agent-runtime/src/mcp/read-cache.ts
packages/agent-runtime/src/mcp/runtime.ts
packages/agent-runtime/src/read-execution.test.ts
packages/agent-runtime/src/read-execution.ts
packages/agent-runtime/src/tools/create-file.test.ts
packages/agent-runtime/src/tools/create-file.ts
packages/agent-runtime/src/tools/generate-image.test.ts
packages/agent-runtime/src/tools/generate-image.ts
packages/llm/src/chat-tools.fallback.test.ts
packages/llm/src/chat-tools.ts
packages/llm/src/config.ts
packages/llm/src/decision-budget.test.ts
packages/llm/src/decision-budget.ts
packages/llm/src/index.ts
packages/llm/src/model-catalog-cache.test.ts
packages/llm/src/model-catalog-cache.ts
packages/llm/src/retry-policy.test.ts
packages/llm/src/sse-stream.ts
packages/llm/src/timing.test.ts
packages/sandbox/src/control-client.ts
packages/sandbox/src/docker-manager.ts
packages/sandbox/src/execution-context.test.ts
packages/sandbox/src/execution-context.ts
packages/sandbox/src/index.ts
packages/shared/src/chat-jobs.ts
```


## F3 — revisão solicitada em 03/10/2026

Base revisada 26a1776 preservada. Apenas commits novos, sem push/merge.
B1/N1/N3/N4/N5 e opcionais N2/N6/N7 autorizados pelo revisor.
shared/run-telemetry.ts: somente comentários de toolMsTotal/overheadMs
para documentar tempo de parede dos lotes, sem mudança de schema/F0.

### Resultado da correção

- B1: 180 s somente para sandbox/navegador; `create_file` mantém o teto próprio de 60 s. MCP, resultado em cache e delegação seguem sinal/deadline do run. O motivo original do aborto é propagado ao filho.
- Regressões B1: três filhos simulados executam por 200 s e concluem; cancelar o pai aborta todos e impede ações posteriores.
- N5/N4: 4096 deixa de ser teto global dos callers; o loop com `create_file` não recebe esse teto implícito. Argumento de 155.000 caracteres chega inteiro ao artefato. Configuração explícita e saldo continuam limitando saída; reasoning acompanha o saldo (64 → 32) e é omitido quando não cabe.
- N3: `No allowed providers` sem código no stream é definitivo, sem retry.
- N1: tempo de parede do lote, mantendo toolMs de cada leitura. N2: ask bloqueia paralelismo de confirmação. N6: contador reconstruído do histórico persistido, distinguindo busca vazia de ausência de ferramentas novas. N7: indentação uniforme nos dois blocos apontados.
- Replay temporal de lembretes: relógio fixo antes de 03/10, preservando as duas criações e os horários esperados; nenhum ajuste de produção para contornar o teste.

### Commits novos de código e testes

- `d98e11e fix(agent): preserve prazo e cancelamento dos subagentes`
- `269d30c fix(llm): não retente bloqueio de provedores permitidos`
- `8a676dd fix(llm): ajuste saída e reasoning ao orçamento do agente`
- `2f5803d fix(agent): meça parede dos lotes paralelos na telemetria`
- `766869b fix(agent): serialize leituras que exigem confirmação`
- `7344591 fix(agent): retome contagem de descobertas vazias do checkpoint`
- `02a6408 fix(agent): encaminhe sinal da operação à delegação`
- `72770c4 style(agent): padronize indentação dos blocos de leitura`
- `2230e35 test(agent): fixe relógio do replay de lembretes`

### Verificação repetida após as correções

Outputs reais da última execução:

| Suíte | Resultado | Duração |
| --- | --- | --- |
| API (`NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`) | tests 125; pass 125; fail 0; skipped 0 | 7864.5179 ms |
| worker (mesmo ambiente sintético de testes) | tests 59; pass 59; fail 0; skipped 0 | 2939.6634 ms |
| agent-runtime | Test Files 67 passed / 1 skipped (68); Tests 678 passed / 10 skipped (688) | 6.85 s |
| llm | Test Files 12 passed (12); Tests 54 passed (54) | 1.80 s |
| shared | Test Files 31 passed (31); Tests 382 passed (382) | 1.33 s |
| sandbox | Test Files 4 passed (4); Tests 15 passed (15) | 760 ms |
| `pnpm exec turbo typecheck` | Tasks: 12 successful, 12 total; Cached: 7 cached | 23.236 s |

As dez integrações puladas pelo runtime mantêm as condições existentes de ambiente. Não foi medido desempenho com provedor pago/sandbox real nesta revisão. As regressões de cancelamento, duração, stream longo e paralelismo usam relógio/transportes simulados. A última suíte completa está verde; a execução inicial do worker sem `ATLAS_HOOK_PEPPER` falhou na inicialização e foi repetida com o ambiente correto. O sandbox foi reconstruído para que o runtime testasse o dist atualizado.

Sem migração, push ou merge. Branch local `agente-v3/gpt-f3`, worktree `C:/Dev/Personal/atlas-gpt-f3`. Base revisada `26a1776` preservada como ancestral; o plano congelado não foi editado. Revisão e merge ficam com Claude/usuário.
