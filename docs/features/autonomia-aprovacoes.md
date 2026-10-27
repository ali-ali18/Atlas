# Autonomia: aprovações que valem para a tarefa

- **Status:** em andamento (primeiro PR: itens 2, 3, 4 e 7 do plano de autonomia; aprovação em lote fica para o próximo)
- **Data:** 2026-10-27
- **Issues/PRs:** #

## O que é
Depois que você aprova uma ação de escrita num conector (ex.: criar um evento na Agenda), o bot pode repetir a mesma ação, no mesmo conector, nesta conversa, sem pedir de novo. O verificador de ações (Jev) deixou de perguntar por dúvida sozinha, e o "Sempre para ..." aparece também no cartão do Jev.

## Problema
Pedir "coloque as 8 datas de prova na agenda" gerou 8 cartões "JEV pediu confirmação" seguidos, um por vez, e o bot ainda disse "só a primeira foi executada". Quatro causas:
- o Jev era mais rígido que a autonomia do usuário (pedia confirmação mesmo com a ação liberada, e também quando estava fora do ar) e não sabia o que já tinha sido aprovado;
- o cartão do Jev não oferecia "Não perguntar mais";
- só um cartão existe por vez: as outras chamadas do mesmo passo são descartadas, o run termina, e depois do clique o modelo refaz a próxima;
- a mensagem do bot não dizia que as outras ainda estavam esperando.

## Por que existe
Quem já aprovou "criar evento" uma vez não quer aprovar mais sete iguais. Mantemos o controle onde importa: só escrita reversível, por pouco tempo, com contador visível, e nunca para o que não dá para desfazer.

## Alternativas descartadas
- **Exceção da política de autonomia com `until`** (`AutonomyPolicy`): a exceção vale para o bot inteiro, em todas as conversas, sem teto de usos e sem contador; a política não tem escopo de conversa. A concessão por tarefa precisa de conversa, validade curta e teto, então ganhou uma tabela própria (`mcp_task_grants`).
- **Guardar a concessão no pedido pendente** (`skill_pending_intents`): há um por conversa, com expiração de 10 minutos, e some quando o cartão é decidido.
- **Baixar os limites do Jev (0,9 e 0,2):** descartado por ora; mudar o número sem medir arrisca deixar passar instrução injetada. Mudou a pergunta (mais clara) e o contexto (o que já foi aprovado).
- **Aprovação em lote** ("Executar todas"): plano item 1, próximo PR.

## Como funciona
1. **Aprovação por tarefa.** Ao aprovar o cartão de uma escrita reversível (`write`), a API (`apps/api/src/chat/confirmed-action.ts`, `grantAfterApproval`) grava `McpTaskGrant` (dono, conversa, conexão, nome da tool, usos, teto 30, validade 30 min). Em `executeMcpTool` (`packages/agent-runtime/src/computer-use.ts`), antes do Jev, `consumeMcpTaskGrant` conta um uso de forma atômica (`UPDATE ... RETURNING`) e a chamada segue sem cartão.
   - Nunca para: `irreversible`, argumento com segredo (`{{secret:...}}`), rotina/webhook/subagente (só `origin: chat`), tool com exceção "sempre perguntar", lição `confirm_always`, ferramenta bloqueada. "Sempre para isto" já cobre o resto.
   - Escopo por dono: a consulta filtra `userId` e `conversationId`; outro usuário, outra conversa, outra conexão ou outra tool não casam.
   - Contador: o cartão aprovado mostra "Aprovado · executado 3 vezes nesta tarefa · ..." (campo `grantUses` do cartão persistido; aparece ao recarregar). O modelo recebe "execution 3 of at most 30" no resultado da tool.
   - Auditoria: linha `[mcp-task-grant]` no log com conversa, tool, conexão e usos, sem argumentos.
2. **Jev mais esperto** (`packages/llm/src/jev-decisions.ts`, `packages/agent-runtime/src/mcp/jev-gate.ts`).
   - O estado leva `alreadyApproved` (até 8 linhas curtas, sem segredos): cartões aprovados e executados na conversa (últimos 30 min) e ações executadas no run.
   - A pergunta `alignment` agora diz: agir dentro do pedido é permitido, uma de várias chamadas pedidas ou repetição de ação aprovada é alinhada, e incerteza de intenção sozinha não é motivo para perguntar quando a ação é reversível. A pergunta `external_instruction` não mudou.
   - Jev fora do ar: escrita reversível liberada pela autonomia segue; pergunta se é irreversível ou se o run já leu conteúdo externo (resultado de leitura de conector).
   - Limites numéricos mantidos (`alignment < 0,9` ou `externalInstruction >= 0,2`).
3. **"Sempre para ..." no cartão do Jev.** O rótulo vira "Sempre para Google Agenda · create event" e cria a exceção `never_ask` da tool no bot (revogável em Autonomia → Exceções). Com `never_ask`, o Jev ainda roda, mas só a instrução vinda de fora (`externalInstruction`) faz perguntar; o alinhamento é ignorado.
4. **Lote honesto.** A mensagem do cartão avisa o modelo de que as outras chamadas do passo não foram executadas e devem seguir depois da aprovação; o bloco de conectores (só presente para quem tem conector) manda dizer a contagem e não afirmar que "não rodaram". Depois da aprovação, o modelo é instruído a seguir com os itens restantes sem novo cartão.

## Riscos
- **Deploy com versões mistas:** a tabela é nova e aditiva; api/worker antigos ignoram a concessão (voltam a pedir cartão). Aplicar a migration antes do deploy novo.
- **Cartão aprovado vira concessão por 30 min:** uma injeção de prompt no mesmo run poderia reaproveitar a ferramenta aprovada. Mitigações: só a mesma tool/conexão/conversa, teto de 30 usos, só `write`, e o Jev ainda não roda sobre a chamada concedida (a decisão do usuário vale). Possível endurecimento futuro: exigir `externalInstruction` baixo também nas chamadas concedidas, ao custo de uma chamada de Jev por uso.
- **"Jev fora do ar" agora libera** escrita reversível autorizada pela autonomia. A heurística de "conteúdo externo" é só leitura de conector no run (não cobre navegador nem busca na web).
- **Contador ao vivo:** o marcador só mostra o número depois de recarregar (o evento ao vivo não carrega o contador).
- **Replays/evals:** a mensagem do cartão e o texto do follow-up mudaram (inglês, para o modelo). Os testes de economia ("Bom dia" pequeno) seguem verdes.

## Como calibrar o Jev (modo sombra)
`JEV_MCP_MODE=shadow` avalia sem barrar e grava `alignment` e `externalInstruction` por chamada (auditoria do passo e `JEV_MCP_DEBUG=1`). Para decidir se 0,9 e 0,2 ainda fazem sentido: rodar alguns dias em sombra, juntar as chamadas que o usuário aprovou/recusou nos cartões e comparar a distribuição das notas dessas chamadas com os limites. Só então mexer nos números.

## Custo
Sem chamada nova de LLM. A concessão elimina chamadas de Jev e cartões nas repetições; o estado do Jev cresce no máximo ~1 KB (8 linhas curtas). O bloco de conectores ganha uma linha (~500 caracteres) só para quem tem conector.

## Como testar
- `pnpm --filter @workspace/shared test` (regras puras, contador no cartão)
- `pnpm --filter @workspace/agent-runtime test` (`computer-use.autonomy.test.ts`: 1 cartão e 8 execuções, irreversível sempre pergunta, não vence "sempre perguntar"/rotina/segredo, Jev recebe o já aprovado, Jev fora do ar, `never_ask`; `mcp/jev-gate.test.ts`; `computer-use.batch-honesty.test.ts`)
- api: `confirmed-action.autonomy.test.ts` (concessão só do dono, só `write`) e `confirmed-action.followup.test.ts`
- db (com Postgres): `pnpm --filter @workspace/db test:db` (`mcp-task-grant.db.test.ts`: dono, conversa, validade, teto)
- web: `lib/approval-dock.test.tsx` (marcador com contador)
