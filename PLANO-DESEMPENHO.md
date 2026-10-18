# Plano Desempenho — revisão de desempenho e confiabilidade (worker, API, loop do agente)

**Status: CONGELADO em 02/10/2026** — mudanças só por decisão explícita do usuário; pesquisa em `PLANO-DESEMPENHO-PESQUISA.md`.

## Cabeçalho da rodada
- **Branch base:** `rodada/desempenho` (criada a partir de `main`).
- **Regras:** `.agents/rules/` (fonte única). Leia `00-core`, `10-git-worktree`, `20-commits`, `40-seguranca`, `50-testes` e, ao mexer no agente, `60-agente`.
- **Um worktree por agente:** branch `agente-v3/<agente>` criada a partir de `rodada/desempenho`.
- **Commits:** atômicos, Conventional Commits em pt-BR, sem push.
- **Texto para o modelo** (prompts, descrições de tools, mensagens injetadas): inglês neutro e genérico, **sem exemplos de nicho ou de conector** (nada de nomes de ERP, CRM etc.).
- **Todo item vem com teste.** Sem teste, o item não está pronto.

---

## Contexto
Tarefas longas estão lentas, caras e só funcionam com modelo caro. Exemplo: uma proposta Bling com 3 itens levou 4 min e 830k tokens, com a mesma leitura repetida 9×. Este plano funde as revisões do GPT, do Codex e a conferência no código: **todo item foi confirmado com `arquivo:linha`**, exceto os marcados **(hipótese)**, que exigem reprodução ou medição. Referências de linha podem deslocar: conferir antes de mudar. A pesquisa, as fontes e o histórico da revisão estão em `PLANO-DESEMPENHO-PESQUISA.md`. Nada aqui está implementado.

Objetivo: o modelo econômico conclui a tarefa com contexto enxuto, sem repetir trabalho e sem duplicar efeitos. O modelo caro vira exceção, não requisito.

Execução: subagentes Sonnet em worktrees, commits atômicos, sem push. Texto para o modelo sempre neutro e genérico.

Descartado (FALSO no código): "deltas não são agrupados". O worker já agrupa em 40 ms (`apps/worker/src/coalesce-run-events.ts`).

---

## P0 — Segurança e corretude (fazer primeiro)

| # | Problema confirmado | Onde | Correção |
|---|---|---|---|
| S1 | `/v1/chat/computer` cria e lê runs **sem userId** (IDOR). Escopo ampliado: criação moderna de runs, posse de bot/conversa e rotas sandbox. Contraprova: hoje só o dono loga (`api/auth.ts:58,82`; `middleware/auth.ts:28`), então o risco é condicionado ao multiusuário, mas segue P0 porque multiusuário é o objetivo. FK NOT VALID impede novos IDs sem User real em banco migrado: o efeito na rota legada pode ser falha de compatibilidade de `default` | `apps/api/src/routes/computer.ts:100,105,118,155`, `routes/runs.ts:300` | `scopeFor(session).userId` em `createAgentRun`/`maybeHandleSkillCommand`, `getAgentRunForUser` no loop, abort no disconnect e `paused` como terminal. Reaproveitar o claim seguro de legado (`maybeClaimDefaultOnBoot`, `api/index.ts:142`; `db/claim-default.ts:254`), **sem segundo claim**; fallback `default` só para o dono validado; exigir a transição concluída antes de abrir multiusuário. Teste B≠A em cada rota, e na rota legada com banco migrado. |
| S2 | Sem limite de body, mensagens nem `content` | `runs.ts parseCreateBody`, `chat/parse.ts`, `/inputs` | `bodyLimit` do Hono de **1 MB só nas rotas JSON**; upload de imagem mantém o limite de 10 MB mais o limite de envelope (F14). Teto de mensagens, de `content` e do tamanho de entrada, `maxSteps` limitado, **modos desconhecidos rejeitados**. Aceite: body JSON acima do teto → 413; modo inválido → 400; **upload de imagem de 9 MB continua funcionando** (teste). |
| S3 | **Posse de sandbox, bot e conversa.** Store/manager de sandbox sem dono e rotas que não vinculam a sessão ao dono; criação de run consulta bot/conversa só por ID (colisão usa a conversa); `ownerIds` inclui `default` e conversa sem dono é liberada. Contraprova: auth global só deixa entrar o owner; VNC usa `-nopw` (`entrypoint.sh:106`) mas as portas publicam em `127.0.0.1` (`docker-manager.ts:282`), então **não afirmar exposição à internet**; viewer remoto exige gateway autenticado | `sandbox/session-store.ts:3`, `sandbox/docker-manager.ts:244`, `api/routes/sandbox.ts:99`, `db/runs.ts:186,250`, `db/mcp-connections.ts:120`, `db/conversations.ts:47` | Vincular a sessão de sandbox ao dono (store, manager e rotas); verificar dono de bot/conversa/sessão antes de criar run ou steer; restringir o fallback `default` ao owner validado. Teste cruzado B≠A nas operações e no viewer, e legado visível só ao dono após o claim. |
| W1 | Lease por processo: uma reentrega no mesmo worker roda o run **2×** em paralelo | `worker/index.ts:64`, `db/runs.ts:546`, `agent-run.ts:283,869` | Identidade do lease **por tentativa de execução** (`${owner}:${job.id}:${attemptsMade}`/UUID). Teste: entrega duplicada → 1 execução. |
| W2 | Reconciler não reconfere o lease no `updateMany`; `renewRunLease` renova um lease vencido | `db/runs.ts:572,602,800,964,1260,1298,1351,1404` | Reconciler só atualiza run expirado se lease, token/geração e expiração **ainda batem com a seleção** (`leaseToken` + `leaseUntil<cutoff` no `where`); o renew exige um lease vigente. **Fencing uniforme e atômico:** `appendAgentStep` faz o assert e a mutação separados (`:964`) e alguns checks não verificam expiração (`:602,800,1404`). Teste de corrida heartbeat × reconciler. |
| W3 | Timers de heartbeat/cancel criados fora do try/finally (vazam e mantêm o lease zumbi) | `agent-run.ts:291-516` | `try/finally` em **todo** o setup após adquirir o lease; fechar o MCP no `finally`. |
| W4 | Gravar `sandboxSessionId` **apaga o resto do checkpoint** (orçamento, tetos, login pendente) | `agent-run.ts:463-473` | Preservar o checkpoint **completo** ao adicionar a sessão (merge `{...current, sandboxSessionId}` ou só a coluna). |
| W5 | Follow-up: criar o run, enfileirar e consumir os inputs em 3 passos soltos (inputs órfãos e follow-up duplicado) | `agent-run.ts:783-814`, `db/runs.ts:263` | Criar o follow-up e consumir os inputs **na mesma transação**, reaproveitando o mecanismo de run `queued` com enfileiramento pendente (`listQueuedRunsMissingJob`); enfileirar depois com jobId determinístico. **Sem segundo outbox.** Contraprova: a reconciliação já existe (API 15 s `api/index.ts:199`, worker 60 s `worker/index.ts:272`, `routes/runs.ts:219`): corrigir sweeps sobrepostos e conservar. Checkpoint e consumo já são transacionais (`db/runs.ts:790`). A fila funde no máximo 4 anexos e colisão só com imagem não cria steer (`db/runs.ts:263`): **não consumir anexo descartado**. Teste: duas mensagens somando >4 imagens e colisão só com imagem. |
| W6 | Falha do Redis após `done` mostra erro num run concluído | `agent-run.ts:732-742,897-919` | A conclusão terminal é **irrevogável**: falha posterior de manutenção ou de enqueue nunca refaz nem marca como erro a tarefa principal. **Intenção de manutenção durável** + enqueue de melhor esforço (`enqueueMemoryReview` e `settleRoutineRunForAgentRun`, como o skill-learn). Recuperar a entrega do card sem recriar o arquivo. |
| W7 | memory-review `add` cai no ramo `remove`: devolve erro falso e pode **apagar** memória | `worker/processors/memory-review.ts:134-183` | `return` ao fim do `add` (erro falso e remoção indevida). Teste do caso com `old_text`. |
| W8 | BullMQ é at-least-once: sem testes de reentrega e de crash, nem idempotência documentada. Contraprova: replay de tool concluída já existe (`computer-use.ts:5354`; `findCompletedToolStep` em `agent-run.ts:578`); a janela perigosa é efeito externo aplicado antes do registro (ver W9) | `worker/index.ts`, `agent-run.ts`, `db/runs.ts` | Testes de entrega duplicada e de recuperação após crash (antes/depois de concluir, de criar o follow-up e de enfileirar). Documentar a idempotência de cada passo no código. Retomar tarefa de 20 passos sem escrita duplicada. |
| W9 | **Journal de efeitos** (novo; absorve o foco de L9/W8 em escrita externa). Persistir também os resultados individuais de leituras paralelas (retomar só as faltantes) e recuperar a entrega do card sem recriar o arquivo: o resultado final é gravado antes do card (`computer-use.ts:5580,5624`) **(hipótese: crash intermediário deixa artifact sem card)** | `db/runs.ts`, `agent-runtime` (executor de tools), `mcp/call.ts` | **Intenção durável antes** de escrita externa e **resultado durável depois**. Efeito desconhecido após crash ou timeout → marcar **incerto** e **nunca repetir automaticamente**; reconciliar (ler o estado) ou perguntar ao usuário. `idempotentHint` é indício, não garantia. Teste: crash entre aplicar e registrar não duplica a escrita. |
| R1 | Escrita MCP é **retentada após timeout** (duplica a criação ou o envio) | `agent-runtime/mcp/call.ts:89,129-146,181`, `mcp/retry.ts:17` | Retentar só leitura (o retry não recebe classe/idempotência da ação; a annotation é coletada em `:181`). `idempotentHint` é indício, não garantia. Nunca retentar escrita após timeout sem checar o estado ou ter idempotência real; resultado incerto segue o journal de efeitos (**W9**). |

## P0 — Controles de configuração durante a tarefa (C)

| # | Problema | Onde | Correção e aceite |
|---|---|---|---|
| C1 | Fechar a config chama o agente (run `config-closed`), mesmo sem pedido do usuário. **Absorve A5.** **Decidido pelo usuário em 02/10/2026** | `template-4-client.tsx:703-770`, `BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION` | Fechar a config **só salva** (inclusive a descrição) e mostra confirmação visual; **nunca inicia run**. O run de evento `config-closed` é **removido**. O agente usa a nova config **a partir da próxima mensagem do usuário**. O onboarding **não muda**: continua reagindo em `bot-created`. Aceite: mudança de config de admin gera **0** mensagens do agente. |
| C2 | Controles de admin viajam como mensagens de steer/fila **(hipótese)** | `routes/runs.ts` (`/inputs`), `agent-run.ts` | **Controles administrativos tipados e versionados**, separados de steer/fila, persistidos no run. Contrato versionado (ver K1). |
| C3 | Troca manual de modelo no meio da tarefa **(hipótese)** | `computer-use.ts` (resolução do modelo por passo) | Vale na **próxima decisão**, depois que a tool corrente terminar, e recalcula visão, tools disponíveis e limite de contexto. |
| C4 | Mudança temporária feita pelo Jev pode vazar para a preferência do bot **(hipótese)** | `jev/*`, `db/bots.ts` | Troca temporária do Jev não altera a preferência do bot; a UI mostra modelo **pedido × aplicado** (ver A7). |
| C5 | Correção real do usuário é reconhecida repetidamente; histórico antigo continua exigindo ack **(hipótese)** | prompt de correção, hygiene | Confirmar a correção **uma vez**; histórico antigo não cobra novo reconhecimento. Teste: mudança de config no meio da tarefa sem perder o objetivo nem repetir ack. |

## P0 — Download → imagem → PDF (D)

Caso observado: 25 chamadas ao modelo, 7 screenshots, **0** chamadas ao gerador de PDF, 118–139 s entre passos, caçando URL de imagem via clipboard. O agente precisa de um caminho direto.

| # | Problema | Onde | Correção e aceite |
|---|---|---|---|
| D1 | Downloads do navegador do sandbox não são expostos ao agente **(hipótese)** | `docker/agent-sandbox/**`, `packages/sandbox` | Capturar downloads no sandbox e expor **ids opacos** de arquivos concluídos, com status e metadados. |
| D2 | Não há como virar Artifact do usuário | `db/artifacts.ts`, `files/**` | Importar o download como Artifact do usuário checando sessão, dono, tamanho e MIME. **Nunca aceitar caminho arbitrário.** Teste: PDF, download e controles de outro usuário bloqueados. |
| D3 | `create_file` não aceita imagem | `files/**`, executor `create_file` | Imagens por `artifactId`; bytes resolvidos e embutidos **no servidor**, nunca base64 nos args do modelo. |
| D4 | PDF só de imagem ou texto + imagens **(hipótese)** | renderizador de PDF no **servidor** (Chromium via `playwright-core`, F9), não o `/pdf` do sandbox | Uma imagem por página, proporcional à área imprimível. Incluir path/readiness do Chromium e readiness das capacidades. |
| D5 | Chromium offline e URL pública | renderizador, fetch seguro | Chromium segue offline, reaproveitando o processamento seguro de imagem. URL pública usa o fetch SSRF-safe existente. |
| D6 | Fluxo longo demais | prompt/descrição das tools | Descrição de tool aponta o caminho direto (download → artifact → `create_file`). Aceite: PDF a partir de imagem já disponível em **≤ 2 decisões do modelo**. Regressão: download → imagem → PDF com a imagem embutida e o card do arquivo entregue. |
| D7 | Infra do PDF, reaper e artefatos. Contraprova: em dev no mesmo host pode funcionar; o compose oficial não compartilha volume de artifacts (`db/artifacts.ts:10,103` usa temporário) e a imagem node não traz Chrome (PDF usa Chromium do servidor, `files/pdf-chromium.ts:11`) | `sandbox/reaper.ts:64`, `docker-manager.ts:100,354,606`, `db/artifacts.ts:10,103,192`, `tools/create-file.ts:103`, compose | (1) Armazenamento persistente de artefatos **compartilhado entre API e worker** (volume/path/readiness do Chromium; smoke nas imagens oficiais: worker gera, API baixa, restart preserva). (2) **Lease/heartbeat compartilhado do reaper**: o reaper da API conhece um Map local e usa idade/TTL, então sessão usada só pelo worker parece órfã; teste de tarefa longa, restart e reaper em outro processo. (3) **Claim distribuído em `resolveSession`** (buscar/criar sem claim; adoção escolhe a primeira, `:354,606`): duas instâncias podem criar containers para o mesmo perfil; testar concorrência e restart. (4) Readiness de ~180 s por fase (`:100`): propagar deadline e medir o setup à parte. (5) Linha de artifact criada antes dos bytes: estado `ready`, reconciliação/GC e retenção. (6) Versão/contagem de artifact em read-then-write (`db/artifacts.ts:192`, `tools/create-file.ts:103`): reservar atomicamente. |

---

## P1 — Velocidade e custo do loop (o que faz o modelo barato funcionar)

| # | Problema confirmado | Onde | Correção |
|---|---|---|---|
| L1 | Mesma leitura repetida (9× o mesmo `getProposal`) e `mcp_tool_search` vazio 8× | loop `computer-use.ts` | **Cache de leitura** com: janela de validade (TTL), invalidada por qualquer escrita no mesmo conector; arg/opção explícita de atualização para polling legítimo; e **referência acessível ao resultado anterior** (não o payload inteiro de novo). Duplicata dentro do TTL recebe o aviso curto "já tem esse resultado, prossiga"; tools de polling podem optar por sair. Escrita MCP nunca é deduplicada. Busca de tool vazia 2× → "siga com as tools carregadas". |
| L2 | Tools rodam **uma por vez** | `computer-use.ts:5183,5410` (`runTools`) | Só leituras **independentes** em paralelo, concorrência inicial **3** (`Promise.all`). Escritas, ações no mesmo navegador e operações dependentes seguem em ordem. Resultados individuais de leituras paralelas são **persistidos** e a retomada refaz só as faltantes (ver W6/A9). `parallel_tool_calls: true`. |
| L3 | O contexto esquece: só o último grupo de tools fica íntegro, o resto vira 300 caracteres, e o modelo relê | `hygiene.ts:133-220,320` | Resultado grande vira **artefato por referência** (`persistUserArtifact` + `artifact_read`): stub com id, resumo e primeiras linhas. Compactar preservando objetivo, mudanças recentes e evidências; colapsar em lotes, não a cada passo. |
| L4 | O cache quebra todo passo: colapso do grupo anterior, screenshot antiga trocada e `tools` mutadas no meio | `hygiene.ts:320,409`, `computer-use.ts:4509-4544`, `llm/prompt-cache.ts:55-60` | Prefixo estável: colapso em lote, conjunto de tools congelado por fase e breakpoint ajustado. |
| L5 | Prefixo fixo de ~13–15k tokens por passo (prompt de 16 KB + 32 tools nativas, nunca adiadas) | `computer-use.ts:263-497,787-1447` | Prompt do núcleo enxuto; procedimentos e tools carregados por domínio. Estender o índice adiado às tools nativas raras (questionário, rotina, skills, memória, sessão, artifact, create_file). Manter prefixos estáveis e usar o cache existente. Meta: −6–8k tokens/passo. |
| L6 | "Progresso" = qualquer chamada ok, então o limite de passos sempre estende; o hash de screenshot pega ruído de pixel | `progress.ts:95,178,214`, `computer-guard.ts:75` | Manter o detector atual de repetição/alternância (`:95`); `:214` aceita qualquer resultado ok não vazio como ganho. Progresso = **evidência da tarefa** (ids, URLs, hash de conteúdo), não só o hash da screenshot; usar o hash do snapshot de texto. **3** decisões sem ganho → mudar a abordagem; mais **2** → pausar com checkpoint e explicação. |
| L7 | Texto preparatório vira balão próprio e volta ao contexto em todo passo | `computer-use.ts:4793,5884,5931` | Separar decisões internas de comunicação pública: texto preparatório junto de tool calls **não vira outro balão** (ou 1 de status) e não vai ao histórico. Contraprova: o texto preparatório pode aparecer ao vivo sem ser o balão final persistido; separar UI, transcript canônico e estado curto, **sem destruir pares assistant/tool**. Resposta vazia → nudge, não "Não consegui concluir". |
| L8 | Timeouts do LLM: 120 s por tentativa incluindo o stream; sem limite de primeiro token nem de inatividade; retry só no POST; backoff não cancelável; regex `5\d\d` casa qualquer número | `llm/signal.ts`, `llm/chat-tools.ts:243-308`, `llm/config.ts:18-63`, `sandbox/docker-manager.ts:182`, `sandbox/control-client.ts:53,75,95,116`, `worker agent-run.ts:291` | **Prazo total por decisão: 90 s**, até 2 tentativas dentro dele, respeitando o tempo restante do run. **30 s** até o primeiro evento útil e **20 s** de inatividade. Os três valores são **configuráveis e validados por cenário**. Retry de erro dentro do stream, backoff **cancelável**, regex ancorada. Sem retry em erro de privacidade, endpoint incompatível, auth ou cancelamento. **Cancelamento e deadline propagados** até tools, init, download e render: hoje o manager não recebe sinal nas ações (`docker-manager.ts:182`), o control-client usa só timeout próprio e a navegação chega a 120 s (`control-client.ts:53,75,95,116`), e o worker observa cancelamento a cada 2 s (`agent-run.ts:291`). Testar transporte lento e ação não cancelável. Aceite: nenhuma decisão excede o prazo; **cancelamento observado em ≤ 2 s** (chamada, stream, backoff) é distinto de **operação efetivamente encerrada**; abortar HTTP não desfaz efeito externo (ver W9). |
| L9 | `persistCheckpoint` ≥6×/passo + 1 por tool, cada um gravando a conversa inteira (custo quadrático) | `computer-use.ts:5173,5379,5659,5794,5936`, `db/runs.ts:792-820` | 1 gravação por decisão (ou delta). Reidratação por snapshot versionado + cauda de eventos (ver A6). Reaproveita as garantias transacionais atuais (checkpoint e consumo). **Depende de W9/K1:** contratos e journal vêm antes da redução de snapshots. |
| L10 | Muitas idas ao banco em série por passo (`assertRunLease` + findFirst + upsert; cancel/pause/steer separados) | `db/runs.ts appendAgentStep`, `shouldContinue` | Upsert com `ON CONFLICT`, uma leitura só para cancel/pause/lease. Setup do run com `Promise.all` (`agent-run.ts:328-516`); pós-conclusão em paralelo. |
| L11 | Memory review usa o **modelo caro do bot** (até 4 chamadas por run) | `memory-review.ts:212,235` | Modelo de manutenção **independente** do modelo caro do bot: `summarizerModel` (já barato) ou `ATLAS_MAINTENANCE_MODEL`, configurável (ver J10). As chamadas de manutenção (`:235`) ficam fora do deadline/orçamento do run principal: ledger separado. |
| L12 | Jev no caminho crítico. Correção: as consultas iniciais do Jev **já rodam em paralelo** e o stuck **não roda a cada passo** | `computer-use.ts:4368-4399,5798`, `jev/decide.ts:92-117` | Classificações que controlam capacidades ou autonomia **resolvem ANTES da primeira decisão**. `shadow` é assíncrono e **versionado pelo estado**; recomendação obsoleta é descartada. Não usar `shadow` com influência em produção. **Experimento comparativo:** Jev desligado × início/marcos × toda decisão. Contraprova: as chamadas iniciais já são iniciadas antes do await do intent (`computer-use.ts:4368,4387,4392`) e o stuck começa no passo 8 e repete a cada 6 (`jev/stuck.ts:5`). Roteamento completo no bloco J. |
| L13 | Sem estado persistido da tarefa; ao compactar/retomar o objetivo se perde | `hygiene.ts`, `db/runs.ts`, executor principal | **Estado da tarefa persistido**: objetivo, critérios **verificáveis** de conclusão, passo atual, evidências, artefatos e bloqueios; **resultados estruturados** de tool com efeito **conhecido/incerto**; integridade do stream; validação de capacidades no executor principal. O transcript fica como histórico e apresentação, não como única fonte de verdade para êxito, autorização ou efeito. Contrato versionado (K1). Aceite: retomar tarefa de 20 passos sem escrita duplicada. Detalhes em L18–L22. |
| L14 | Contexto limitado só pela janela máxima do modelo | `hygiene.ts`, `computer-use.ts` | **Orçamento operacional de contexto**, independente da janela: alvo inicial **12k** tokens, teto usual **20k**, configurável. Resultado grande vai para artefato por referência. Aceite: contexto usual dentro do teto sem perder a tarefa. |
| L15 | Espera externa, captcha ou tool ausente podem ser tratados como "precisa de modelo premium" **(hipótese)** | `jev/*`, `progress.ts` | Esses casos **não** são classificados como necessidade de modelo premium: viram bloqueio explicado. |
| L16 | A UI não mostra o estado real da atividade **(hipótese)** | `use-atlas-chat.ts`, eventos de run | Atividade pública por estado real: aguardando modelo, executando tool, baixando arquivo, gerando PDF. Inclui **espera externa** (download, aprovação, processo remoto): espera persistida com correlation ID, prazo e wake-up idempotente; a API distingue input recebido de controle aplicado; nenhuma chamada de modelo só para perguntar se um download terminou; não liberar o mesmo desktop enquanto a operação anterior ainda puder agir. Teste de corrida entre conclusão, cancelamento e término da tarefa. Contrato versionado (K1). |
| L17 | Mensagens públicas podem exigir chamada de modelo só para narrar **(hipótese)** | loop `computer-use.ts` | Publicar mensagem só em resultado, bloqueio ou mudança relevante. **Nunca** chamar o modelo só para narrar progresso. |
| L18 | **Falsa conclusão.** Resposta textual sem tool é gravada como `completed` (promessa não prova entrega); `finish_reason` não é conservado e EOF conta como término normal; o verificador de resposta não checa completude | `computer-use.ts:5923`, `worker agent-run.ts:638`, `llm/chat-tools.ts:144,170`, `llm/sse-stream.ts:55`, `jev/answer-verifier.ts:32` | Diferenciar término normal, recusa, truncamento e stream incompleto antes de nudge/retry. Exigir critério verificável por tipo de tarefa (arquivo, efeito, resultado); o JEV não substitui a validação determinística. Testes: "vou gerar o PDF" sem artifact, sucesso parcial, EOF parcial e limite de saída. |
| L19 | O executor principal não valida a disponibilidade da tool (só o subagente valida) e `screenshot_ref` é expandido sem checar visão (`image_ref` checa) | `computer-use.ts:4421,5223`, `checkpoint.ts:132,145`, `llm/chat-tools.ts:23` | Validar a tool contra o conjunto efetivo antes de executar e a visão antes de expandir screenshot (preferir DOM quando bastar). Testes: tool omitida sem invocar o executor; modelo sem visão e catálogo indisponível. |
| L20 | Sucesso reconstruído por prefixo de texto; o erro MCP usa `[Conector]` e a higiene altera o prefixo, então falha pode virar evidência de sucesso após resume | `computer-use.ts:1505,3960`, `hygiene.ts:202` | Persistir status/código/efeito estruturados no resultado da tool. Teste antes/depois de compactação. |
| L21 | Steer que muda materialmente a tarefa não recompila objetivo nem capacidades: a mensagem inicial é congelada e o steer só é anexado; executor e JEV recebem o objetivo inicial. Pode ser fundido com C5 se a implementação ficar melhor | `computer-use.ts:4354,4915,5447,5803,5911` | Distinguir informação adicional de mudança de tarefa e recompilar objetivo/capacidades versionados no segundo caso. Teste: de pesquisa para criação, e steer informacional sem reiniciar. |
| L22 | Sem orçamento de saída/reasoning por decisão; os limites do run só são avaliados depois da chamada | `llm/chat-tools.ts:26` | Orçamento por decisão/capacidade, medindo qualidade; não desabilitar reasoning indiscriminadamente. |
| L23 | Corte de resultado de tool só diz `[truncado: N caracteres]`: o modelo vê parte da lista (215 de 736 registros) e afirma ter conferido tudo | `mcp/call.ts` (`capResultText`), `mcp/builtin/google-api.ts`, `CONNECTOR_ARGS_GUIDANCE` em `computer-use.ts` | Aviso ao modelo com caracteres e, em JSON com array reconhecível, itens mostrados/total, mandando estreitar a consulta ou paginar; linha de prompt neutra sobre paginar antes de concluir. Limites e `hygiene.ts` inalterados. Teste: helper de contagem, aviso no corte e asserção de prompt. Adicionado com aprovação do usuário em 02/10/2026; fase: correção avulsa (fix/aviso-corte-resultado). |
| M1 | **Obsoleto: substituído por `PLANO-SKILLS.md` (aprendizado automático e receitas JSON removidos).** Skills: o runtime grava `tool` running e depois `tool_result` na mesma chave (`computer-use.ts:5382,5578`; `db/runs.ts:970,987` atualiza o type), mas o aprendizado filtra só `tool`, então concluídos somem de `usedTools`. A allowlist não cobre arquivos/MCP, o trigger exige palavras completas e a higiene corta o bloco de skill na metade. Contraprova: o aprendizado é determinístico e com quotas (`skill-learning.ts:26,77,167`), não é chamada premium | `skill-learning.ts:34,104`, `shared/skill-extract.ts:4`, `db/memory-context.ts:24`, `shared/skills.ts:185`, `hygiene.ts:281` | Usar o resultado final estruturado; ampliar para arquivos/MCP referenciando capacidades estáveis resolvidas no catálogo autorizado; **preservar receitas inteiras** (ou resumo com corpo carregável) em vez de cortar no meio. Testes: integrado persistência → fonte → aprendizagem; paráfrases e falsos positivos (recuperação semântica é hipótese). |
| M2 | Memória salva com source genérica e é reinjetada como system, sem distinguir preferência explícita de inferência/documento externo. Contraprova: há filtro de conteúdo inseguro (`memory-entries.ts:188,306,393`), que não comprova origem nem verdade | `computer-use.ts:1634`, `db/memory-context.ts:141`, `memory-review.ts` | Manter origem/evidência; distinguir **preferência explícita** de **inferência externa**. Teste: falsa preferência induzida por página externa. |
| U1 | Mensagens que garantem "nada foi cobrado" sem reconciliação (`agent-run.ts:209`); erros desconhecidos atravessam o SSE sem saneamento uniforme (`agent-run.ts:209,899`) | `agent-run.ts:209,899`, `apps/web` | Não prometer "sem cobrança" sem evidência (conservar custo conhecido/desconhecido e reserva); sanear uniformemente os erros no SSE. Teste: token/URL credenciada no erro sem registrar o conteúdo bruto. |
| U2 | `generate_image` promete edição/referência, mas rejeita qualquer referência | `tools/generate-image.ts:10,14,49` | Implementar a referência ou retirar a promessa e o parâmetro até a capacidade existir. Teste da tool. |

## P1 — API, stream e UI

| # | Problema confirmado | Onde | Correção |
|---|---|---|---|
| A1 | SSE: polling de 80 ms com 3 queries, ou seja **~30–37 queries/s por aba**; sem heartbeat | `api/routes/runs.ts:556-600` | Fase 1: 250–500 ms com backoff ocioso, 1 query combinada e `: ping` a cada 15 s. Fase 2: **fan-out compartilhado por run** com notificação Redis e fallback de polling de 1 s. Banco + cursor `seq` seguem como fonte durável; reconexão recupera eventos sem duplicar. Aceite: SSE ocioso ≤ **2 queries/s por run**, compartilhado entre assinantes; cenários de reconexão, duas abas, cliente lento e Redis fora. |
| A2 | Eventos: cada um é uma transação com advisory lock + `MAX(seq)+1` (~25 tx/s por run) | `db/runs.ts:884-910` | Deltas em lote de até **150 ms ou 4 KB**; eventos de tool, card e done forçam flush ordenado. |
| A3 | Catálogo de modelos sem single-flight nos caminhos síncronos e sem cooldown | `api/routes/models.ts:77-130`, `apps/worker/src/openrouter-models.ts:35` | Promise `inflight` compartilhada (single-flight), cache **stale** em falha e cooldown de 30–60 s, **também no catálogo do worker**. |
| A4 | Trocar modelo com a config aberta faz PATCH imediato, mais um PATCH e um run `config-closed` ao fechar; reselecionar o mesmo também dá PATCH | `template-4-client.tsx:795-808,741,750` | Guard de igualdade e realinhar o snapshot `before` (como o `applyBotProfilePatch`). Sem PATCH vazio nem evento duplicado ao escolher modelo com a config aberta. |
| A5 | **Fundido em C1** | `template-4-client.tsx:703-770` | Ver C1: fechar a config nunca chama o agente. |
| A6 | F5 refaz todos os eventos e **corta silenciosamente após 4.000** | `web/hooks/use-atlas-chat.ts:384-407` | **Snapshot versionado** da transcrição + cauda de eventos a partir do cursor. |
| A7 | A UI mostra o modelo pedido, não o que respondeu (o fallback fica invisível) | `llm/chat-tools.ts:23-28`, badge da web | Gravar o modelo servido no evento de usage; a UI mostra **modelo pedido × efetivamente aplicado** (ver C4). |
| A8 | SSE sem cancelamento de assinatura nem buffer limitado **(hipótese)** | `api/routes/runs.ts` | Cancelar a assinatura ao desconectar, heartbeat de 15 s e buffer limitado para cliente lento. |
| A9 | Memory review sem registro durável **(hipótese)** | `memory-review.ts`, `db` | Registro durável: intenção de manutenção durável, dedup por run, no máximo 2 tentativas, aplicação atômica. Falha de manutenção nunca prejudica a conclusão principal (W6). |
| A10 | Shutdown sem prazo | `api/index.ts:102,253`, `worker/index.ts:436` | Separar `/health` (liveness) de readiness (hoje só devolve success). Shutdown com prazo e checkpoint cooperativo: (hoje a API fecha dependências antes do ingresso e o worker espera sem prazo) **para o ingresso, drena e só então fecha dependências**. Cancelamento/deadline propagados (ver L8). Testar durante create/SSE/render/tool. |
| A11 | Isolar trabalho pesado / aumentar concorrência | worker | **Avaliar só depois de medir** (P2). Concorrência não encurta cadeia de decisões dependentes. |

## P2 — Telemetria (medir antes/depois)
- Por passo: ms do modelo, TTFT, ms de cada tool, overhead, retries, tamanho do prompt e das tools, `cachedTokens` e `cacheWriteTokens` (hoje descartado em `computer-use.ts:4836`). `AgentStep.durationMs` existe mas nunca é preenchido, e `attempts` conta reescrita como tentativa.
- Ligar `onDecision` do Jev (`agent-run.ts:523`).
- Registrar início, fim e duração de: setup, montagem de contexto, modelo, tool, PDF, checkpoint e flush de eventos.
- Registrar TTFT, duração total, tentativas, motivo do retry, modelo pedido × servido, tokens de entrada/saída/cache e custo.
- Preencher `AgentStep.durationMs`; corrigir `attempts` para que terminar uma tool não conte como nova tentativa.
- Medir espera na fila, queries por decisão, event-loop lag e memória de buffers.
- Só metadados, nunca credenciais, imagens nem conteúdo completo de mensagens.

## Jev, roteamento e custo (J) e contratos (K)

Reaproveita o Jev existente: combina a classificação de complexidade com a de intenção/delegação inicial. Começa em **shadow** e só vira ativo após validação. Depende de P2 e de L1–L7 (precisamos saber se a escalada ainda é necessária).

| # | Item | Contrato e aceite |
|---|---|---|
| J1 | Reuso do Jev | Uma única chamada combina complexidade + intenção/delegação inicial (hoje são caminhos separados; o ganho de latência não foi demonstrado: **hipótese**). |
| J2 | Pontos de consulta | No início, em mudança material de fase ou em estagnação comprovada: **máx. 4 por tarefa**, com cache persistido. |
| J3 | Cada consulta | Limite de **2 s**, sem retry, estado resumido e redigido de até **4 KB**. O cliente não lê custo (só tokens, modelo e duração) e o worker não liga `onDecision` (`agent-run.ts:525`): contabilizar o JEV à parte no run raiz; preço/uso desconhecido não é gratuidade. Após **2 falhas seguidas** do Jev, fica no modelo base com recuperação determinística. |
| J4 | Escalada | Limiar **0,8** é **hipótese a calibrar**, não conclusão. Só escala com probabilidade ≥ limiar calibrado, capacidade compatível e orçamento disponível. |
| J5 | Premium pontual | "Premium por **uma** decisão e volta ao barato" é **hipótese a calibrar**. **Máx. 2** chamadas premium (inclui retries e subagentes). Custo contabilizado **separadamente** para Jev, filhos e manutenção. |
| J6 | Teto de custo | Apoio premium até **US$ 0,25 por tarefa** (mantido), subagentes incluídos; Jev, filhos e manutenção contabilizados separadamente. **Reservar o custo antes da chamada**, sob controle atômico do run raiz; custo desconhecido mantém a reserva até reconciliar. Aceite: nenhuma decisão reusa orçamento premium desconhecido; teste de orçamento concorrente com subagentes. |
| J7 | Quando não escalar | Sem preço conhecido, sem modelo premium configurado ou sem endpoint compatível → não escalar. Falha externa não escala (L15). |
| J8 | Restrições preservadas | ZDR, restrições de treino, visão e tools em todo roteamento. |
| J9 | Escolha de provider | Equilíbrio preço/desempenho (provider routing do OpenRouter); preferência de latência é sinal, não garantia. |
| J10 | Modelos configuráveis | Base = escolha do usuário; premium e manutenção são configurações **separadas**; nenhum nome de modelo caro fixo no código. |
| K1 | Contratos versionados | Controle de execução (C2), estado da tarefa (L13: resultados estruturados, efeito conhecido/incerto, critérios verificáveis, `finish_reason`, capacidades/visão), journal de efeitos (W9), roteamento (J) e atividade pública (L16). Quatro responsabilidades propostas (nomes são proposta, não tipos existentes): **TaskState** (objetivo versionado, critérios, fase, bloqueios, artefatos); **CapabilitySnapshot** (tools realmente executáveis, visão, restrições); **ExecutionLedger** (resultado, efeito conhecido/incerto, evidências, custo); **ModelContext** (projeção curta dos anteriores + histórico relevante). O transcript não reconstrói autorização nem sucesso por regex. Inclui a espera externa (L16). |
| K2 | Persistência | Controles de admin, reservas premium e memory review (A9). Follow-ups reaproveitam a reconciliação de runs (W5), **sem segundo outbox**. |

---

## Fora deste plano (fica para depois)
- Issue I1 (stream em lotes): resolvida por A1/A2.
- Execução paralela ampla e isolamento de trabalho pesado: só após medir (A11).

## Ordem de execução (fases)
Dono = `<agente>` (a preencher). Cada fase: worktree `agente-v3/<agente>` a partir de `rodada/desempenho`, commits atômicos com teste no mesmo commit, sem push, métricas antes/depois e plano de rollback. Contexto, eventos e roteamento atrás de **flags**.

| Fase | IDs | Dono | Áreas permitidas | Testes e commits |
|---|---|---|---|---|
| **F0 Instrumentação mínima** (primeiro, para medir o "antes") | P2 (mínimo) | `<agente>` | `packages/agent-runtime` (passos, usage), `packages/llm` (TTFT, modelo servido), `packages/db/src/runs.ts`, `apps/worker` | Teste de `durationMs`/`attempts` e de redação (só metadados). `feat(agent): telemetria por passo e por decisão`. |
| **F1 Segurança** | S1, S2, S3 | `<agente>` | `apps/api/src/routes/{computer,runs}.ts`, rotas de bots/conversas/sessões/sandbox, `packages/sandbox` (posse), `db/{runs,mcp-connections,conversations}.ts`, `chat/parse.ts`, `middleware` | Teste B≠A em cada rota, limites JSON, modo inválido e upload de 9 MB (padrão `scope.test.ts`). `fix(api): ...` |
| **F2 Worker e corretude** | W1–W8, R1 | `<agente>` | `apps/worker/**`, `packages/db/src/runs.ts`, `packages/agent-runtime/src/mcp/**`, `packages/queue` | Reentrega duplicada, corrida heartbeat × reconciler, crash antes/depois de concluir, follow-up e enqueue, checkpoint, `add` da memória, escrita MCP sem retry. `fix(worker)`, `fix(db)`, `fix(mcp)`. |
| **F2b Contratos e journal** (antes de F6) | K1, W9, L13, L18, L19, L20 | `<agente>` | `packages/shared` (contratos), `packages/db/src/runs.ts`, `packages/agent-runtime` (executor, `mcp/call.ts`, `checkpoint.ts`, `hygiene.ts`), `packages/llm` (`finish_reason`, stream) | Crash entre aplicar e registrar não duplica; efeito incerto não é repetido; stream truncado e capacidade/visão validados. `feat(shared)`, `feat(db)`, `fix(agent)`. |
| **F3 Ganho rápido** | L1, L2, L8, L11, L22, A3, U2 | `<agente>` | `packages/agent-runtime` (módulos novos), `packages/llm/**`, `apps/worker/src/processors/memory-review.ts`, `apps/api/src/routes/models.ts`, `apps/worker/src/openrouter-models.ts`, `packages/sandbox` (sinal), `tools/generate-image.ts` | Leitura idêntica deduplicada, leituras paralelas, timeouts, backoff cancelável, single-flight. `perf(agent)`, `fix(llm)`. |
| **F3b Disciplina de execução** (aprovado pelo usuário em 03/10/2026) | L1, L4 (fatia), L6 (primeira fatia), L23 (extensão), K1 (ExecutionLedger, primeira fatia) | `<agente>` | `packages/agent-runtime/src/execution/**` (módulos puros), fiação mínima em `computer-use.ts`, `mcp/{clip-notice,call,read-cache,runtime}.ts`, `hygiene.ts`, `progress.ts`, `checkpoint.ts`, `packages/llm/src/{prompt-cache,chat-tools}.ts`, `packages/shared/src/runs.ts` (tipo), `.env.example` | Camada global (qualquer conector MCP, web, navegador, arquivos; nada específico de conector): resultado idêntico vira referência, chave de leitura sem texto livre, estagnação 3+2 sem novidade, corte com parâmetro de paginação, descoberta redundante, colapso em lote e breakpoint estável. Replay genérico on x off. Flag `ATLAS_EXECUTION_DISCIPLINE=on\|off` (padrão ligada). `feat(agent)`, `feat(mcp)`, `perf(llm)`, `perf(agent)`. |
| **F4 Config e mensagens** | C1–C5 (A5 fundido em C1), L21, A4, A7 | `<agente>` | `apps/web/components/ui/templates/template-4/*` (conferir mudanças do usuário antes), `routes/runs.ts`, `packages/shared` (contrato) | Config no meio da tarefa sem ack; 0 mensagens ao fechar (sem run `config-closed`); troca de modelo na próxima decisão; sem PATCH duplicado. `feat(web)`, `feat(shared)`. |
| **F5 Download → PDF** | D1–D7 (incl. reaper, claim, artefatos) | `<agente>` | `docker/agent-sandbox/**`, `packages/agent-runtime/src/files/**`, `db/artifacts.ts`, `apps/api/src/routes/files.ts`, infra (Chromium, storage) | Download → imagem → PDF com card; outro usuário bloqueado; ≤ 2 decisões. `feat(files)`, `feat(sandbox)`. |
| **F6 Contexto e cache** (depois de F2b) | L3, L4, L5, L9, L10, L14 | `<agente>` | `hygiene.ts`, `llm/prompt-cache.ts`, `db/runs.ts`, módulos novos em `agent-runtime/src` (sem engordar `computer-use.ts`) | Compactação preservando objetivo, artefatos e evidências; retomada de 20 passos. `perf(agent)`, `refactor(agent)`. Flag de contexto. |
| **F7 Loop inteligente** | L6, L7, L12, L15, L16, L17 | `<agente>` | `progress.ts`, `computer-guard.ts`, `computer-use.ts` (loop), `jev/decide.ts` | Estagnação por evidência, texto preparatório sem balão, Jev fora do caminho crítico. `fix(agent)`. |
| **F8 SSE e manutenção** | A1, A2, A6, A8, A9, A10, M1, M2 (A11 só após medir), U1 | `<agente>` | `apps/api/src/routes/runs.ts`, `db/runs.ts`, `apps/web/hooks/use-atlas-chat.ts`, `memory-review.ts`, skill-learn | SSE com reconexão, duas abas, cliente lento e Redis fora; manutenção fora sem afetar a conclusão; skills/memória/mensagens (M1, M2, U1); `/health` × readiness e shutdown com prazo. Flag de eventos. |
| **F9 Jev e custo** (shadow → ativo) | J1–J10, K1, K2 | `<agente>` | `packages/agent-runtime/src/jev/**`, `packages/llm`, `packages/db` (reservas), `packages/shared` (contratos) | Jev indisponível, falha externa sem escalada, orçamento concorrente com subagentes. `feat(agent)`, `feat(db)`. Flag de roteamento; shadow primeiro. |
| **F10 Benchmark** (só depois de capacidades, efeitos e recuperação corrigidos) | critérios de aceite | `<agente>` | scripts de eval | PDF, navegador/download, relatório de pesquisa, MCP e tarefa longa com retomada: sucesso verificável, chamadas, tokens, custo, tempo total, P50/P95. Replays locais sem custo primeiro; eval online opt-in com teto de gasto explícito. |

Dependências: F0 antes de medir F3–F9. F1 e F2 em seguida. **F2b (K1, W9, L13) antes de F6** (reduzir checkpoints). F2 antes de F6. F9 depende de F0 e F7. **F5 não é independente:** depende de F1 (autorização), F2 (recuperação) e infra (Chromium, storage, reaper). F4 é independente das demais. F10 vem depois de corrigir capacidades, efeitos e recuperação.

**Ordem:** F0 (instrumentação mínima) → F1 e F2 → F2b (Contratos e journal) → F3 → F4 → F5 → F6 → F7 → F8 → F9 → F10.

**Preservar** o que já existe: claim, replay, cache, coalescing e reconciliação.

**Metas de tempo e contexto** (< 1 min, 12k/20k tokens, ≤ 10 decisões etc.) são **critérios de experimento**, não ganhos demonstrados.

## Verificação
- Suítes: `pnpm --filter @workspace/shared test`, `@workspace/agent-runtime test`, API/worker (`tsx --test`), `pnpm exec turbo typecheck`.
- Testes novos:
  - IDOR em `/v1/chat/computer`;
  - entrega duplicada do mesmo job, sem execução dupla;
  - checkpoint preservado ao gravar a sessão;
  - `add` da memória;
  - escrita MCP sem retry após timeout;
  - leitura idêntica deduplicada;
  - leituras paralelas;
  - timeout de primeiro token e de inatividade;
  - backoff cancelado em até 2 s.
- **Replay** com LLM e MCP mockados do caso Bling (3 itens), com meta de ≤ ~10 decisões e nenhuma leitura repetida.
- Manual: mesma proposta Bling com o `gpt-6-luna` → concluída em < 1 min; SSE ocioso ≤ 2 queries/s por run (log do Postgres); custo e tempo por passo visíveis na telemetria.

### Regressões obrigatórias
- download → imagem → PDF com a imagem embutida e o card do arquivo entregue;
- mudança de config no meio da tarefa sem perder o objetivo nem repetir ack;
- retomar tarefa de 20 passos sem escrita duplicada;
- corridas entre heartbeat, reconciler e entrega duplicada;
- crash antes/depois de concluir, criar o follow-up e enfileirar;
- cancelamento durante chamada, stream e backoff;
- SSE com reconexão, duas abas, cliente lento e Redis fora;
- PDF, downloads e controles de outro usuário bloqueados;
- contexto compactado preservando objetivo, artefatos e evidências;
- Jev indisponível, falha externa sem escalada, orçamento concorrente com subagentes;
- manutenção fora do ar sem prejudicar a conclusão principal.
- MCP: resposta perdida depois de escrita, polling legítimo, catálogo indisponível e resultado vazio;
- steer material (muda objetivo/capacidade sem perder evidências) × steer informacional (não reinicia);
- falsa conclusão: promessa textual sem entregável, screenshot sem PDF, stream parcial e recusa;
- skills/memória: aprendizagem a partir de resultados finais, receita inteira e falsa preferência de conteúdo externo;
- modelos: econômico sozinho × com apoio pontual, mesmas capacidades, limites e critério verificável;
- JEV: desligado × início/marcos × toda decisão, custo de JEV/filhos/manutenção separado;
- cancelamento: pedido observado, transporte encerrado e efeito externo conhecido/incerto medidos separadamente;
- tarefa longa: 20 etapas, compactação e crash em cada fronteira de efeito/receipt/card, sem duplicar efeito conhecido;
- duas instâncias resolvendo a mesma sessão de sandbox; viewer sem capacidade/expirado; smoke do deployment oficial (worker gera PDF, API baixa, restart preserva);
- erro após geração cobrada (sem prometer "sem cobrança") e erro com token/URL credenciada saneado no SSE;
- duas mensagens somando mais de 4 imagens e colisão só com imagem (W5).

### Critérios de aceite (cenários controlados)
- PDF a partir de imagem disponível: **≤ 2** decisões do modelo.
- Mudança de config de admin: **0** mensagens de confirmação do agente.
- Contexto usual dentro do teto operacional, sem perder a tarefa.
- SSE ocioso: **≤ 2 queries/s por run**, compartilhado entre assinantes.
- Cancelamento observado em **≤ 2 s**.
- Nenhuma decisão excede o prazo nem reusa orçamento premium desconhecido.
- Ações concluídas não se duplicam na recuperação.
- Benchmark (F10) comparando antes/depois.
- Testes locais e replays sem chamadas pagas primeiro; eval online opt-in com teto de gasto. Contexto, eventos e roteamento atrás de flags; Jev começa em shadow. Cada fase com métricas antes/depois e rollback.
- Reportar success@1, consistência entre trials, falso sucesso, correção manual, duplicação, recuperação e custo por conclusão válida, além de P50/P95. Usar fixtures e replays locais primeiro; metas de 12k/20k tokens, < 1 min e ≤ 10 decisões são parâmetros de experimento, não resultados obtidos.

## Mecanismos a preservar
- Checkpoint canônico com imagens por referência, separado do payload enviado ao modelo.
- Claim de execução, replay de tool concluída e reconciliação de runs (API 15 s, worker 60 s); claim seguro de legado.
- MCP discovery/LRU, tools usadas fixadas e gates de autonomia no executor.
- JEV com timeout curto, redação e fallback seguro; a classificação nunca amplia autorização.
- Subagentes read-only herdando dono, autonomia e cancelamento, com reserva para o relatório.
- Higiene que conserva pares assistant/tool, quotas, cache de prompt e coalescing de eventos.
- Cards e artifacts persistidos: recuperar a entrega sem reproduzir a criação do recurso.
- Cache de prompt e `session_id` já enviados: otimizar, não substituir; manter ZDR e restrições de treinamento em fallback/helpers; deadline local independente de preferências de latência do provider.

