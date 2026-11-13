# Subagentes no motor v4 (`delegate_task`)

- **Status:** em andamento (parte 1: núcleo + cartão)
- **Data:** 2026-11-09
- **Issues/PRs:** F9, frente "subagentes"

## O que é
O bot abre de 1 a 3 subagentes que trabalham em paralelo, cada um com a própria cabeça limpa, só lendo a web. O usuário vê o
cartão de progresso "Subagentes" (o mesmo do motor antigo) e o bot junta os relatórios na resposta.

## Problema
O motor v4 só tinha ajudantes dentro de `research` (plano de pesquisa com fontes) e de `browser_digest`. Tarefas independentes
em paralelo ("compare esse produto em 3 lojas") sem um plano de pesquisa não tinham como rodar, e o cartão de subagentes do chat
não era emitido.

## Por que existe
Paridade com o `delegate_task` do motor antigo sem criar um segundo mecanismo: a tool nova roda sobre os MESMOS ajudantes do v4
(`createHelpers`), então herda o que já foi decidido e testado lá.

## O que herda dos ajudantes (não foi reimplementado)
- **Gasto:** o gasto de cada subagente entra no livro de gasto da mãe e no teto de gasto do dono (`ownerMaxUsd`); irmãos dividem o mesmo teto.
- **Permissão:** `childPolicy` (shared): o subagente só lê, nunca escreve, envia, compra nem pede ao dono; regra `approve` do dono vira `deny`; autonomia nunca maior que a da mãe; mandato não herdado.
- **Sem recursão:** `delegate` e `research` nunca entram no registro do filho.
- **Taint:** o subagente nasce com os sinais de proveniência da mãe; a tool é declarada `trust: "untrusted"` (origem `web`), então o relatório volta como DADO e o run da mãe fica marcado como tendo lido conteúdo de fora.
- **Modelo:** papel `helper` da cadeia de modelos (decidido por papel pelo adaptador `Llm`).

## A tool
`delegate_task({ tasks: [{ goal, title?, context? }] })`, de 1 a 3 tarefas (`goal` ≤ 2000, `context` ≤ 6000, `title` ≤ 40 caracteres).
- Capacidade lazy `delegate` (uma linha no índice; a tool e as regras só chegam com `use_capability`).
- Campo desconhecido falha com a lista do aceito (`Accepted fields: tasks`).
- Cada tarefa vira um ajudante com SÓ a capacidade `web`, 30 passos de teto por subagente (a mesma rede de segurança do motor antigo; o teto de passos do dono, se menor, vale) e o contexto da mãe como dado não confiável.
- Resultado por tarefa, por sinais estruturais (nunca pelo texto do relatório):
  - `ok`: o subagente leu e respondeu;
  - `partial`: parou por um limite do dono (gasto/passos) com texto, a resposta veio parcial, ou respondeu sem chamar nenhuma tool (palpite, com a nota "unverified");
  - `failed`: falhou, só colecionou erros de tool, ou terminou sem texto.
- Todas falharam: a tool devolve erro (`ok:false`) com os motivos; senão devolve os relatórios, marcados como não confiáveis.
- Só com dono presente: rotina, webhook, run de agenda e subagente não recebem a capacidade (como no motor antigo).

## O cartão (o mesmo da UI atual, nada novo no front)
- Ao vivo: eventos `subagent_started`, `subagent_tool` e `subagent_done` (contrato SSE existente), com `groupId` = `delegate:<run>:<hash do callId>` (uma chamada = um grupo, estável na retomada).
- Persistido: mensagem `subagents` com o MESMO `groupId`, gravada uma vez ao fim da chamada em `appendConversationCard` (o merge do chat dedupa por `groupId`).
- `childRunId` = `<run da mãe>:helper:<n>` (vazio quando o subagente falhou antes de abrir o run).
- Porta `SubagentCards` (`packages/agent/src/ports/subagent-cards.ts`), adaptador no worker `v4-adapters/subagents.ts`. Erro do cartão (SSE, banco) nunca derruba a tool.

## Mudanças na infraestrutura de ajudantes (compatíveis)
- `Helpers.runAll(tasks, signal?, observer?)`: o observador opcional vê começo, tool e fim de cada ajudante. Quem não passa o observador (research, browser_digest) não muda.
- `HelperTask.maxSteps?`: estreita a rede de segurança do filho (nunca a afrouxa).
- `HelperResult.toolsUsed?` e `toolCalls?`: nomes das tools e contagem ok/erro do filho.
- `buildV4Registry` passou a montar os ajudantes UMA vez por run e reutilizá-los em `research` e `delegate` (antes `research` criava sua instância).

## Fora desta parte (ficou para a parte 2)
- **Conectores só leitura, memória e e-mail no subagente** (o `tools` do legado). O taint de leitura privada de um filho não volta à mãe com a tool declarada `web`; precisa de taint dinâmico por chamada. Por isso o subagente v4 só tem `web`.
- **Modo `browser_item`** (uma aba do navegador por item) e o arg `item` do ledger: o v4 tem `browser_digest` e listas de tarefas; sem equivalente 1:1 ainda.
- **Arg `model` e o modelo de subagente do bot** (`policyJson.subagentModel`): o v4 escolhe o modelo por PAPEL (`helper`), não por tarefa.
- **Linhas `agent run` por subagente** (`createSubagentRun`, inspetor de run) e o **retry com escopo reduzido** após estouro de prazo: o v4 não tem prazo de relógio (ADR 0003).
- Orçamento de tokens por filho (`planChildBudget`): o v4 limita por gasto em US$ e passos do dono.

## Riscos
- Contrato de `Helpers`/`HelperResult` ganhou campos OPCIONAIS; fakes e consumidores existentes seguem válidos.
- Evento `subagent_*` já existe no SSE e no web; cliente antigo ignora.
- O índice de capacidades ganha uma linha (≤ 60 tokens): "Bom dia" coberto por `guards/economy.test.ts`.
- O relatório é conteúdo de fora: a mãe é instruída a verificar e escrever a resposta final; a tool é `untrusted`.

## Custo
Um subagente = um run completo no papel `helper` (modelo barato). Até 3 em paralelo, cada um com teto de 30 passos; o gasto conta no teto do dono. "Bom dia" não muda (teste de economia).

## Como testar
- `pnpm --filter @workspace/agent test` (`capabilities/delegate/delegate.test.ts`, `helpers/create-helpers.test.ts`, `guards/*`, `presets/presets.test.ts`).
- Worker: `src/v4-adapters/subagents.test.ts`, `src/v4-adapters/index.test.ts` e `src/engine-v4.test.ts` (ponta a ponta com cartão ao vivo e salvo).
