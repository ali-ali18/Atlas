# Motor v2 (trabalhador longo), F2 e F3 (parte A)

- **Status:** em andamento (F2 do ADR 0002: laço v2 ao lado do v1; **v2 é o padrão de todo bot sem escolha explícita desde 01/11**; F3 parte A: caderno, ajudantes e entrega em documento). **Atualizado em 03/11:** laço sem fases e sem regex de comportamento (seção "O laço hoje").
- **Data:** 2026-11-01 (revisado em 2026-11-03)
- **Issues/PRs:** ADR `docs/adr/0002-motor-v2-trabalhador-longo.md`, `docs/adr/0003-sem-orcamento-de-tempo-padrao.md` (e o adendo de 03/11)

## O que é
Um segundo motor para o bot. Em vez de parar no meio e perguntar demais, o bot trabalha até entregar. **Não há limite de tempo nem de gasto por padrão** (ADR 0003): só vale o teto que o dono configurou de propósito. **Decisão do dono (01/11): o motor novo (v2) é o padrão** de todo bot que não escolheu o motor, em todas as origens suportadas (chat, rotina, grupo, bot→bot, proativo, webhook e e-mail; o subagente herda o motor do pai). O motor anterior (v1) continua existindo para quem o escolher ("Anterior" na engrenagem, `set_engine` com `current`, que grava `engine: "v1"`) e como botão de emergência do deploy (`ATLAS_ENGINE_V2_DEFAULT=off`, que desliga o motor novo para todos os bots).

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
| `engine` | `"v1"` \| `"v2"` | ausente = motor novo (padrão, `ENGINE_DEFAULT_SCOPE` = `all`); `"v1"` explícito = motor anterior |
| `workProfile` | `"auto"` \| `"chat"` \| `"long_work"` | `"auto"` (decide pelo pedido) |
| `longWorkBudgetUsd` | **opcional**: gasto máximo por tarefa longa, US$ 0,05 a 20 (vazio = sem limite em US$) | sem limite |
| `longWorkMinutes` | tempo máximo da tarefa longa, 1 a 180 | 60 |
| `helperModel` | id do modelo (ex.: `google/gemini-flash`) | o do bot |
| `helperMaxParallel` | 1 a 8 | 4 |
| `reasoningEffort` | previsto (outro branch, `feat/nivel-de-raciocinio`); ainda não existe nesta versão | n/a |

Valor ausente ou inválido cai no padrão (para `engine`, o motor novo). `withBotEngine(policy, "v2")` liga sem perder as outras chaves. Os tetos do run/conta continuam valendo e o perfil nunca os ultrapassa: custo (`budget.maxCostUsd`), tempo (`budget.maxWallMs`, 30 min por padrão no worker: `longWorkMinutes` acima disso só tem efeito se o teto do run/bot for subido) e passos (`maxSteps`/`hardMaxSteps`, 100 por padrão; o teto de segurança do motor é 200).

### Ligar sem SQL (piloto, F4)
- **Engrenagem do bot:** linha Motor (Anterior / Novo (padrão)), com Orçamento por tarefa longa (US$ e minutos) e Modelo dos ajudantes quando Novo (`chat-context-panel/engine-settings.tsx`). Mescla só as chaves do motor (`withEngineSettings`, `packages/shared/src/engine-settings.ts`).
- **Chat:** tool `set_engine` (`tools/set-engine.ts`; `engine`: `new`/`current`, `budget_usd`, `minutes`, `helper_model`). Só aparece quando a última fala digitada pelo dono pede (mesma trava do `set_autonomy`), nos dois motores; grava com `setBotEngineSettings` (db: relê a linha sob lock, filtro por dono, `null` = bot de outro usuário). Valor fora da faixa ou campo desconhecido falha com a lista do aceito.
- **API:** `PATCH /v1/bots/:id` valida as chaves do motor (`engineSettingsError`) e o modelo dos ajudantes contra o catálogo.
- Medição e roteiro do piloto: `docs/ops/piloto-motor-v2.md`, `docs/ops/motor-v1-vs-v2.md` e `docs/ops/por-que-runs-terminam.sql` (consultas 6 a 11).

## Como funciona
Arquivos em `packages/agent-runtime/src/engine-v2/`:

- `run.ts`: `runEngineV2(params, { profile, longWorkBudgetUsd?, longWorkMinutes? })`. Mesma entrada (`ComputerUseParams`) e mesma saída (`RunComputerUseResult`, com `stop`) do `runComputerUse`. Monta mensagens, chama `streamChat` com as tools, executa cada tool call por `executeTool` (o mesmo caminho do v1: cofre, confirmações, cards, `ToolContext`), repete até o modelo responder sem tools. Lotes só de leitura rodam em paralelo.
- `supervisor.ts` (puro): tetos que o dono configurou, notas de repetição, falha e estagnação, e os dois abortos que restam (`loop_repeat`, `tool_failures`). Ver "O laço hoje".
- `task-list.ts` (puro): itens abertos, `deliverable` e a lista herdada.
- `login.ts`: um cartão de login por site e conversa; nota no lugar do cartão em rotina.
- `catalog.ts`: núcleo sempre carregado, grupos raros adiados com índice curto no prompt e `mcp_tool_search` para carregar por nome ou necessidade. O roteador de intenção (regex) vira só dica de pré-carga, nunca portão; o grupo `browser` leva `click`, `type`, `key`, `scroll` e `browser_tabs` junto.
- `prompt.ts`: prompt curto (inglês) com persona, memória, conectores, skills e disciplina do modelo vindos dos builders do v1.

O worker (`apps/worker/src/engine-choice.ts`) escolhe o motor no começo do run e grava `engine`/`engineProfile` em `agent_runs.budgetJson` (`recordRunEngine`, só quando é v2; um único `UPDATE` com merge jsonb e condição "ainda sem motor", sem ler-e-escrever). Se a gravação falhar ou outra execução já tiver gravado v1, o run roda no v1: a retomada nunca troca de motor. Modo proativo, alerta, evento de configuração do bot, brief e "só importante" não forçam mais o v1 (ver "Origens além do chat"). A retomada lê o gravado: o motor do bot pode mudar no meio sem trocar um run em andamento. Run com checkpoint e sem motor gravado nasceu no v1.

### Perfis
| Perfil | Quando | Teto de tempo e de US$ | Lista de tarefas |
|---|---|---|---|
| `chat` | todo run nasce aqui, salvo `workProfile: "long_work"` no bot, rotina de relatório ou herança por estado | nenhum por padrão | opcional |
| `long_work` | promoção no mesmo run (lista com 3+ passos ou a 1ª tool de navegador/VM), herança por estado ou perfil do bot | nenhum por padrão; `longWorkMinutes` e `longWorkBudgetUsd` do bot, se o dono preencheu | obrigatória |

Nada de regex do texto do usuário decide o perfil: `looksLikeLongTask` e `isShortContinuation` saíram. A **herança por estado** vale quando o último run da conversa parou com itens abertos: o run seguinte (qualquer texto, inclusive "continua") herda perfil, lista e caderno (uma consulta extra por mensagem digitada). O sinal de promoção é estrutural: a `update_task_list` com 3+ passos ou a primeira tool de navegador.

### Lista de tarefas (trabalho longo)
Reaproveita `update_task_list`. O modelo declara na própria lista o que entrega: `deliverable: "document" | "answer"`. Com `document`, o resultado da lista lembra de criar o arquivo com `create_file`; sem declaração não há fallback de documento, e a resposta sai no chat. Responder com **itens abertos** devolve ao modelo, no máximo 3 vezes por run, o lembrete "continue ou finalize" (só uma nota; o texto que o modelo já transmitiu nunca é apagado). Descartar um item = marcar `completed` com conteúdo `DROPPED: <motivo>`; descartes e pendências aparecem como "Não deu para confirmar: ..." (pt-BR; en/es no idioma do bot).

### Hooks antes da tool
O v2 roda os mesmos hooks do v1 antes de cada tool (`hooks/pre-tool-runner.ts` sobre `runPreToolHooks`): lições do bot (`confirm_always` força o cartão, `required_args`, `require_prior_call`) e bloqueio de escritas com plano pendente (`planPending`), com erro honesto ao modelo e contagem de "ajudou" nas lições.

### Login: só estrutura pausa
- **Pausa** (cartão de login + `AgentRunPausedError`) só com **campo de senha visível** no snapshot (`input[type=password]`, marcado "campo de senha" pela VM) ou **URL de login conhecida** (host de provedor como `accounts.google.com`; segmento de caminho `/login`, `/signin`, `/sign-in`, `/entrar`, inclusive rota por hash). `packages/shared/src/login-wall.ts`.
- **Sinal fraco vira nota, nunca pausa:** "please sign in" solto, sessão expirada no texto, 2+ botões "Continue with...", título "Entrar". O modelo recebe "this page may need a login; if you cannot proceed without one, tell the user what you need" e decide (`detectLoginHint`). A página do Gemini com "Continue with Google" e sem senha segue o trabalho.
- Um cartão de login por site e conversa (30 min). Se o usuário disse "Terminei" e a página segue pedindo login, o modelo recebe `LOGIN STILL REQUIRED`: **conte o que precisa ao usuário e continue com o que dá para fazer sem o login** (não manda mais parar no site). Captcha e login de conector sempre pedem à pessoa; rotina sem humano recebe só a nota.

### Cartões: só quem pede decisão para o run
`awaiting_confirmation` só vem de cartão que espera o usuário: confirmação pendente, proposta de skill ou de agente pendente, questionário e atualização de perfil pendente. Cartão **informativo** (skill criada, atualizada, apagada, listada ou mostrada; proposta de agente já decidida; "aprendi") é exibido e o run continua até a resposta.

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
- Documento gerado só quando `create_file` está disponível; ao encerrar por tempo, passos ou gasto máximo, quem pediu documento ainda tem a última etapa só com `create_file` (ver "Trabalho longo: progresso e tempo"), senão a resposta sai em texto.
- O índice só mostra título e fonte; um título escrito pela página (via modelo) é dado, e o prompt do índice diz isso. Custo: o índice soma até ~900 tokens por passo quando o caderno está cheio.
- Ainda de fora (F3 parte B): resumo de compactação, as 4 memórias, raciocínio controlável e `track_items`.

## Origens além do chat (F5) e o padrão do deploy
**Padrão (01/11):** bot sem `policyJson.engine` roda no v2 em todas as origens suportadas, sem variável de ambiente. Bot com `engine: "v2"` explícito e sem `engineScope` vale como `all` (decisão do dono, 01/11: o motor novo em tudo, inclusive os bots do piloto); só `engineScope: "chat"` explícito o limita ao chat; bot com `engine: "v1"` explícito fica no v1. Dois botões:

| Botão | Onde | Efeito |
|---|---|---|
| `policyJson.engineScope` | por bot (engrenagem: "Usar também em rotinas e grupos"; chat: `set_engine` com `scope`) | `"all"` (padrão, também quando a chave não existe) ou `"chat"` (só a conversa direta). Limitar ao chat grava `engineScope: "chat"` e, num bot sem escolha, também `engine: "v2"` explícito (`withEngineSettings`); escolher "Novo" na engrenagem ou no `set_engine` deixa "rotinas e grupos" ligado, a menos que a pessoa desligue |
| `ATLAS_ENGINE_V2_DEFAULT` | env do worker (**botão de emergência**) | Ausente, vazio ou valor desconhecido = `all` (padrão novo). `off` **desliga o motor novo para todos os bots**, inclusive os que escolheram `engine: "v2"` (todo run novo vai ao v1; o run já gravado ou em andamento segue no motor gravado); `chat` limita ao chat direto os bots SEM `policyJson.engine` explícito. `engine: "v1"` explícito nunca vai ao v2 |

Decisão pura em `shared` (`resolveBotEngineRouting`, `engineV2SupportsRun`, `chooseRunEngine`, `readEngineDefault`); o worker só lê o env (`engineDefaultFromEnv`) e passa. A constante do padrão é `ENGINE_DEFAULT_SCOPE = "all"` (`packages/shared/src/engine-policy.ts`) e é a mesma que a UI e `describeEngineSettings` usam, então a engrenagem mostra "Novo (padrão)" para bot sem escolha, igual ao que o worker faz. **O `off` de emergência do worker NÃO aparece na UI nem na descrição** (a engrenagem e o bot continuam dizendo "motor novo (padrão)" mesmo com `off` no deploy): é uma chave do operador, para uso temporário. O motor gravado em `budgetJson.engine` continua vencendo (run em andamento e retomada); retomada com checkpoint e sem motor gravado fica no v1 como antes.

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
- **Chat com proativo e evento de configuração migram.** Antes o worker forçava o v1 nesses dois casos mesmo com `engine: "v2"` no escopo `chat`. Agora o chat do bot principal com modo proativo ligado e o evento de configuração do bot (origem `chat`) rodam no v2 se o bot tem `engine: "v2"` (qualquer escopo) ou não escolheu motor. Reverter: `engine: "v1"` no bot ou `ATLAS_ENGINE_V2_DEFAULT=off` (todos os bots). Cobertura: `apps/worker/src/engine-choice.test.ts`.
- **`notify_user` em todo chat v2.** Com o aviso de chat (`userPush: {mode:"chat"}`) o v2 expõe `notify_user` no chat, como o v1. O que muda em "Bom dia": só o schema dessa tool (o prompt de sistema é idêntico). Cobertura: `engine-v2/proativo.test.ts` ("caso real do worker").
- **Orçamento do brief e do lembrete `check`.** `shortRun` fixa o perfil `chat` (8 min, sem teto em US$) em alerta, evento de configuração, brief e `check`. Para brief e `check` o v2 aplica um piso (`budgetFloor`, `engine-choice.ts`): tempo = max(`longWorkMinutes` do bot, 30 min), onde 30 min é `BUDGET_WALL_DEFAULT_MS`, o teto de relógio que o v1 aplica a essas execuções (sem piso em US$: o v1 não tem teto de custo por padrão e o v2 também não). O perfil continua `chat`: sem lista de tarefas obrigatória nem entrega em documento. Tetos de custo e tempo da conta/bot continuam valendo por cima. Cobertura: `engine-v2/supervisor.test.ts` e `engine-choice.test.ts`.
- **`find_page_value`:** o teto de 3 buscas por run passou a valer no v2 (`engine-v2/page-value.test.ts`).

**Verificação por origem (v1 x v2) e lacunas fechadas** (`engine-v2/catalog.ts`, `prompt.ts`, `login.ts`, `run.ts`; testes em `engine-v2/origens.test.ts` e `apps/worker/src/integration/origens.integration.ts`):
- Rotina: o v2 não filtrava nada por origem. Agora usa a mesma lista de exclusão do v1 (`tools/routine-excluded.ts`: gestão de rotinas, `web_search`/`web_extract`, `memory`, `secret_request`), sem `sandbox_release`, sem lista de tarefas, imagem, painéis e conector de API (só chat). Conector: só o que a autonomia libera sem perguntar (o filtro de `unattended` já vinha do carregamento no worker; o catálogo agora repete a regra). "MCP read-only" aqui significa isso: com autonomia total o dono liberou escrita, igual ao v1. Sem humano o prompt traz o modo execução de rotina e "Unattended run": não perguntar, não esperar aprovação nem login. Login sem humano vira nota ao modelo (sem cartão nem pausa); captcha e login de conector seguem pedindo à pessoa, como no v1. Painel da rotina: só `page_read`/`page_update` do painel dela, com `routinePageId` no contexto da tool (o v2 não o repassava: poderia atualizar outro painel do dono). Perfil de trabalho: o mesmo `resolveRunProfile` (`long_work` quando o pedido da rotina é relatório/levantamento, senão `chat`). Entrega, `routineId` + run e `stopReason` vêm do worker, igual ao v1.
- Grupo: o run de membro é `chat` com `isGroupRun`; cartões, aceite automático do principal (`autoDecideGroupPending`), cobrança única e resumo são do db/worker e valem para os dois motores (o v2 grava o mesmo cartão `confirm` e para em `awaiting_confirmation`). Menções e "quem fala" vêm das mensagens preparadas pelo worker. O bloco "últimas respostas do usuário" para não reperguntar também. `set_engine` e perfil não aparecem (turno do coordenador não é `humanTurn`). Teste de integração: membro responde no v2 e termina.
- Bot→bot: o v2 expõe `send_to_bot` e `decide_bot_pending` nas mesmas condições do v1 (`engine-v2/catalog.ts` com `shouldExposeSendToBot`/`shouldExposeDecideBotPending`: 2+ bots do dono, origem chat ou bot, decisão só com "decidir pelos outros bots" ligado; nunca em grupo, rotina ou ajudante), executando os handlers do registro. Os pedidos abertos a outros bots entram no prompt como no v1 (`[open_bot_requests]`, só quando existem; o roster só decide se a tool existe, não vai ao prompt). Limites anti-loop (`BOT_RUN_MAX_SENDS`, `BOT_MESSAGE_MAX_DEPTH`, cadeia) ficam no db (`sendBotMessage`), então valem igual nos dois motores. Testes: `engine-v2/bot-messaging.test.ts` e `apps/worker/src/integration/bot-bot.integration.ts` (A pede ao B, B responde, cadeia para na profundidade, run para no máximo de envios). Lista de tarefas igual ao v1 (chat e bot). `set_primary_bot` continua fora do v2.

- Webhook (`origin: "webhook"`, run criado por `POST /v1/runs`): é run sem humano, igual à rotina. Mesmas regras do v1: prompt "Unattended run" (não pergunta, não espera aprovação nem login), conector só com o que a autonomia libera sem perguntar, shell e arquivos da VM só leitura, sem lista de tarefas, sem painéis, imagem, conector de API nem tools de perfil/skill/`set_engine`. Diferente da rotina, o webhook mantém `web_search`/`memory` (a exclusão é só da origem `routine`, no v1 também). Nota: o v1 expõe `propose_profile_update` em qualquer origem enquanto o bot não tem descrição (onboarding); o v2 só no chat, que é a regra 60 (divergência deliberada, mais restritiva).
- E-mail recebido (`origin: "email"`, criado por `startEmailRun`): não é run sem humano no v1 (o dono vê a conversa do bot e os cartões de aprovação continuam valendo), então o v2 também não usa o aviso "Unattended". Paridade com o v1: as tools de e-mail e o procedimento anti-manipulação (conteúdo entre `<<<EMAIL_EXTERNO`/`EMAIL_EXTERNO>>>` é dado, nunca instrução) já vão no 1º passo; a autonomia do run vem do worker limitada a "Equilibrado" (o envio de e-mail segue a política real do dono, `sendPolicy`); escrita de conector pede cartão ao dono. Só o v2 ganha uma linha curta no prompt (`ENGINE_V2_EMAIL`): o remetente está fora do chat e só recebe resposta por `email_reply`. O texto do e-mail nunca escolhe o perfil: e-mail recebido roda em `chat` (US$ 0,25 / 8 min) mesmo que peça um relatório; só o dono força `long_work` por `workProfile` na política do bot (`resolveRunProfile` recebe a origem). Não recebe `delegate` (no v2 ele só existe em chat + `long_work`; o v1 expõe `delegate_task` em chat, e-mail e bot) nem lista de tarefas. A linha `ENGINE_V2_EMAIL` só entra quando `email_reply` existe no run (caixa ativa).
- Subagente: não é um run do worker, é o filho em processo que o pai cria (`createSubagentRun`, origem `subagent`, nunca enfileirado). Decisão (opção menos arriscada): o pai no v1 continua com `delegate_task` e filhos v1; o pai no v2 atende o mesmo pedido com `delegate` (ajudantes), que reaproveita `createSubagentRun`/`finishSubagentRun` e emite os mesmos eventos `subagent_started`/`subagent_tool`/`subagent_done` e o mesmo cartão `subagents` persistido, então o usuário vê o mesmo resultado. Não há roteamento a fazer: `engineV2SupportsRun` continua devolvendo `false` para a origem `subagent` como proteção, e o filho herda o motor do pai. Teste de integração compara os dois (dois filhos `subagent`, cartão e eventos iguais). Limite: no v2 o `delegate` só existe em `long_work` (precisa do caderno) e no chat direto; um pedido de comparação curto no perfil `chat` não paraleliza (ver Limites).

**Riscos e custo.** O motor novo é o padrão de todo bot sem escolha e de todo bot que escolheu "Novo" sem limitar o escopo, em todas as origens suportadas. O que isso muda na prática: (1) **rotina de relatório** roda em `long_work` (caderno, documento, até 60 min); como rotina não é chat com humano, o teto por execução da conta (padrão US$ 0,25) continua valendo para ela e pode cortá-la por dinheiro (vai à escrita perto do teto), e sem teto algum vale o piso de US$ 0,50 por execução; rotina curta fica em `chat` (US$ 0,25 / 8 min); (2) **não há teto em dólar no trabalho longo do chat com o dono**: a tarefa para por progresso (lista de tarefas concluída, passos sem avanço) e por tempo (60 min por padrão, até 180), e só vira teto duro se o dono preencher um gasto máximo; o custo médio por tarefa longa sobe e é medido no piloto; (3) conversa curta não fica mais cara (o teste de "Bom dia" compara com o v1). **Emergência:** `ATLAS_ENGINE_V2_DEFAULT=off` no worker (e reiniciar) desliga o motor novo para TODOS os bots, inclusive os que escolheram "Novo": todo run novo vai ao v1; run já gravado ou em andamento termina no motor em que começou. A engrenagem e o bot não mostram essa chave (continuam dizendo "Novo (padrão)"), então `off` deve ser temporário. Para um bot só, use "Anterior" na engrenagem (grava `engine: "v1"`).

## O laço hoje (sem fases, sem regex de comportamento)

**Decisões do dono (02/11 e 03/11).** Sem orçamento de tempo por padrão (ADR 0003) e nenhuma decisão de comportamento do agente por regex sobre texto (regra em `.agents/rules/60-agente.md`). Motivo: um pedido real ("abra o vídeo, peça o resumo ao Gemini e compare com Hermes, Dots e Grok Bot") terminou em ~40 s com uma nota falsa de "teto de gasto", porque "compare" casou a regex de documento e cliques repetidos viraram `loop_repeat`.

### Fluxo de um run
1. O worker escolhe o motor (v2 por padrão) e o perfil (`chat` ou `long_work`).
2. `catalog.ts` monta o **núcleo sempre carregado** e adia os grupos raros. O roteador de intenção só dá dica de pré-carga. Regra do navegador: o grupo `browser` leva junto `click`/`type`/`key`/`scroll` (desktop) e `browser_tabs`, seja por tarefa de navegador ou pela 1ª tool do grupo; depois de carregado o catálogo **não muda** (nada entra e sai por passo, o prefixo em cache se mantém). `sandbox_shell` já vem com o grupo `shell`.
3. Laço: o modelo chama o `streamChat`; tool calls rodam (lotes só de leitura em paralelo); os resultados entram **inteiros** no histórico canônico (a higiene vale só para a cópia enviada ao modelo, com os 6 últimos grupos de resultados inteiros e resumo antes do corte duro; `ATLAS_ENGINE_V2_CONTEXT_KEEP=off` volta ao comportamento antigo).
4. Resposta sem tool call encerra o turno. Os únicos retornos ao modelo antes de encerrar: lembrete de itens abertos (até 3), retry de resposta vazia ou cortada (1 de cada) e, com `deliverable: "document"`, o lembrete de criar o arquivo.
5. Parada com motivo REAL (`stopReason`/`stopDetail`, visíveis na API e no inspetor de run): a nota só fala em teto se um teto configurado disparou, com valor e origem (conta, servidor ou bot).

### As travas que restam (e por quê)
1. **Teto que o dono configurou** (US$ ou tempo da conta, do servidor ou do bot; gasto e minutos do trabalho longo): aviso a 80% e entrega honesta a 100%. É dinheiro e tempo dele.
2. **200 passos por execução** (`MAX_STEPS_SAFETY`): sem tempo nem dinheiro, é o que garante que um laço termina.
3. **`loop_repeat`**: mesma tool, mesmos args e mesmo resultado: nota aos 3, 2ª nota com alternativa, e encerra na reincidência seguinte (esperas como `browser_wait` ficam isentas até 30).
4. **`tool_failures`**: 10 falhas consecutivas de qualquer tool sem nenhum sucesso no meio (nota aos 8); 3 falhas seguidas da mesma tool e alvo viram só uma nota.
5. **Estagnação**: 8 passos sem resultado novo viram UMA nota "mude de abordagem"; não troca fase nem tira tool.
6. **Cartões que esperam o usuário** (confirmação, questionário, perfil, proposta pendente, login) e rotinas sem humano.
7. Timeouts técnicos, fila e o botão de parar.

**Não existem mais** fases pesquisa/lacunas/escrita, catálogo filtrado por fase, bloqueio temporário de tool, fim da pesquisa por estagnação ou por 70% dos passos, rodada de lacunas, portão de documento que forçava `create_file`, portão de pergunta no meio do trabalho, `assistant_discard` em portão (o texto transmitido não some) nem aviso de tempo por padrão.

### Dinheiro e tempo são opcionais
Sem teto de fábrica em nenhum perfil. Só valem: o teto da conta (`execution.maxRunCostUsd` e o tempo da conta), o gasto máximo do bot no trabalho longo (`longWorkBudgetUsd`, 0,05 a 20; vazio ou 0 remove), `longWorkMinutes` (até 180) e o teto do pedido. Vale o menor. Ao chegar a um deles o run entrega o que tem e diz o motivo em palavras simples ("o gasto máximo definido para esta tarefa foi atingido"), nunca "mande continua". Rotina, alerta, proativo, brief e bot→bot mantêm os limites de antes (ADR 0003).

### Prompt de persistência
O núcleo do prompt v2 manda continuar até resolver e só parar por decisão, login ou confirmação que só o usuário dá; perguntar apenas quando travar ou antes de algo irreversível, enviado para fora, dinheiro ou dado sensível; nunca pedir ao usuário que mande "continue". Não há mais "pergunte uma vez, no início" nem "sem dizer o que vai fazer" (contradiziam a persistência). A regra "resposta sem tool call encerra o turno" mora numa linha só, na disciplina do modelo. Escada de pesquisa: pedido de **agir** num site (abrir, clicar, preencher, acompanhar, entrar) usa o navegador primeiro; para **achar informação**, `web_search`/`web_extract`.

## Não desistir no primeiro bloqueio
`web_extract` que falha (bloqueio, robots, erro de leitura) devolve a alternativa (outra fonte, versão bruta do repositório); página cortada traz `nextStep` (uma URL por chamada com `maxChars` até 20000, ou buscar o termo). A tool não tem `offset`. Vale só no `long_work` do v2 (`ToolContext.longWork`).

## Limites desta fase (o que o v2 ainda não faz)
- **Origens:** por padrão todas as suportadas (chat, rotina com alerta, brief e "só importante", grupo, bot→bot, proativo, webhook e e-mail recebido), a não ser com `engineScope: "chat"` explícito, `engine: "v1"` ou `ATLAS_ENGINE_V2_DEFAULT=off`/`chat`, ver acima. O subagente herda o motor do pai.
- **Padrão do deploy e a UI (01/11):** `describeEngineSettings`, a engrenagem e `set_engine` leem só o `policyJson` e a constante `ENGINE_DEFAULT_SCOPE`; bot sem escolha aparece como "Novo (padrão)" e roda no v2. Só o `ATLAS_ENGINE_V2_DEFAULT=off` de emergência é invisível para a UI. Bot que voltou ao v1 antes da 0.3.5 (chave removida, sem `engine: "v1"`) agora roda no v2: regrave "Anterior" na engrenagem se quiser mantê-lo no motor anterior.
- **Rotina em trabalho longo:** instrução de relatório vira `long_work` (orçamento e documento), sem lista de tarefas (a rotina não tem `update_task_list`; o prompt não a cita).
- **Subagentes só em trabalho longo:** `delegate` (o equivalente do `delegate_task`) exige o caderno do `long_work` e o chat direto; em `chat` (conversa curta) e nas outras origens (e-mail, bot, rotina, grupo) o v2 não paraleliza, enquanto o v1 oferece `delegate_task` em chat, e-mail e bot. Quem quer ajudantes em todo pedido força `workProfile: "long_work"` no bot.
- **Tools fora do catálogo do v2:** `delegate_task` (no v2 o equivalente é `delegate`, ver acima), `research_note` (no v2 vale o caderno), `track_items`, `propose_plan`, `read_cached_result`, sessão de código (`dev_*`), `set_primary_bot`, `set_autonomy`, lições de conector, prévia completa.
- **Login:** o card de login é sempre humano (sem preenchimento automático do Cofre nem retomada com item do Cofre); o `login_fill` por tool continua.
- **Detecção de login e código de uso único:** o campo `autocomplete=one-time-code` só é marcado ("campo de código de uso único: nunca preencha") por `docker/agent-sandbox/control/snapshot*.mjs`, que roda dentro da imagem do sandbox. Enquanto a imagem não for reconstruída e publicada, sandboxes antigos não trazem o marcador e a pausa por código depende só do host de login, do campo de senha ou de segmento de login no caminho com formulário (`/docs/login` sem formulário não pausa; vira só nota ao modelo). Código sem `autocomplete` e sem segmento de login na URL também não é detectado: a nota fraca e a regra "nunca digite credenciais que o usuário não deu" são a rede de segurança.
- **Modo proativo e avisos:** cobertos (ver acima). Diferenças conhecidas: o modo proativo e o `notify_user` ocupam o catálogo sempre carregado (como no v1, são núcleo, não grupo lazy); um chat com modo proativo ligado não segue o idioma da mensagem no modo "auto" (igual ao v1: vale o último idioma detectado).
- **Estimativa de custo:** conservadora e única para todos os modelos; modelos baratos sem custo informado chegam ao teto antes do real.
- **Cartões que param o run** (confirmação, questionário, perfil, proposta pendente): o v2 devolve texto vazio e `awaiting_confirmation`, sem o fechamento curto que o v1 escreve. Cartão informativo não para.
- **Contexto:** mesma higiene de prompt do v1; sem armazenamento de resultado grande por referência, sem resumo de compactação e sem as 4 memórias da F3.
- **Mensagens durante o run:** entram como nota do usuário (`[User message during the task]`); sem triagem por modelo (`join`/`redirect`/`later`) nem interrupção da chamada em voo. `cancel` funciona.
- **Modelo:** usa o modelo do run; o Modo Automático (níveis de dificuldade) e o modelo para código não trocam no v2.
- **Cabeçalho de tempo:** o relógio do v2 é só de execução ativa; operações do computador ganham 25% de folga sobre o orçamento de tempo.

## Riscos
- Custo por tarefa longa sobe (o v2 trabalha até o fim), mas é limitado pelos tetos que o dono configurou, pelos 200 passos e pelas travas de repetição e de falhas. Conversa curta não pode ficar mais cara: teste compara o "Bom dia" do v2 com o do v1 (`computer-use.economy-replay.test.ts`).
- Login: um "please sign in" ou "Continue with..." sem campo de senha não pausa mais; se a página de fato exigir login, o modelo vê a nota e avisa o usuário (pior caso: um passo a mais). Já uma URL `/login` pausa mesmo sem senha visível.
- Catálogo estável com o navegador: o grupo traz mais 5 tools (cerca de 2 mil caracteres) no pedido que usa o navegador; o "Bom dia" não muda.
- Versões mistas no deploy: api/worker antigos ignoram `budgetJson.engine*` e `policyJson.engine`; sem migration.
- Custo desconhecido do provedor (`costUnknownCalls`) conta como zero para o orçamento em US$; o tempo e o teto de passos continuam limitando.
- Dois motores convivendo: as tools são compartilhadas (registro da F1), então um conserto de tool vale para os dois.

## Custo
Sem custo de infra novo. Tokens: o prompt do v2 é menor que o do v1 no "Bom dia" (testado). Os números de custo real por tarefa vêm do piloto (F4).

## Como testar
- `pnpm --filter @workspace/shared test` (`engine-policy.test.ts`, `notebook.test.ts`, `engine-helpers.test.ts`).
- `pnpm --filter @workspace/agent-runtime test` (`engine-v2/supervisor.test.ts`, `task-list.test.ts`, `run.test.ts`: replay de pesquisa com 30 leituras sem corte, "Bom dia" barato, aviso a 80% e entrega sem tools, repetição, falhas, lista de tarefas, retomada); `engine-v2/long-work.test.ts` (caderno: índice compacto, limites, checkpoint e retomada; ajudantes: paralelo, orçamento repartido, falha que não mata o pai, só leitura, escopo, hooks; replay "pesquisa de mercado com 5 fornecedores" com documento), `delivery.test.ts`, `notebook.test.ts`.
- Worker: `cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-choice.test.ts` (bot sem policy → v2 (padrão); engine v1 explícito → v1; `off` → v1 para todos; policy v2 → v2; retomada respeita o gravado; proativo no escopo `all`; `shortRun` fixa o perfil `chat`).
- Paridade do proativo/alerta/brief: `engine-v2/proativo.test.ts` (agent-runtime) e `ATLAS_TEST_DB_URL=... pnpm --filter worker test:integration` (`proativo.integration.ts`).
