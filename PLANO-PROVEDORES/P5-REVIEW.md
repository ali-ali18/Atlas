# P5 — UI de provedores

Branch `agente-v3/gpt-p5`, worktree `atlas-gpt-p5`, base `4fe6e44`.
Pré-requisitos P1 e P2 integrados por cherry-pick; nenhum merge na base.

## Posse compartilhada antes de editar
- `apps/web/components/ui/templates/template-4/chat-context-panel/agent-settings.tsx`: montagem da seção independente Provedores e campo de fallback do plano; preservar controles/settings F4.
- `apps/web/components/ui/templates/template-4/template-4-client.tsx`: somente listener que abre configurações e foca a seção Provedores quando solicitado pelo seletor.
- `apps/web/hooks/use-atlas-chat.ts`: apenas impedir fallback legado `/v1/chat` com IDs `chatgpt/*` quando a fila responde 503; sem alterar run pausado, reconexão, status ou modelo servido.
- `apps/web/components/ai-elements/model-selector.tsx`: aceitar props do Command para busca controlada; demais chamadas preservadas.

Guia Next lido na versão instalada: `next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` e início do guia de server/client components. Novos componentes interativos são client components; efeitos/browser APIs ficam no client.

Rotinas: somente editor/mapa/tipo da UI para opt-in allowChatgptPlan; sem schema. SSE: novo handler provider_fallback com aviso em mensagem sem alterar status/paused.

## Entrega após rebase
Base atual: `9a5f0eb` (`rodada/desempenho`). Rebase concluído; único conflito foi o destructuring de `streamStep` em `computer-use.ts`, resolvido preservando **finishReason** da F2b e **providerItems** da P1. Nenhuma lógica de checkpoint/runs foi modificada. Fix Responses `354618d` integrado como `34f87c9` (pré-requisito, não commit UI).

## Resultado
- Seletor: grupos por provedor fechados inicialmente, busca global plana, atual fixo no topo inclusive quando oculto/desconectado, recomendações somente existentes e vendors OpenRouter preservados.
- Configurações → Provedores: login SIWC em popup previamente aberto, retorno por query segura, status, desconexão confirmada, aviso de revogação não confirmada. Flag/owner 404/403 oculta a feature; 503 mostra indisponibilidade segura.
- Fallback do bot via policyJson: padrão OpenRouter, opção Parar e avisar, outros campos da política preservados.
- Rotinas: dropdown de opt-in explícito, desligado por padrão; autosave envia somente mudança da permissão quando isolada.
- Aviso provider_fallback consumido pelo cliente sem encerrar o run.
- Custo **plano** montado no footer real do ChatComposer junto da nota A7: uso medido de SSE done ou snapshots já obtidos. Modelo selecionado não inventa uso. Mistura preserva custo OR conhecido (inclusive zero real) ou desconhecido, mais plano. Nenhum polling extra.

## Commits próprios P5 para integração (ordem)
- `abd33a9` feat(web): consuma provedores com sessão e login SIWC em popup
- `37ffbfd` feat(web): agrupe modelos por provedor com busca global
- `07aac11` feat(web): configure conexão do plano e fallback do bot
- `b2e04a1` feat(web): permita opt-in de rotinas e avise fallback do plano
- `7b390b1` docs(provedores): registre escopo e posse da UI P5
- `ddbeccf` refactor(web): isole opções do seletor e teste estados do plano
- `eee5599` fix(web): preserve custo OpenRouter em uso misto do plano
- `d9de35c` fix(web): diferencie falha do provedor e retenha expansão da seção
- `9fc478c` fix(web): apresente opt-in da rotina em dropdown
- `01fc281` style(web): formate componentes próprios do seletor
- `331b494` style(web): formate componentes próprios de provedores
- `7ee46be` feat(web): exiba uso medido do plano no composer

## Verificação real
Comando de testes (via tsx já instalado na API, resolução de aliases da web):
```powershell
pnpm --filter api exec tsx --tsconfig ../web/tsconfig.json --test ../../apps/web/lib/provider-api.test.ts ../../apps/web/lib/provider-connect.test.ts ../../apps/web/lib/provider-model-picker.test.ts ../../apps/web/lib/provider-run-usage.test.ts ../../apps/web/components/model-picker/provider-model-list.test.tsx ../../apps/web/components/model-picker/provider-picker-options.test.tsx ../../apps/web/components/providers/provider-run-cost.test.tsx ../../apps/web/components/providers/providers-settings.test.tsx ../../apps/web/components/ui/templates/template-4/chat-context-panel/routine-provider.test.ts ../../apps/web/components/ui/templates/template-4/chat-thread/chat-composer-provider.test.tsx
```
Output final:
```text
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1856.4741
```
`pnpm exec turbo typecheck` final:
```text
Tasks: 12 successful, 12 total
Cached: 11 cached, 12 total
Time: 9.089s
```
Antes dessa rodada: typecheck completo após rebase também passou 12/12, 25.581s (3 cached). Builds shared/llm e prisma generate local concluídos; nenhuma migration aplicada. `git diff --check` passou.

## Limitações e checklist manual pendente
- Testes de UI usam SSR e funções/cliente com fetch mockado; não substituem interação visual, foco com teclado, consentimento real e layout responsivo.
- Login real não foi acionado nem tokens existentes acessados. Callback requer navegador na mesma máquina da API, conforme P2.
- ProviderRunCost representa uso agregado quando disponível no done/snapshot; não faz consulta adicional para cada passo.
- Suítes completas backend/replay e revisão de integração P6 são do orquestrador; P5 só altera UI/client.
- Checkpoint opaco e escrita de runs permanecem pendências das outras fases; não são alterados nem declarados resolvidos por P5.
- Sem push, sem merge na rodada/desempenho e sem comentário na issue nesta fase (orquestrador publica após revisão).
