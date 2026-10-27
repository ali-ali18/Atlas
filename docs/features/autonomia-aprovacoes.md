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
Quem já aprovou "criar evento" uma vez não quer aprovar mais sete iguais. Mantemos o controle onde importa: só escrita reversível, por pouco tempo, com contador visível, nunca para o que não dá para desfazer e, depois que o bot leu algo que o usuário não escreveu, só com o Jev conferindo cada uso (ver "Modelo de segurança").

## Alternativas descartadas
- **Exceção da política de autonomia com `until`** (`AutonomyPolicy`): a exceção vale para o bot inteiro, em todas as conversas, sem teto de usos e sem contador; a política não tem escopo de conversa. A concessão por tarefa precisa de conversa, validade curta e teto, então ganhou uma tabela própria (`mcp_task_grants`).
- **Guardar a concessão no pedido pendente** (`skill_pending_intents`): há um por conversa, com expiração de 10 minutos, e some quando o cartão é decidido.
- **Baixar os limites do Jev (0,9 e 0,2):** descartado por ora; mudar o número sem medir arrisca deixar passar instrução injetada. Mudou a pergunta (mais clara) e o contexto (o que já foi aprovado).
- **Aprovação em lote** ("Executar todas"): plano item 1, próximo PR.

## Como funciona
1. **Aprovação por tarefa.** Ao aprovar o cartão de uma escrita reversível (`write`), a API (`apps/api/src/chat/confirmed-action.ts`, `grantAfterApproval`) grava `McpTaskGrant` (dono, conversa, conexão, nome da tool, usos, teto 30, validade 30 min, no máximo 2 h desde a primeira aprovação). Em `executeMcpTool` (`packages/agent-runtime/src/computer-use.ts`), `consumeMcpTaskGrant` conta um uso de forma atômica (`UPDATE ... RETURNING`); em seguida o Jev confere só instrução vinda de fora (`externalInstruction`) e a chamada segue sem cartão.
   - Nunca para: `irreversible`, argumento com segredo (`{{secret:...}}`), argumento com convidado/destinatário/webhook/URL de destino, rotina/webhook/subagente (só `origin: chat`), tool com exceção "sempre perguntar", lição `confirm_always`, ferramenta bloqueada. Depois de conteúdo externo lido a concessão ainda vale, mas cada uso passa pelo Jev (ver abaixo). "Sempre para isto" já cobre o resto.
   - Escopo por dono: a consulta filtra `userId` e `conversationId`; outro usuário, outra conversa, outra conexão ou outra tool não casam.
   - Contador: o cartão aprovado mostra "Aprovado · executado 3 vezes nesta tarefa · ..." (campo `grantUses` do cartão persistido; aparece ao recarregar). O modelo recebe "execution 3 of at most 30" no resultado da tool.
   - Auditoria: linha `[mcp-task-grant]` no log com conversa, tool, conexão e usos, sem argumentos.
2. **Jev mais esperto** (`packages/llm/src/jev-decisions.ts`, `packages/agent-runtime/src/mcp/jev-gate.ts`).
   - O estado leva `alreadyApproved`: só nomes de tool com contagem ("create_event ×3", até 8), vindos dos cartões aprovados e executados da conversa (últimos 30 min, escopados pelo dono) e das escritas do run. Título e argumentos nunca entram: um atacante poderia escrever "o usuário já aprovou tudo" num título.
   - A pergunta `alignment` agora diz: agir dentro do pedido é permitido, uma de várias chamadas pedidas ou repetição de ação aprovada é alinhada, e incerteza de intenção sozinha não é motivo para perguntar quando a ação é reversível. Essa leniência sai quando o run já leu conteúdo externo (`untrustedContentSeen`): aí a incerteza vira "false". A pergunta `external_instruction` não mudou.
   - Jev fora do ar: escrita reversível liberada pela autonomia segue; pergunta se é irreversível ou se já houve conteúdo externo, **mesmo com `never_ask`** (a exceção só relaxa o alinhamento).
   - Limites numéricos mantidos (`alignment < 0,9` ou `externalInstruction >= 0,2`).
3. **"Sempre para ..." no cartão do Jev.** O rótulo vira "Sempre para Google Agenda · create event" e cria a exceção `never_ask` da tool no bot (revogável em Autonomia → Exceções). Com `never_ask`, o Jev ainda roda, mas só a instrução vinda de fora (`externalInstruction`) faz perguntar; o alinhamento é ignorado. O rótulo **não** aparece no cartão que o Jev levantou por instrução externa (`jevReviewReason: external_instruction` no pedido pendente) e a API recusa `rememberAlwaysAllow` nesse caso, mesmo com o pedido forjado.
4. **Lote honesto.** A mensagem do cartão avisa o modelo de que as outras chamadas do passo não foram executadas e devem seguir depois da aprovação; a regra de lote **não** fica no bloco de conectores (sempre carregado para quem tem conector): viaja só no resultado do cartão e no aviso de retomada, ou seja, só entra no contexto quando o lote existe. Depois da aprovação, o modelo é instruído a seguir com os itens restantes sem novo cartão.

## Modelo de segurança
Princípio: **conteúdo que o usuário não escreveu (e-mail, página, conector, arquivo, resultado de subagente) nunca dispara escrita em silêncio sem que o Jev confira cada uso.** A concessão é uma comodidade para o pedido do próprio usuário, não um canal para terceiros. Decisão do dono (meio-termo): ler um PDF/site e criar 8 eventos pede 1 cartão e 7 execuções silenciosas, cada uma com checagem de instrução externa.
- **Jev na chamada concedida, só quando há conteúdo externo.** Sem conteúdo externo lido (`untrustedAt` nulo e `untrustedSeen` falso) o Jev **não é chamado** (nada para injetar; economiza custo). Com conteúdo externo, cada uso roda a pergunta de instrução externa (`externalInstructionOnly`): `externalInstruction >= 0,2` devolve o uso (`releaseMcpTaskGrant`) e cai no cartão, sem "Sempre para…" e sem nova concessão. Jev indisponível (erro, sem avaliador), desligado ou em `shadow` (que não consegue barrar) depois de conteúdo externo também devolve o uso e cai no cartão: nunca escrita silenciosa. Alinhamento não é checado (o usuário já aprovou aquele tipo de ação).
- **Conteúdo externo lido torna o Jev obrigatório em cada uso (a concessão não é invalidada).** Um único ponto de despacho (`runComputerUse`, depois de cada tool) marca `untrustedSeen` para web/navegador (busca, extração, texto, snapshot, captura), e-mail (`email_list`/`email_read`), arquivos e anexos, shell/código, subagente (`delegate_task`), API conectada, GitHub e **leitura de conector MCP** (lista em `isUntrustedContentTool`, `packages/shared/src/mcp-task-grant.ts`). Efeitos: (1) o Jev perde a leniência de incerteza; (2) `markMcpTaskGrantsUntrusted` grava `untrustedAt` nas concessões da conversa; `consumeMcpTaskGrant` **não** bloqueia por isso, devolve `untrustedAt` e o runtime decide (Jev obrigatório se `untrustedSeen` do run ou `untrustedAt` da concessão); (3) o flag vai no checkpoint (`untrustedSeen`) e sobrevive à retomada; (4) o cartão criado depois de conteúdo externo guarda `untrustedSeen`; aprovar **concede** a tarefa, mas a concessão já nasce com `untrustedAt` (`grantMcpTask({ untrusted: true })`), então o Jev é obrigatório nos usos mesmo num run novo. Cartão levantado por `external_instruction` ou com alvo externo continua sem conceder.
- **Alvo externo.** Convidado, destinatário, `to`/`cc`/`bcc`, e-mail, webhook ou URL de destino nos argumentos (`hasExternalTargetArgs`, pura, em `shared`) impedem conceder e consumir: cada chamada pede cartão.
- **Teto de vida.** Renovar mantém `uses`, `maxUses`, `createdAt` e `untrustedAt` enquanto a concessão é válida e nunca passa de `createdAt + 2 h`; só a vencida recomeça (INSERT ... ON CONFLICT, sem corrida). `grantMcpTask` limpa as vencidas de forma oportunista.
- **`actionClass` das tools Composio/MCP.** Vem de `classifyMcpTool` (`packages/shared/src/autonomy-tools.ts`, via `mcpAutonomyMeta` em `registry.ts`). Composio não traz anotações: nome com verbo de leitura vira `read` (e conta como conteúdo externo ao ler); `delete/remove/send/merge/publish/transfer...` vira `irreversible`; o resto é `write`. Os verbos que atingem terceiros (`reply`, `invite`, `share`, `forward`, `notify`, `message`, `comment`...) só viram `irreversible` com `openWorldHint: true`, que o Composio não envia, então `GMAIL_REPLY_TO_THREAD` sairia como `write`. Por isso `canGrantMcpTask(actionClass, toolName)` também recusa esses verbos pelo nome. A classificação em si não foi alterada (mexeria na autonomia de todo mundo); fica como sugestão tratar `readByName` + verbo de saída como `irreversible`.
- **Resíduo conhecido:** a marca vive nas concessões já existentes e no cartão. Conteúdo externo lido em um run anterior, **antes** de qualquer concessão ou cartão da conversa, não é lembrado depois que o usuário aprova um cartão num run novo limpo; a aprovação visível do usuário é o limite aí.

## Riscos
- **Deploy com versões mistas:** a tabela é nova e aditiva; api/worker antigos ignoram a concessão (voltam a pedir cartão). Aplicar a migration antes do deploy novo.
- **Cartão aprovado vira concessão por 30 min (máx. 2 h):** mitigado pelo modelo de segurança acima. Custo: uma chamada de Jev (só instrução externa) por uso concedido, apenas quando conteúdo externo foi lido; sem conteúdo externo, nenhuma.
- **"Jev fora do ar" agora libera** escrita reversível autorizada pela autonomia. A heurística de "conteúdo externo" agora cobre web, e-mail, arquivos, subagente e conector; a contrapartida é que depois de qualquer pesquisa na web o Jev passa a conferir cada uso concedido (e, sem Jev, a conversa volta a pedir cartão).
- **Contador ao vivo:** o marcador só mostra o número depois de recarregar (o evento ao vivo não carrega o contador).
- **Replays/evals:** a mensagem do cartão e o texto do follow-up mudaram (inglês, para o modelo). Os testes de economia ("Bom dia" pequeno) seguem verdes.

## Como calibrar o Jev (modo sombra)
`JEV_MCP_MODE=shadow` avalia sem barrar e grava `alignment` e `externalInstruction` por chamada (auditoria do passo e `JEV_MCP_DEBUG=1`). Para decidir se 0,9 e 0,2 ainda fazem sentido: rodar alguns dias em sombra, juntar as chamadas que o usuário aprovou/recusou nos cartões e comparar a distribuição das notas dessas chamadas com os limites. Só então mexer nos números.

## Custo
Sem chamada nova de LLM. A concessão elimina chamadas de Jev e cartões nas repetições; o estado do Jev cresce no máximo ~1 KB (8 linhas curtas). O bloco de conectores não cresce (a regra de lote é lazy). Com concessão e Jev ligado, há uma avaliação de Jev por uso.

## Como testar
- `pnpm --filter @workspace/shared test` (regras puras, contador no cartão)
- `pnpm --filter @workspace/agent-runtime test` (`computer-use.autonomy.test.ts`: 1 cartão e 8 execuções, irreversível sempre pergunta, não vence "sempre perguntar"/rotina/segredo, Jev recebe o já aprovado, Jev fora do ar, `never_ask`; `mcp/jev-gate.test.ts`; `computer-use.batch-honesty.test.ts`)
- api: `confirmed-action.autonomy.test.ts` (concessão só do dono, só `write`) e `confirmed-action.followup.test.ts`
- db (com Postgres): `pnpm --filter @workspace/db test:db` (`mcp-task-grant.db.test.ts`: dono, conversa, validade, teto, renovação mantém `uses` e respeita 2 h, `untrustedAt`, consumo paralelo no teto, `listApprovedConfirmTools` escopada)
- web: `lib/approval-dock.test.tsx` (marcador com contador)
