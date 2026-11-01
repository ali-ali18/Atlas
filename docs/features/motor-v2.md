# Motor v2 (trabalhador longo), F2 e F3 (parte A)

- **Status:** em andamento (F2 do ADR 0002: laço v2 ao lado do v1, desligado por padrão; F3 parte A: caderno, ajudantes e entrega em documento)
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
| `helperModel` | id do modelo (ex.: `google/gemini-flash`) | o do bot |
| `helperMaxParallel` | 1 a 8 | 4 |
| `reasoningEffort` | previsto (outro branch, `feat/nivel-de-raciocinio`); ainda não existe nesta versão | n/a |

Valor ausente ou inválido cai no padrão. `withBotEngine(policy, "v2")` liga sem perder as outras chaves. Os tetos do run/conta continuam valendo e o perfil nunca os ultrapassa: custo (`budget.maxCostUsd`), tempo (`budget.maxWallMs`, 30 min por padrão no worker: `longWorkMinutes` acima disso só tem efeito se o teto do run/bot for subido) e passos (`maxSteps`/`hardMaxSteps`, 100 por padrão; o teto de segurança do motor é 200).

### Ligar sem SQL (piloto, F4)
- **Engrenagem do bot:** linha Motor (Atual / Novo (teste)), com Orçamento por tarefa longa (US$ e minutos) e Modelo dos ajudantes quando Novo (`chat-context-panel/engine-settings.tsx`). Mescla só as chaves do motor (`withEngineSettings`, `packages/shared/src/engine-settings.ts`).
- **Chat:** tool `set_engine` (`tools/set-engine.ts`; `engine`: `new`/`current`, `budget_usd`, `minutes`, `helper_model`). Só aparece quando a última fala digitada pelo dono pede (mesma trava do `set_autonomy`), nos dois motores; grava com `setBotEngineSettings` (db: relê a linha sob lock, filtro por dono, `null` = bot de outro usuário). Valor fora da faixa ou campo desconhecido falha com a lista do aceito.
- **API:** `PATCH /v1/bots/:id` valida as chaves do motor (`engineSettingsError`) e o modelo dos ajudantes contra o catálogo.
- Medição e roteiro do piloto: `docs/ops/piloto-motor-v2.md`, `docs/ops/motor-v1-vs-v2.md` e `docs/ops/por-que-runs-terminam.sql` (consultas 6 a 11).

## Como funciona
Arquivos em `packages/agent-runtime/src/engine-v2/`:

- `run.ts`: `runEngineV2(params, { profile, longWorkBudgetUsd?, longWorkMinutes? })`. Mesma entrada (`ComputerUseParams`) e mesma saída (`RunComputerUseResult`, com `stop`) do `runComputerUse`. Monta mensagens, chama `streamChat` com as tools, executa cada tool call por `executeTool` (o mesmo caminho do v1: cofre, confirmações, cards, `ToolContext`), repete até o modelo responder sem tools. Lotes só de leitura rodam em paralelo.
- `supervisor.ts` (puro): o único árbitro. Regras abaixo.
- `task-list.ts` (puro): portão da lista de tarefas em trabalho longo.
- `catalog.ts`: núcleo sempre carregado, grupos raros adiados com índice curto no prompt e `mcp_tool_search` para carregar por nome ou necessidade. O roteador de intenção (regex) vira só dica de pré-carga, nunca portão.
- `prompt.ts`: prompt curto (inglês) com persona, memória, conectores, skills e disciplina do modelo vindos dos builders do v1.

O worker (`apps/worker/src/engine-choice.ts`) escolhe o motor no começo do run e grava `engine`/`engineProfile` em `agent_runs.budgetJson` (`recordRunEngine`, só quando é v2; um único `UPDATE` com merge jsonb e condição "ainda sem motor", sem ler-e-escrever). Se a gravação falhar ou outra execução já tiver gravado v1, o run roda no v1: a retomada nunca troca de motor. Modo proativo, alerta, evento de configuração do bot, brief e "só importante" não forçam mais o v1 (ver "Origens além do chat"). A retomada lê o gravado: o motor do bot pode mudar no meio sem trocar um run em andamento. Run com checkpoint e sem motor gravado nasceu no v1.

### Perfis e orçamento
| Perfil | Custo | Tempo ativo | Lista de tarefas |
|---|---|---|---|
| `chat` | US$ 0,25 | 8 min | opcional |
| `long_work` | US$ 0,50 (ajustável) | 20 min (ajustável) | obrigatória |

`auto`: `long_work` quando o pedido parece tarefa (`looksLikeLongTask`: verbo de trabalho + entregável, ou pedido longo); `chat` caso contrário. Tempo é só tempo ativo (pausa de login e fila não contam).

### Regras do Supervisor
1. Antes de cada chamada ao modelo: a ~80% do custo ou do tempo avisa UMA vez ("wrap up and deliver"); a 100% faz a última chamada SEM tools para entregar (resultado, fontes, suposições, o que não deu para confirmar). Nunca aborta sem resposta. Stop: `budget_cost` ou `budget_wall`, detalhe `delivered`.
2. Teto absoluto de 200 passos, só como segurança, e nunca acima do `maxSteps` do run (`budget_steps`, também com entrega).
2b. Custo em US$: o informado pelo provedor; quando ele não informa (`costUnknownCalls`), estima pelos tokens com preço conservador (US$ 3/Mtok de entrada e US$ 15/Mtok de saída, `ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK` e `ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK`; não há tabela de preços por modelo no repositório). Numa retomada, só entra a estimativa dos tokens já gastos se nenhum custo foi informado.
3. Mesma tool + mesmos args + mesmo resultado 3 vezes seguidas: nota ao modelo. Se repetir de novo depois da nota, encerra o laço com a entrega final (`loop_repeat`, detalhe `after_note`).
4. 3 falhas seguidas da mesma tool: nota e a tool fica bloqueada por 3 passos (devolve erro ao modelo sem executar). O run não morre.
5. Não existe teto soft de passos, estagnação, "concluído" declarado pelo modelo, nem tool removida no meio do trabalho.

### Lista de tarefas (trabalho longo)
Reaproveita `update_task_list`. Ao responder sem lista, ou com itens abertos, o modelo recebe uma nota (máx. 2) para concluir ou descartar cada item com motivo. Descartar = marcar `completed` com conteúdo `DROPPED: <motivo>`. Depois de 2 notas deixa sair, e o stop leva `answered` + `tasklist_open`. Itens descartados e pendências aparecem na resposta como "Não deu para confirmar: …" (pt-BR; en/es no idioma do bot).

### Hooks antes da tool
O v2 roda os mesmos hooks do v1 antes de cada tool (`hooks/pre-tool-runner.ts` sobre `runPreToolHooks`): lições do bot (`confirm_always` força o cartão, `required_args`, `require_prior_call`) e bloqueio de escritas com plano pendente (`planPending`), com erro honesto ao modelo e contagem de "ajudou" nas lições.

### Login repetido
Um card de login por site e conversa (30 min), como no v1 (`recentLoginAsks`, `LOGIN STILL REQUIRED`); captcha e login de conector sempre pedem à pessoa.

### Eventos e persistência
Mesmos eventos do contrato: `assistant_delta`, `tool_call`/`tool_result` (mesmo id, com prefixo do run), cards, `task_list`, `input_consumed`, `assistant_discard` (`items_open`). `done`/`error`/`cancelled` continuam sendo emitidos pelo worker com `stopReason`. Passos (`onStep`), `findCompletedTool`/`findStartedTool` (retomada sem repetir escrita) e checkpoint (`buildRuntimeCheckpoint`) seguem o contrato do v1; cancelamento, pausa e pausa por login funcionam igual.

## Trabalho longo (F3 parte A): caderno, ajudantes e documento
Só em `long_work` e só no chat direto de usuário real. Em `chat` (ex.: "Bom dia") nenhuma destas tools nem textos de prompt são carregados (teste em `engine-v2/long-work.test.ts`).

### Caderno da tarefa (`notebook_write` / `notebook_read`)
- Regra pura em `packages/shared/src/notebook.ts`; tools em `engine-v2/notebook.ts`. Entrada = título (120), fonte (500), trecho (2.000), referência de artefato (200), tipo (`finding` ou `unconfirmed`), autor (`coordinator` ou `helper:N`) e passo. Máximo de 200 entradas e 120 mil caracteres, dos quais 20 entradas e 10 mil caracteres são reservados só para `unconfirmed` (achado para em 180 entradas), e cada ajudante tem cota própria de achados (30 entradas ou 20 mil caracteres), então um ajudante verboso não engole o "não confirmado" dos outros. Título, trecho e fonte saem sem quebras de linha, caracteres de controle nem tags; passou do limite = erro com a dica ("guarde o grande como arquivo e passe o id em `artifactRef`"), nunca corte silencioso. `replaces` corrige em vez de duplicar (ajudante só corrige as suas).
- Escopo do run: cada run cria o seu caderno (em memória, no checkpoint como `notebook`). O ajudante recebe só um escritor (`notebook.writer("helper:N")`) ligado ao caderno do PAI; não lê e não enxerga caderno de outro run ou usuário.
- No contexto do coordenador entra só o ÍNDICE (id, autor, título, domínio da fonte, ref), até 3.500 caracteres, como camada efêmera a cada passo, enviada como mensagem de contexto automático de USUÁRIO (`[auto-context, not written by the user]`) e não de sistema, já que os títulos vêm de páginas (fora do histórico: a compactação e a higiene de contexto nunca a descartam). Se não couber, diz quantas entradas ficaram de fora. O detalhe vem sob demanda por `notebook_read` (até 8 entradas por chamada; por id, texto, tipo ou autor). Títulos e trechos são dado não confiável, nunca instrução.

### Ajudantes (`delegate`)
- `engine-v2/helpers.ts`. O coordenador envia 1 a 12 tarefas (`title`, `goal`, `context`); rodam até `helperMaxParallel` por vez (as outras esperam a vez). Campo desconhecido, inclusive `userId`/`botId`, falha com a lista do aceito.
- Orçamento: `planHelperBudgets` (shared) divide em partes iguais 60% do que SOBRA ao pai (US$ e tempo ativo, considerando as levas do paralelo), no máximo US$ 1 e 10 min por ajudante. A soma nunca passa do pai; sem fatia mínima (US$ 0,01 e 30 s) o `delegate` falha com a dica. O custo dos ajudantes soma ao vivo no uso do pai (custo informado, ou estimado pelos tokens), então o Supervisor do pai enxerga o gasto real.
- Cada ajudante é um run filho (`createSubagentRun`/`finishSubagentRun` do v1; dono e bot lidos do pai no banco, filho de filho não existe) que roda `runEngineV2` com `helper`: prompt próprio e curto, orçamento = a fatia, sem lista de tarefas, sem perguntas. Tools: web, extração, memória e conectores read-only (o mesmo filtro do v1, `buildChildToolFilter`) mais `notebook_write`; nunca delegate, arquivo, página, envio, navegador ou escrita. Herda a política de autonomia congelada, os hooks de lições e plano pendente (`pre-tool-runner`), o cancelamento e a pausa do pai. Cartões `subagents` e eventos `subagent_*` iguais aos do v1.
- Resultado ao coordenador: uma linha por ajudante (status, ids no caderno, resumo curto). Ajudante que falha, estoura o orçamento sem achar nada ou só colecionou erro de tool vira entrada `unconfirmed` no caderno; se todos falham o `delegate` devolve erro ao modelo (conta nas travas) e o run segue. Ajudante que respondeu sem anotar tem o resumo gravado no caderno. Se até a reserva estiver cheia, o resultado do `delegate` lista ao coordenador o que não deu para confirmar e não coube no caderno. Cada ajudante que termina grava o checkpoint do pai (caderno, `usageTotals` e `helperRuns`, os ids já somados); na retomada o custo dos filhos que terminaram depois do último checkpoint entra uma vez (lido dos runs filhos, escopado pelo dono) e as tarefas que eles já fizeram não rodam de novo.
- `helperModel`: se o bot define e o id é conhecido, os ajudantes usam esse modelo; desconhecido cai no do pai com um aviso no resultado.

### Entrega em documento
- `engine-v2/delivery.ts`. Ao final, se a resposta passa de 1.500 palavras, ou o pedido fala de relatório/estudo/análise e há caderno (ou texto de 300+ palavras), e nenhum arquivo saiu, o rascunho é retirado do chat (`assistant_discard`, motivo `missing_file`) e o modelo recebe a instrução de gerar o documento com `create_file` (PDF/DOCX/MD, em partes se grande). No máximo uma vez por run. O portão não age se o usuário pediu a resposta no chat ("aqui no chat", "sem PDF", "não precisa de arquivo") e resposta curta nunca vira documento só porque há caderno (mínimo de 300 palavras fora do caso das 1.500). O texto retirado fica guardado: se o run terminar sem arquivo (create_file falhou, limite de arquivos, modelo respondeu curto), o texto original volta ao chat no lugar.
- O runtime acrescenta ao conteúdo do documento (pdf, docx, md, txt; só na última parte) as seções "Fontes" (URLs do caderno que o arquivo inteiro, partes anteriores incluídas, não cita) e "Não deu para confirmar" (todas as entradas `unconfirmed`), no idioma do bot. O apêndice cabe no limite do arquivo: o que não couber vira "… e mais N fontes". Resumo, achados, tabela e suposições são do modelo.
- `create_file` já vem carregado em `long_work`. Teto de saída: 16.000 tokens (`ATLAS_V2_DOC_MAX_OUTPUT_TOKENS`) só nos passos em que o coordenador escreve o documento (portão já agiu, arquivo em partes aberto ou lista de tarefas toda concluída), limitado ao máximo de saída do modelo no catálogo quando ele é conhecido; sem catálogo, vale o valor configurado. Os demais passos e a conversa curta mantêm o configurado.

### Riscos e limites desta parte
- Retomada no meio de um `delegate`: só os ajudantes que não terminaram rodam de novo (os órfãos são fechados como falha); o trabalho dos que terminaram não se perde nem se refaz. O que um ajudante gastou antes de cair, sem terminar, não é recuperável do banco.
- O ajudante é de leitura: não usa navegador nem login. Fonte que só abre logada vira "não confirmado".
- Documento gerado só quando `create_file` está disponível; no estouro de orçamento de quem pediu documento a última etapa libera só `create_file` (ver "Reserva de entrega"), senão a resposta sai em texto.
- O índice só mostra título e fonte; um título escrito pela página (via modelo) é dado, e o prompt do índice diz isso. Custo: o índice soma até ~900 tokens por passo quando o caderno está cheio.
- Ainda de fora (F3 parte B): resumo de compactação, as 4 memórias, raciocínio controlável e `track_items`.

## Origens além do chat (F5, preparação; desligado por padrão)
Por padrão nada muda: o v2 roda só no chat direto de um bot com `engine: "v2"`. Dois botões, ambos desligados:

| Botão | Onde | Efeito |
|---|---|---|
| `policyJson.engineScope` | por bot (engrenagem: "Usar também em rotinas e grupos"; chat: `set_engine` com `scope`) | `"chat"` (padrão) ou `"all"`. Com `engine: "v2"` e `"all"`: rotina, grupo (run de membro) e bot→bot rodam no v2 |
| `ATLAS_ENGINE_V2_DEFAULT` | env do worker | `off` (padrão), `chat` ou `all`. Vale só para bot SEM `policyJson.engine` explícito. `engine: "v1"` explícito nunca vai ao v2 |

Decisão pura em `shared` (`resolveBotEngineRouting`, `engineV2SupportsRun`, `chooseRunEngine`); o worker só lê o env (`engineDefaultFromEnv`) e passa. O motor gravado em `budgetJson.engine` continua vencendo (retomada).

**Origens liberadas no escopo `all`:** `routine` (inclui alerta, brief "Seu dia" e rotina "só importante"), grupo (`chat` com `isGroupRun`), `bot`, `proactive` (reflexão e lembrete do bot), `webhook` e `email` (e-mail recebido). O evento de configuração do bot e o chat com modo proativo ligado são `chat`, então já valem no escopo `chat`.
**Ficam no v1, sempre:**
- subagente: não é run do worker; o filho do `delegate_task` roda dentro do pai e herda o motor dele (o pai no v2 usa os ajudantes do `delegate`, outro mecanismo);
- tools sensíveis (`set_engine`, perfil) seguem só no chat com o dono digitando.

**Proativo, alerta, brief, "só importante" e evento de configuração no v2 (paridade com o v1).** O worker não força mais o v1 para nenhum deles (`mustStayOnV1` saiu). O catálogo do v2 expõe as mesmas tools, nas mesmas condições e com os mesmos executores do registro (`engine-v2/catalog.ts`, `run.ts`); o que o worker já passava (`proactive`, `userPush`, `alertRun`) agora chega ao contexto da tool:

| Origem | Tools no v2 | Nota ao modelo (só nesse run) |
|---|---|---|
| Chat do bot principal com modo proativo ligado | `schedule_followup`, `list_followups`, `cancel_followup`, `reschedule_followup`, `suggest_routine` | seção "Proactive mode (on)" |
| Lembrete (origem `proactive`, com conversa) | `schedule_followup`, `list_followups`, `cancel_followup`, `reschedule_followup` | nenhuma (o pedido do lembrete já traz tudo) |
| Reflexão diária (origem `proactive`, sem conversa) | `schedule_followup`, `list_followups`, `suggest_routine`, `notify_user` (com Jev, silêncio e teto no servidor) | nenhuma |
| Rotina "só importante" e chat (aviso no meio de tarefa longa) | `notify_user` só-push (uma vez por run, respeita o silêncio) | rotina: "notify only when something matters" |
| Rotina de alerta | `report_alert`; o veredito fica no estado que o worker lê depois (debounce e aviso são do worker) | nota do alerta (condição e dica) |
| Brief "Seu dia" | só o que o `briefToolFilter` libera (leitura); sem `notify_user`, arquivos nem rotinas | a instrução do brief já vem nas mensagens |
| Evento de configuração do bot | `propose_questionnaire`, `propose_profile_update`, `memory` (a rede de segurança injeta a instrução do evento se o chamador não pôs) | instrução do evento |

As notas ficam em `engine-v2/origin-notes.ts` e entram como mensagens de sistema extras, só no run que precisa: o prompt do chat comum (sem proativo, push ou alerta) não muda, e "Bom dia" continua com um prompt só. Alerta, brief, reflexão/lembrete e evento de configuração rodam sempre no perfil `chat` (`shortRun` no worker), mesmo que o pedido pareça relatório ou o bot force `long_work`, porque a tool de caderno/documento nem existe nessas origens. Provas: `engine-v2/proativo.test.ts` roda o MESMO roteiro e as mesmas expectativas no v1 e no v2 (tools por origem, prompts, execução real, tetos, silêncio, Jev, dedupe, veredito do alerta, brief só leitura); `apps/worker/src/integration/proativo.integration.ts` compara, com Postgres real, o que fica no banco (estado do alerta, mensagens na conversa, follow-ups, eventos proativos, pushes) nos dois motores.

**Mudança de comportamento aceita (o v2 é o único motor no destino).**
- **Chat com proativo e evento de configuração migram.** Antes o worker forçava o v1 nesses dois casos mesmo com `engine: "v2"` no escopo `chat`. Agora o chat do bot principal com modo proativo ligado e o evento de configuração do bot (origem `chat`) rodam no v2 se o bot tem `engine: "v2"` (qualquer escopo) ou o deploy tem `ATLAS_ENGINE_V2_DEFAULT=chat`. Sem chave, v1. Reverter: `engine: "v1"` no bot ou `ATLAS_ENGINE_V2_DEFAULT=off`. Cobertura: `apps/worker/src/engine-choice.test.ts`.
- **`notify_user` em todo chat v2.** Com o aviso de chat (`userPush: {mode:"chat"}`) o v2 expõe `notify_user` no chat, como o v1. O que muda em "Bom dia": só o schema dessa tool (o prompt de sistema é idêntico). Cobertura: `engine-v2/proativo.test.ts` ("caso real do worker").
- **Orçamento do brief e do lembrete `check`.** `shortRun` fixa o perfil `chat` (US$ 0,25 / 8 min) em alerta, evento de configuração, brief e `check`. Para brief e `check` o v2 aplica um piso (`budgetFloor`, `engine-choice.ts`): custo = `longWorkBudgetUsd` do bot (padrão US$ 0,50) e tempo = max(`longWorkMinutes` do bot, 30 min), onde 30 min é `BUDGET_WALL_DEFAULT_MS`, o teto de relógio que o v1 aplica a essas execuções (o v1 não tem teto de custo por padrão). O perfil continua `chat`: sem lista de tarefas obrigatória nem entrega em documento. Tetos de custo e tempo da conta/bot continuam valendo por cima. Cobertura: `engine-v2/supervisor.test.ts` e `engine-choice.test.ts`.
- **`find_page_value`:** o teto de 3 buscas por run passou a valer no v2 (`engine-v2/page-value.test.ts`).

**Verificação por origem (v1 x v2) e lacunas fechadas** (`engine-v2/catalog.ts`, `prompt.ts`, `login.ts`, `run.ts`; testes em `engine-v2/origens.test.ts` e `apps/worker/src/integration/origens.integration.ts`):
- Rotina: o v2 não filtrava nada por origem. Agora usa a mesma lista de exclusão do v1 (`tools/routine-excluded.ts`: gestão de rotinas, `web_search`/`web_extract`, `memory`, `secret_request`), sem `sandbox_release`, sem lista de tarefas, imagem, painéis e conector de API (só chat). Conector: só o que a autonomia libera sem perguntar (o filtro de `unattended` já vinha do carregamento no worker; o catálogo agora repete a regra). "MCP read-only" aqui significa isso: com autonomia total o dono liberou escrita, igual ao v1. Sem humano o prompt traz o modo execução de rotina e "Unattended run": não perguntar, não esperar aprovação nem login. Login sem humano vira nota ao modelo (sem cartão nem pausa); captcha e login de conector seguem pedindo à pessoa, como no v1. Painel da rotina: só `page_read`/`page_update` do painel dela, com `routinePageId` no contexto da tool (o v2 não o repassava: poderia atualizar outro painel do dono). Perfil de trabalho: o mesmo `resolveRunProfile` (`long_work` quando o pedido da rotina é relatório/levantamento, senão `chat`). Entrega, `routineId` + run e `stopReason` vêm do worker, igual ao v1.
- Grupo: o run de membro é `chat` com `isGroupRun`; cartões, aceite automático do principal (`autoDecideGroupPending`), cobrança única e resumo são do db/worker e valem para os dois motores (o v2 grava o mesmo cartão `confirm` e para em `awaiting_confirmation`). Menções e "quem fala" vêm das mensagens preparadas pelo worker. O bloco "últimas respostas do usuário" para não reperguntar também. `set_engine` e perfil não aparecem (turno do coordenador não é `humanTurn`). Teste de integração: membro responde no v2 e termina.
- Bot→bot: o v2 expõe `send_to_bot` e `decide_bot_pending` nas mesmas condições do v1 (`engine-v2/catalog.ts` com `shouldExposeSendToBot`/`shouldExposeDecideBotPending`: 2+ bots do dono, origem chat ou bot, decisão só com "decidir pelos outros bots" ligado; nunca em grupo, rotina ou ajudante), executando os handlers do registro. Os pedidos abertos a outros bots entram no prompt como no v1 (`[open_bot_requests]`, só quando existem; o roster só decide se a tool existe, não vai ao prompt). Limites anti-loop (`BOT_RUN_MAX_SENDS`, `BOT_MESSAGE_MAX_DEPTH`, cadeia) ficam no db (`sendBotMessage`), então valem igual nos dois motores. Testes: `engine-v2/bot-messaging.test.ts` e `apps/worker/src/integration/bot-bot.integration.ts` (A pede ao B, B responde, cadeia para na profundidade, run para no máximo de envios). Lista de tarefas igual ao v1 (chat e bot). `set_primary_bot` continua fora do v2.

- Webhook (`origin: "webhook"`, run criado por `POST /v1/runs`): é run sem humano, igual à rotina. Mesmas regras do v1: prompt "Unattended run" (não pergunta, não espera aprovação nem login), conector só com o que a autonomia libera sem perguntar, shell e arquivos da VM só leitura, sem lista de tarefas, sem painéis, imagem, conector de API nem tools de perfil/skill/`set_engine`. Diferente da rotina, o webhook mantém `web_search`/`memory` (a exclusão é só da origem `routine`, no v1 também). Nota: o v1 expõe `propose_profile_update` em qualquer origem enquanto o bot não tem descrição (onboarding); o v2 só no chat, que é a regra 60 (divergência deliberada, mais restritiva).
- E-mail recebido (`origin: "email"`, criado por `startEmailRun`): não é run sem humano no v1 (o dono vê a conversa do bot e os cartões de aprovação continuam valendo), então o v2 também não usa o aviso "Unattended". Paridade com o v1: as tools de e-mail e o procedimento anti-manipulação (conteúdo entre `<<<EMAIL_EXTERNO`/`EMAIL_EXTERNO>>>` é dado, nunca instrução) já vão no 1º passo; a autonomia do run vem do worker limitada a "Equilibrado" (o envio de e-mail segue a política real do dono, `sendPolicy`); escrita de conector pede cartão ao dono. Só o v2 ganha uma linha curta no prompt (`ENGINE_V2_EMAIL`): o remetente está fora do chat e só recebe resposta por `email_reply`. O texto do e-mail nunca escolhe o perfil: e-mail recebido roda em `chat` (US$ 0,25 / 8 min) mesmo que peça um relatório; só o dono força `long_work` por `workProfile` na política do bot (`resolveRunProfile` recebe a origem). Não recebe `delegate` (no v2 ele só existe em chat + `long_work`; o v1 expõe `delegate_task` em chat, e-mail e bot) nem lista de tarefas. A linha `ENGINE_V2_EMAIL` só entra quando `email_reply` existe no run (caixa ativa).
- Subagente: não é um run do worker, é o filho em processo que o pai cria (`createSubagentRun`, origem `subagent`, nunca enfileirado). Decisão (opção menos arriscada): o pai no v1 continua com `delegate_task` e filhos v1; o pai no v2 atende o mesmo pedido com `delegate` (ajudantes), que reaproveita `createSubagentRun`/`finishSubagentRun` e emite os mesmos eventos `subagent_started`/`subagent_tool`/`subagent_done` e o mesmo cartão `subagents` persistido, então o usuário vê o mesmo resultado. Não há roteamento a fazer: `engineV2SupportsRun` continua devolvendo `false` para a origem `subagent` como proteção, e o filho herda o motor do pai. Teste de integração compara os dois (dois filhos `subagent`, cartão e eventos iguais). Limite: no v2 o `delegate` só existe em `long_work` (precisa do caderno) e no chat direto; um pedido de comparação curto no perfil `chat` não paraleliza (ver Limites).

**Riscos e custo.** Rotina em `long_work` tem caderno, documento e orçamento de US$ 0,50 / 20 min (ajustável), então uma rotina de relatório pode custar mais que no v1; rotina curta fica em `chat` (US$ 0,25 / 8 min). `ATLAS_ENGINE_V2_DEFAULT=all` muda TODOS os bots sem escolha: ligue primeiro `chat`, meça, depois `all`. A engrenagem mostra "Atual" para bot sem escolha mesmo com o padrão global ligado (a UI não conhece a variável); escolher "Novo" e voltar a "Atual" grava `engine: "v1"` explícito. Desligar: tire o escopo do bot, ponha `ATLAS_ENGINE_V2_DEFAULT=off` e reinicie o worker; run em andamento termina no motor em que começou.

## Orçamento do bot, reserva de entrega e "continuar com mais orçamento"

### O orçamento do bot vence no trabalho longo
No perfil `long_work`, `longWorkBudgetUsd` e `longWorkMinutes` gravados no bot valem mais que o teto por execução da conta (`execution.maxRunCostUsd`, padrão 0,25): antes o `min` entre os dois transformava o US$ 1 do bot em US$ 0,50 (`policyJson` lido por `readEnginePolicy`, que agora diz se o valor foi gravado: `longWorkBudgetExplicit` / `longWorkMinutesExplicit`). Sem valor no bot, ou no chat curto, nada muda: a conta limita. O teto do pedido (retomada automática com o que sobrou) continua valendo. Regra em `longWorkOwnerLimits` (`apps/worker/src/engine-choice.ts`).

### Reserva de entrega (25%)
- Pesquisa e ajudantes só gastam o orçamento menos 25% (custo e tempo): `supervisor.researchRemaining` alimenta o `planHelperBudgets`. Depois do limite o `delegate` falha com a dica de que não há mais orçamento de pesquisa.
- A 75% o supervisor manda (uma vez) parar de pesquisar e escrever a entrega agora, com o que há no caderno. Se o caderno tem entradas `unconfirmed`, abre antes uma **rodada de lacunas**: 40% da reserva (75% a 85% do orçamento) para tentar fechar cada uma com outra fonte, busca ou leitura direta do arquivo/repositório, atualizando o caderno com `replaces`; os 60% finais (a partir de 85%) são só da escrita, com um segundo aviso. Se um passo grande pula a janela, vai direto escrever. Chat curto mantém o aviso único a 80%.
- No estouro (100%) de quem pediu documento, a última chamada libera só `create_file` (até 3 passos), depois fecha o chat sem tools; a nota de fechamento fica em "uma nota curta no fim". Se nem assim sair o arquivo, a resposta diz em pt-BR simples que não deu para gerar o documento dentro do orçamento e oferece continuar.
- O que continua não confirmado entra numa nota curta no fim do documento ("Não deu para confirmar", até 6 linhas enxutas, o resto vira "… e mais N"); a instrução de entrega pede para não espalhar "não confirmado" item a item no corpo.
- Não desistir no primeiro bloqueio: `web_extract` que falha (bloqueio, robots, erro de leitura) devolve a alternativa (outra fonte, versão bruta do repositório); página cortada traz `nextStep` (uma URL por chamada com `maxChars` até 20000, ou buscar o termo). A tool não tem `offset`.

**Reserva de verdade (não só aviso).** Depois dos 75% a lista de tools muda por fase (`supervisor.allowedTools`): `lacunas` (75% a 85%, só se há itens não confirmados) = `web_search`, `web_extract`, caderno, `create_file`, lista de tarefas; `escrita` (85%, ou 75% sem lacunas) = só `create_file`, caderno e lista. `delegate` e a pesquisa saem das tools oferecidas e, se o modelo ainda as chamar, voltam como erro sem rodar. Dois passos seguidos só com tool barrada = o supervisor entrega (documento no estouro).
**Teto duro do extra no estouro.** O fallback de documento (`create_file`, até 3 passos, com o teto de saída do documento e 240 s por chamada) só começa um passo novo enquanto o gasto estiver abaixo de X * 1,10 (US$ e tempo; `DOCUMENT_OVERSHOOT_RATIO`); dentro do passo a saída máxima é cortada ao saldo até X * 1,10 convertido pelo preço de saída (conservador, US$ 15/Mtok, ou o do modelo quando `modelOutputUsdPerMtok` o informa), com mínimo útil de 2.000 tokens (`DOCUMENT_MIN_OUTPUT_TOKENS`, a única folga possível; abaixo disso o arquivo sairia truncado e inútil); `maxCostUsd` indefinido ou NaN cai no orçamento padrão do trabalho longo e nunca desliga a guarda; o fechamento sem tools é uma chamada curta que sempre acontece. Só a última parte de um entregável (pdf, docx, md, txt, html, pptx, xlsx) conta como "documento entregue"; parte de arquivo em partes e arquivo auxiliar (csv, imagem, json, código) não.
**Quem recebe o orçamento do bot.** A regra "o orçamento do bot vence a conta" vale só no chat com o dono digitando (origem chat e turno humano) e na continuação que o dono aprovou pelo card (marca `approvedContinuation` no `budgetJson`, gravada só pelo db na aprovação; `POST /v1/runs` só aceita campos de orçamento conhecidos, então a marca não vem do corpo; o valor do card vence a conta em custo e em tempo, sem abrir `set_engine` nem perfil); rotina, bot→bot, webhook e e-mail ficam com o teto da conta (`resolveRunLimits`). A orientação extra do `web_extract` (outra fonte, versão bruta, ler o resto) vale só no trabalho longo do v2 (`ToolContext.longWork`).

### Continuar com mais orçamento (card, regra de dinheiro)
Quando um trabalho longo do v2 no chat termina por custo ou tempo (`budget_cost` / `budget_wall`), o fim do run grava o card **"Continuar pesquisa (+US$ X)"** (X = orçamento do bot, ou o teto que valeu no run, o menor).
- **Decisão (menor risco):** não reaproveitei a retomada automática (`auto-continue.ts`) porque ela é automática e só para teto de passos (nunca para custo/tempo, de propósito), nem o fluxo de confirmação de ferramenta, que depende de uma chamada pendente. O card segue o molde dos cards de proposta (`bot-proposal`): card persistido + rota de resolver + `RequestCard`. Nada roda sem o toque do dono.
- `POST /v1/cards/budget-continue/resolve` (`{ conversationId, offerId, decision: "approved" | "dismissed" }`): o valor e o run de origem são os GRAVADOS no card (o corpo não traz valor). Aprovar reserva o card por troca condicional (toque duplo cria um run só) e cria o run com `createAgentRun({ exclusive })`: o run é silencioso (`silent`, `clientKey` estável), com `budget.maxCostUsd` igual ao do card, e motor, perfil, `continuationOf`/`continuationOffer`, o caderno do run que parou e a lista de tarefas aberta (como num estado novo) entram no MESMO create. Se outra tarefa ocupar a conversa entre a checagem e o create, nada é mesclado nem sobrescrito: `ExclusiveRunConflictError`, 409 e o card volta a pendente. Se algo falhar depois do create, o run da fila é cancelado; se só o card falhar em gravar, a próxima tentativa reaproveita o run em vez de criar outro. Oferta com mais de 24h ou que não seja a mais recente da conversa responde 410 amigável e o card vira "Dispensado". A mensagem do run é o pedido original + a instrução de continuar sem refazer.
- Identidade estável `continue-<runId>`: o card ao vivo (evento SSE `budget-continue`) e o persistido colapsam num só (`thread-merge.ts`). Fica entre a pergunta e a resposta final, como os demais cards.
- Conversa, card ou run de outro dono = 404. "Agora não" só marca o card; sem aprovação nada é gasto.
- Limite conhecido: o card não aparece em rotina, grupo ou bot→bot (sem humano olhando); depois de aprovar, a continuação é seguida pelo mecanismo comum de run ativo da conversa.

## Limites desta fase (o que o v2 ainda não faz)
- **Origens:** por padrão só o chat direto do dono com o bot. Rotina (inclui alerta, brief e "só importante"), grupo, bot→bot, proativo, webhook e e-mail recebido só com `engineScope: "all"` (ou o padrão global `all`), ver acima. Só o subagente segue no v1.
- **Padrão global invisível:** `describeEngineSettings`, a engrenagem e `set_engine` leem só o `policyJson`; com `ATLAS_ENGINE_V2_DEFAULT` ligado, bot sem escolha aparece como "motor atual" mas roda no v2. Bot que voltou ao v1 antes desta fase (chave removida, sem `engine: "v1"`) também é pego pelo padrão global: regrave "Atual" antes de ligar.
- **Rotina em trabalho longo:** instrução de relatório vira `long_work` (orçamento e documento), sem lista de tarefas (a rotina não tem `update_task_list`; o prompt não a cita).
- **Subagentes só em trabalho longo:** `delegate` (o equivalente do `delegate_task`) exige o caderno do `long_work` e o chat direto; em `chat` (conversa curta) e nas outras origens (e-mail, bot, rotina, grupo) o v2 não paraleliza, enquanto o v1 oferece `delegate_task` em chat, e-mail e bot. Quem quer ajudantes em todo pedido força `workProfile: "long_work"` no bot.
- **Tools fora do catálogo do v2:** `delegate_task` (no v2 o equivalente é `delegate`, ver acima), `research_note` (no v2 vale o caderno), `track_items`, `propose_plan`, `read_cached_result`, sessão de código (`dev_*`), `set_primary_bot`, `set_autonomy`, lições de conector, prévia completa.
- **Login:** o card de login é sempre humano (sem preenchimento automático do Cofre nem retomada com item do Cofre); o `login_fill` por tool continua.
- **Modo proativo e avisos:** cobertos (ver acima). Diferenças conhecidas: o modo proativo e o `notify_user` ocupam o catálogo sempre carregado (como no v1, são núcleo, não grupo lazy); um chat com modo proativo ligado não segue o idioma da mensagem no modo "auto" (igual ao v1: vale o último idioma detectado).
- **Estimativa de custo:** conservadora e única para todos os modelos; modelos baratos sem custo informado chegam ao teto antes do real.
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
- `pnpm --filter @workspace/shared test` (`engine-policy.test.ts`, `notebook.test.ts`, `engine-helpers.test.ts`).
- `pnpm --filter @workspace/agent-runtime test` (`engine-v2/supervisor.test.ts`, `task-list.test.ts`, `run.test.ts`: replay de pesquisa com 30 leituras sem corte, "Bom dia" barato, aviso a 80% e entrega sem tools, repetição, falhas, lista de tarefas, retomada); `engine-v2/long-work.test.ts` (caderno: índice compacto, limites, checkpoint e retomada; ajudantes: paralelo, orçamento repartido, falha que não mata o pai, só leitura, escopo, hooks; replay "pesquisa de mercado com 5 fornecedores" com documento), `delivery.test.ts`, `notebook.test.ts`.
- Worker: `cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts` (bot sem policy → v1; policy v2 → v2; retomada respeita o gravado; proativo no escopo `all`; `shortRun` fixa o perfil `chat`).
- Paridade do proativo/alerta/brief: `engine-v2/proativo.test.ts` (agent-runtime) e `ATLAS_TEST_DB_URL=... pnpm --filter worker test:integration` (`proativo.integration.ts`).
