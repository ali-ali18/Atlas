# Marcação de ferramentas de conector ("Só leitura")

- **Status:** entregue (0.3.3-beta)
- **Data:** 2026-10-31
- **Issues/PRs:** aprovado pelo dono para a 0.3.3 ("se for da mesma origem não tem por que perguntar")

## O que é
O dono marca, ferramenta por ferramenta, o que um conector só consulta. As marcadas como "Só leitura" deixam de pedir aprovação; o que altera dados continua pedindo.

## Problema
Um conector personalizado (ERP "Agroervas") não informa `readOnlyHint`. O Atlas trata tool sem anotação como escrita reversível e pedia cartão a cada consulta (`listar_pedidos` página 1, 2, 3, `listar_propostas`…). Num pedido feito por outro bot (Radar de Mercado a pedido do Cookie) isso virava uma fila de aprovações.

## Por que existe
A classificação não pode ser adivinhada pelo nome (verbo em pt-BR, ERP próprio). Quem sabe é o dono. A sugestão automática (nome e descrição) só acelera: nada vale antes de ele confirmar uma vez.

## Alternativas descartadas
- Concessão por conector para "qualquer tool parecida com leitura": sem marcação, cobriria também `criar_pedido`.
- Heurística por nome valendo sozinha: erra em ERP próprio e abre brecha para escrita sem cartão.
- Jev classificando cada chamada: custo por uso e superfície de prompt injection.

## Como funciona
- `packages/shared/src/tool-marks.ts`: tipos, validação, sugestão (`suggestToolMark`) e pendências (`pendingToolMarkSuggestions`). A sugestão é calculada na hora (não é gravada).
- Precedência em `classifyMcpTool`: anotação do servidor > marcação confirmada do dono > padrão (sem anotação = escrita reversível). Verbo irreversível em inglês no nome (delete, send, merge…) nunca vira leitura por marcação.
- Banco: `mcp_connections.toolMarksJson` (JSONB, nulo por padrão). Migration aditiva `20261208000000_mcp_tool_marks`.
- API: `PATCH /v1/mcp/connections/:id` aceita `toolMarks` (`read`/`write`, até 200). Tool inexistente ou já anotada pelo servidor falha com 400 e a lista. Escopo por dono (outro usuário recebe 404).
- Agente: `set_connector_tool_marks`, exposta só quando a última fala do usuário pede (como `set_autonomy`), com card de resultado. Usa o rótulo da ferramenta, nunca o nome interno.
- Tela: seção recolhida "Consultas sem aprovação" no detalhe do conector, com Switch "Só leitura" por ferramenta e "Confirmar" quando há sugestões.
- Concessão por tarefa de escrita agora é do solicitante: a chave leva `#from:<botId>` quando o pedido veio de outro bot (`getConversationRequesterBotId`), na API e no runtime.

## Riscos
- Deploy com versões mistas: código antigo ignora a coluna; código novo com coluna nula usa o padrão atual. Concessões antigas (sem `#from:`) só valem para o pedido do próprio dono.
- Marcar escrita como leitura tira o cartão daquela tool: por isso nada vale sem confirmação do dono, e `always_ask`, `blocked` e lição `confirm_always` continuam valendo.
- Prompt injection tentando marcar tools: a tool de chat só existe com pedido explícito do usuário na última fala.

## Custo
Sem chamadas de modelo. A tool de chat entra no contexto só quando o usuário pede.

## Como testar
`packages/shared/src/tool-marks.test.ts`, `packages/agent-runtime/src/tools/connector-tool-marks.test.ts`, replay Radar/Cookie em `computer-use.autonomy.test.ts`, `apps/api/src/routes/scope.test.ts` (IDOR), `packages/db/src/mcp-task-grant.db.test.ts` (com `ATLAS_TEST_DB_URL`), `tool-marks-section.test.tsx` e as prévias em `apps/web/e2e/conector-leitura-previews.spec.ts`.
