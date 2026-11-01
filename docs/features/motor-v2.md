# Motor v2 (trabalhador longo), F2

- **Status:** em andamento (F2 do ADR 0002: laço v2 ao lado do v1, desligado por padrão)
- **Data:** 2026-11-01
- **Issues/PRs:** ADR `docs/adr/0002-motor-v2-trabalhador-longo.md`

## O que é
Um segundo motor para o bot, escolhido por bot. Em vez de parar no meio e perguntar demais, o bot trabalha até entregar, dentro de um orçamento de dinheiro e tempo que o dono controla. O motor atual (v1) continua o padrão e roda todo o resto.

## Problema
O bot para no meio de uma pesquisa, entrega incompleto e pergunta demais. No v1, cerca de dez travas sobrepostas (teto soft de 24 passos, estagnação, stall-guard, repetição, falhas seguidas, relógio, reserva de entregável...) encerram o run sem árbitro, mesmo com orçamento sobrando.

## Por que existe
Um laço simples, com um único árbitro (Supervisor) que mede em US$ e minutos, deixa o trabalho longo terminar e torna o custo previsível. Ver o ADR 0002 para o contexto completo e as decisões do dono (31/10).

## Alternativas descartadas
- Afrouxar os números do v1: qualquer trava ainda encerra, sem árbitro.
- Reescrever tudo e trocar no deploy: sem comparação lado a lado e com risco em cofre, conectores, rotinas e grupos.
- Copiar as travas do v1 para o v2: reproduziria o problema.

## Como ligar (por bot, sem migration)
Em `Bot.policyJson` (lido por `readEnginePolicy`, `packages/shared/src/engine-policy.ts`):

| Chave | Valores | Padrão |
|---|---|---|
| `engine` | `"v1"` \| `"v2"` | `"v1"` |
| `workProfile` | `"auto"` \| `"chat"` \| `"long_work"` | `"auto"` (decide pelo pedido) |
| `longWorkBudgetUsd` | US$ 0,05 a 20 | 0,50 |
| `longWorkMinutes` | 1 a 120 | 20 |

Valor ausente ou inválido cai no padrão. `withBotEngine(policy, "v2")` liga sem perder as outras chaves. O teto de custo da conta/bot (`budget.maxCostUsd`) continua valendo: o orçamento do perfil nunca o ultrapassa.

## Como funciona
Arquivos em `packages/agent-runtime/src/engine-v2/`:

- `run.ts`: `runEngineV2(params, { profile, longWorkBudgetUsd?, longWorkMinutes? })`. Mesma entrada (`ComputerUseParams`) e mesma saída (`RunComputerUseResult`, com `stop`) do `runComputerUse`. Monta mensagens, chama `streamChat` com as tools, executa cada tool call por `executeTool` (o mesmo caminho do v1: cofre, confirmações, cards, `ToolContext`), repete até o modelo responder sem tools. Lotes só de leitura rodam em paralelo.
- `supervisor.ts` (puro): o único árbitro. Regras abaixo.
- `task-list.ts` (puro): portão da lista de tarefas em trabalho longo.
- `catalog.ts`: núcleo sempre carregado, grupos raros adiados com índice curto no prompt e `mcp_tool_search` para carregar por nome ou necessidade. O roteador de intenção (regex) vira só dica de pré-carga, nunca portão.
- `prompt.ts`: prompt curto (inglês) com persona, memória, conectores, skills e disciplina do modelo vindos dos builders do v1.

O worker (`apps/worker/src/engine-choice.ts`) escolhe o motor no começo do run e grava `engine`/`engineProfile` em `agent_runs.budgetJson` (`recordRunEngine`, só quando é v2). A retomada lê o gravado: o motor do bot pode mudar no meio sem trocar um run em andamento. Run com checkpoint e sem motor gravado nasceu no v1.

### Perfis e orçamento
| Perfil | Custo | Tempo ativo | Lista de tarefas |
|---|---|---|---|
| `chat` | US$ 0,25 | 8 min | opcional |
| `long_work` | US$ 0,50 (ajustável) | 20 min (ajustável) | obrigatória |

`auto`: `long_work` quando o pedido parece tarefa (`looksLikeLongTask`: verbo de trabalho + entregável, ou pedido longo); `chat` caso contrário. Tempo é só tempo ativo (pausa de login e fila não contam).

### Regras do Supervisor
1. Antes de cada chamada ao modelo: a ~80% do custo ou do tempo avisa UMA vez ("wrap up and deliver"); a 100% faz a última chamada SEM tools para entregar (resultado, fontes, suposições, o que não deu para confirmar). Nunca aborta sem resposta. Stop: `budget_cost` ou `budget_wall`, detalhe `delivered`.
2. Teto absoluto de 200 passos, só como segurança (`budget_steps`, também com entrega).
3. Mesma tool + mesmos args + mesmo resultado 3 vezes seguidas: nota ao modelo. Se repetir de novo depois da nota, encerra o laço com a entrega final (`loop_repeat`, detalhe `after_note`).
4. 3 falhas seguidas da mesma tool: nota e a tool fica bloqueada por 3 passos (devolve erro ao modelo sem executar). O run não morre.
5. Não existe teto soft de passos, estagnação, "concluído" declarado pelo modelo, nem tool removida no meio do trabalho.

### Lista de tarefas (trabalho longo)
Reaproveita `update_task_list`. Ao responder sem lista, ou com itens abertos, o modelo recebe uma nota (máx. 2) para concluir ou descartar cada item com motivo. Descartar = marcar `completed` com conteúdo `DROPPED: <motivo>`. Depois de 2 notas deixa sair, e o stop leva `answered` + `tasklist_open`. Itens descartados e pendências aparecem na resposta como "Não deu para confirmar: …" (pt-BR; en/es no idioma do bot).

### Eventos e persistência
Mesmos eventos do contrato: `assistant_delta`, `tool_call`/`tool_result` (mesmo id, com prefixo do run), cards, `task_list`, `input_consumed`, `assistant_discard` (`items_open`). `done`/`error`/`cancelled` continuam sendo emitidos pelo worker com `stopReason`. Passos (`onStep`), `findCompletedTool`/`findStartedTool` (retomada sem repetir escrita) e checkpoint (`buildRuntimeCheckpoint`) seguem o contrato do v1; cancelamento, pausa e pausa por login funcionam igual.

## Limites desta fase (o que o v2 ainda não faz)
- **Origens:** só o chat direto do dono com o bot. Rotina, alerta, webhook, proativo, e-mail, bot→bot, subagente e grupo seguem no v1.
- **Tools fora do catálogo do v2:** `delegate_task` (ajudantes e caderno da tarefa são a F3), `research_note`, `track_items`, `propose_plan`, `read_cached_result`, sessão de código (`dev_*`), envio entre bots, `set_autonomy`, lições de conector, prévia completa, `notify_user`/proativo.
- **Login:** o card de login é sempre humano (sem preenchimento automático do Cofre nem retomada com item do Cofre); o `login_fill` por tool continua.
- **Cartões que param o run** (questionário, perfil): o v2 devolve texto vazio e `awaiting_confirmation`, sem o fechamento curto que o v1 escreve.
- **Contexto:** mesma higiene de prompt do v1; sem armazenamento de resultado grande por referência, sem resumo de compactação e sem as 4 memórias da F3.
- **Mensagens durante o run:** entram como nota do usuário (`[User message during the task]`); sem triagem por modelo (`join`/`redirect`/`later`) nem interrupção da chamada em voo. `cancel` funciona.
- **Modelo:** usa o modelo do run; o Modo Automático (níveis de dificuldade) e o modelo para código não trocam no v2.
- **Cabeçalho de tempo:** o relógio do v2 é só de execução ativa; operações do computador ganham 25% de folga sobre o orçamento de tempo.

## Riscos
- Custo por tarefa longa sobe (o v2 trabalha até o fim), mas é limitado pelo orçamento do perfil e pelo teto da conta. Conversa curta não pode ficar mais cara: teste compara o "Bom dia" do v2 com o do v1.
- Versões mistas no deploy: api/worker antigos ignoram `budgetJson.engine*` e `policyJson.engine`; sem migration.
- Custo desconhecido do provedor (`costUnknownCalls`) conta como zero para o orçamento em US$; o tempo e o teto de passos continuam limitando.
- Dois motores convivendo: as tools são compartilhadas (registro da F1), então um conserto de tool vale para os dois.

## Custo
Sem custo de infra novo. Tokens: o prompt do v2 é menor que o do v1 no "Bom dia" (testado). Os números de custo real por tarefa vêm do piloto (F4).

## Como testar
- `pnpm --filter @workspace/shared test` (`engine-policy.test.ts`).
- `pnpm --filter @workspace/agent-runtime test` (`engine-v2/supervisor.test.ts`, `task-list.test.ts`, `run.test.ts`: replay de pesquisa com 30 leituras sem corte, "Bom dia" barato, aviso a 80% e entrega sem tools, repetição, falhas, lista de tarefas, retomada).
- Worker: `cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts` (bot sem policy → v1; policy v2 → v2; retomada respeita o gravado).
