# Plano de evolução do Atlas para um agente autônomo

> Documento de arquitetura e execução. A seção 2 registra o diagnóstico inicial; parte da aplicação já evoluiu. Revisão de memória e limites para delegação em 16/09/2026: seguir os contratos das seções 5.3 e 6. Esta revisão altera somente documentação. Não fazer commit ou push sem nova autorização do usuário.

## 1. Objetivo do produto

Transformar o Atlas em um assistente pessoal econômico, inspirado na experiência de agentes como o Grok, capaz de:

- receber um objetivo, planejar e executar várias ações até chegar a um resultado verificável;
- continuar trabalhando no servidor mesmo que a aba seja atualizada ou fechada;
- usar navegador, aplicativos e integrações autenticadas sem perder a sessão;
- executar rotinas agendadas em segundo plano;
- preservar a continuidade da conversa quando o contexto do modelo estiver próximo do limite;
- manter memória compartilhada do usuário e memória privada de cada agente;
- mostrar ao usuário estado, progresso, resultados, falhas e ações que exigem intervenção;
- controlar custo, duração e risco por orçamento, em vez de depender de um limite pequeno e fixo de etapas.

## 2. Estado encontrado

### 2.1 Arquitetura atual

O repositório é um monorepo pnpm/Turborepo com:

- `apps/web`: interface Next.js 16.3.3 e React 19;
- `apps/api`: API Hono, endpoints de chat, memória, bots, modelos e sandbox;
- `apps/worker`: worker BullMQ;
- `packages/llm`: cliente OpenRouter e suporte a tool calling;
- `packages/db`: Prisma/Postgres para conversas, bots, preferências e memória;
- `packages/queue`: BullMQ/Redis;
- `packages/sandbox`: criação e controle de containers Docker;
- `docker/agent-sandbox`: Chrome, Playwright/CDP, XFCE e noVNC.

Há trabalho local de outros agentes. Antes de implementar, inspecionar o estado atual e preservar alterações existentes. Não executar reset, checkout destrutivo, commit ou push automaticamente.

### 2.2 O que já funciona no desenho

- Cada bot recebe uma conversa persistente no Postgres.
- O chat comum persiste mensagens e recupera as mensagens recentes.
- Existe memória global do usuário e memória associada ao bot.
- Uma revisão de memória assíncrona roda após os turnos.
- O sandbox pode ser associado a uma conversa e reencontrado por label Docker após reinício da API.
- O navegador expõe ações por DOM com Playwright e ações de desktop por coordenadas.
- A fila tem tentativas, backoff exponencial e retenção limitada de jobs.
- O frontend tenta reabrir o viewer da sandbox após F5.
- O código passa no typecheck atual: 9 tarefas concluídas.

### 2.3 Lacunas críticas e defeitos

#### P0 — A execução agêntica depende da conexão HTTP

`POST /v1/chat/computer` executa o loop completo dentro de um `ReadableStream` da API. Se o navegador fecha, atualiza ou a conexão cai, o cliente perde o acompanhamento e o processo pode ser interrompido pelo servidor/proxy. O worker existente executa apenas uma completion simples; ele não executa tools nem persiste checkpoints do loop.

Consequência: o pedido parece pertencer à aba, não ao servidor. Esse é o principal motivo para o comportamento “atualizei e o bot desistiu”.

#### P0 — Rotinas existem somente no estado React

As rotinas são guardadas em `useState`. Não há tabela, CRUD de backend, scheduler, worker específico, histórico real, próxima execução, lock ou idempotência. Os gatilhos Slack, Git, Teams, Linear, Sentry, PagerDuty e webhook são apenas opções visuais. “Execução de teste” está desabilitada.

Consequência: nenhuma rotina sobrevive a F5 nem roda em segundo plano.

#### P0 — Não existe um modelo persistente de execução

Faltam entidades para execução, passos, eventos e artefatos. O progresso existe apenas como SSE efêmero. Não há como retomar do último checkpoint, consultar o que o agente está fazendo, cancelar com segurança ou reconectar a outra aba.

#### P0 — Continuidade de contexto é uma janela fixa

O contexto da conversa usa as últimas 40 mensagens. Não há contagem preventiva de tokens, resumo acumulado, compactação por capítulos, checkpoint semântico nem rotação de sessão do modelo. O `context_length` dos modelos é listado na interface, mas não governa a montagem do prompt.

Consequência: detalhes antigos somem abruptamente; uma conversa longa pode ultrapassar o contexto; trocar o modelo manualmente não cria um pacote de continuidade confiável.

#### P0 — Sessões autenticadas do navegador não têm ciclo de vida explícito

O Chrome usa `--user-data-dir=/tmp/chrome-data`, dentro do container. Parar e reiniciar o mesmo container tende a preservar cookies; remover o container apaga o perfil. Não há volume de perfil por usuário/agente, exportação criptografada de `storageState`, inventário de conexões, expiração, revogação, tratamento de MFA ou pedido de intervenção humana.

Consequência: logins podem sobreviver enquanto o mesmo container existe, mas não são uma capacidade confiável do produto.

#### P0 — Isolamento de usuário ainda é fictício

`userId` usa `default`; bots e conversas não pertencem a uma conta; CORS e rotas não demonstram autenticação/autorização. O Docker socket dá à API poder equivalente ao daemon Docker do host.

Consequência: o desenho serve para desenvolvimento local confiável, mas não para uma oferta multiusuário hospedada.

#### P1 — O limite de etapas resolve custo por corte abrupto

O loop atual tem padrão de 16 passos e a rota aceita de 1 a 30. O revisor de memória usa 4 passos. Portanto, o limite de 8 observado não está definido nestes arquivos e deve ser reproduzido para localizar outro limitador, uma versão antiga ou o comportamento do modelo/provedor.

Aumentar o número isoladamente não resolve autonomia: uma ferramenta pode falhar repetidamente, cada passo pode conter várias tools e o custo varia conforme o contexto. O controle precisa combinar etapas, tempo, tokens, dinheiro, repetição e progresso.

#### P1 — Ferramentas são estreitas e frágeis

O navegador oferece navegar, clicar, preencher, ler até 4.000 caracteres e listar até 60 links. Faltam abas, downloads/uploads, arquivos, diálogo, espera, seletor acessível estruturado, rede, cookies, storage, PDF, clipboard e recuperação robusta de erros. Seletores CSS ou texto solto quebram facilmente.

#### P1 — “Apps” não são uma camada do produto

As skills da UI são estáticas e as integrações exibidas nas rotinas não possuem adaptadores, credenciais ou tools. Hoje o agente usa o navegador genérico para tudo. Não existe catálogo de capacidades, conexão OAuth, escopos, renovação de token ou preferência “API primeiro, navegador como fallback”.

#### P1 — Memória e busca ainda não escalam

- Perfil global: limite de 1.375 caracteres.
- Memória do bot: limite de 2.200 caracteres.
- Recuperação: busca textual em português, sem embeddings ou ranking híbrido.
- `session_search` pesquisa todas as conversas sem um modelo claro de autorização entre agentes.
- A revisão analisa somente as últimas 20 mensagens e usa o modelo padrão do worker.
- Entradas de memória são injetadas integralmente, mesmo quando não são relevantes para o turno.

#### P1 — Falhas de persistência são tratadas como melhor esforço

Em vários fluxos, uma falha ao persistir mensagens ou memória apenas gera log e ainda encerra a resposta como sucesso. Isso pode produzir uma interface que mostrou o resultado, mas perdeu o estado necessário para continuar depois.

#### P2 — Modelo selecionado tem fontes concorrentes

O modelo do bot existe no banco, mas a interface também o guarda em `sessionStorage`. A troca pode desaparecer ao fechar a aba ou divergir do bot persistido. Não existe política de fallback por capacidade, custo, contexto, saúde ou indisponibilidade.

#### P2 — Estado visual não representa estado operacional

Estados como “acordado”, “dormindo” e notificações são majoritariamente animação local. Eles não refletem jobs ativos, espera por usuário, falha, pausa, conclusão ou próxima rotina.

#### P2 — Documentação está defasada

O README ainda descreve partes do computer-use como futuras, embora já existam, e descreve um modelo antigo de fatos/memória. Isso aumenta o risco de o próximo implementador trabalhar sobre premissas erradas.

## 3. Arquitetura alvo

O núcleo deve separar quatro responsabilidades:

1. **Control plane**: API autentica o usuário, cria objetivos, registra rotinas, autoriza conexões e expõe estado.
2. **Execution plane**: workers executam loops agênticos duráveis a partir da fila, com checkpoints no Postgres.
3. **Tool plane**: registry de tools normaliza apps, navegador, sandbox, memória e busca; aplica permissões e idempotência.
4. **Experience plane**: a interface envia o objetivo, assina eventos, pode fechar e depois reconectar usando `runId`.

Fluxo recomendado:

`mensagem/rotina -> cria AgentRun -> fila -> worker carrega checkpoint -> modelo decide -> tool executa -> salva Step/Event -> próximo passo -> resultado`

O SSE passa a ser uma projeção dos eventos persistidos. Ele não deve ser o dono da execução.

## 4. Modelo de dados proposto

Adicionar, com nomes ajustáveis às convenções do projeto:

### Identidade e agentes

- `User`: identidade real e limites da conta.
- `Bot.userId`: dono do agente.
- `Conversation.userId`, `Conversation.botId` e estado de compactação.
- `AgentPolicy`: modelo preferido, fallbacks, ferramentas permitidas e orçamentos.

### Execuções duráveis

- `AgentRun`: `id`, `userId`, `botId`, `conversationId`, origem (`chat`, `routine`, `webhook`), objetivo, status, modelo, orçamento, uso, `leaseOwner`, `leaseUntil`, timestamps e erro.
- `AgentStep`: índice, tipo (`model`, `tool`, `checkpoint`, `approval`), input/output serializados, status, tentativas, tokens, custo, duração e chave de idempotência.
- `RunEvent`: sequência monotônica, tipo e payload para replay da interface.
- `RunInput`: mensagem enviada enquanto o run está ativo, com sequência, autor, conteúdo, modo (`steer`, `queue`, `cancel`), status (`pending`, `consumed`, `superseded`) e timestamps.
- `Artifact`: arquivo, link, screenshot ou relatório produzido.
- `ApprovalRequest`: ação sensível, status e decisão do usuário.

### Contexto e memória

- `ConversationSummary`: resumo versionado de um intervalo de mensagens, fatos, decisões, tarefas abertas e ponteiros de origem.
- `MemoryEntry`: acrescentar categoria, confiança, importância, fonte, validade, acesso (`user`, `bot`, `team`) e embedding.
- `ContextCheckpoint`: pacote transferível usado na troca de modelo/sessão.

### Rotinas

- `Routine`: dono, bot, instrução, timezone, estado, orçamento e política de notificação.
- `RoutineTrigger`: schedule normalizado ou evento externo.
- `RoutineRun`: vínculo entre disparo e `AgentRun`, incluindo horário previsto/real e resultado.

### Aplicativos e navegador

- `AppConnection`: provedor, usuário, escopos, status, expiração e referência para segredo criptografado.
- `BrowserProfile`: usuário/agente, volume ou storage state, status e última validação.
- `ToolGrant`: escopo permitido por bot, conexão e operação.

## 5. Motor agêntico durável

### 5.1 Um único executor

Extrair o loop de `apps/api/src/chat/computer-use.ts` para um pacote de domínio, por exemplo `packages/agent-runtime`. API, chat assíncrono e rotinas devem criar o mesmo tipo de `AgentRun`. O worker passa a executar esse runtime.

O runtime deve:

- carregar objetivo, política, checkpoint, memória relevante e resumo;
- adquirir lease da execução para impedir dois workers concorrentes;
- gravar cada decisão e resultado antes de seguir;
- renovar heartbeat/lease durante chamadas longas;
- retomar após crash a partir do último passo confirmado;
- usar chave de idempotência em tools com efeito externo;
- classificar erros como transitórios, permanentes ou “precisa do usuário”;
- produzir resultado verificável e estado terminal explícito.

### 5.2 Estados

Usar pelo menos:

- `queued`
- `running`
- `waiting_user`
- `waiting_external`
- `paused`
- `completed`
- `failed`
- `cancelled`
- `budget_exhausted`

### 5.3 Orçamento adaptativo

Substituir a ideia de “8/16 passos e para” por limites combinados:

- limite brando inicial, por exemplo 24 decisões;
- limite duro configurável, por exemplo 100 decisões;
- tempo máximo;
- tokens máximos;
- custo máximo em USD;
- chamadas máximas por tool;
- detector de repetição/ausência de progresso;
- extensão automática somente quando há progresso mensurável e orçamento restante;
- checkpoint e continuação como novo job para trabalhos longos.

Ao atingir o limite brando, o agente deve avaliar: objetivo concluído, falta informação, plano ainda válido e custo de continuar. Ao atingir o limite duro, salvar checkpoint e encerrar com `budget_exhausted`, sem fabricar conclusão.

#### 5.3.1 Contrato de implementação e testes dos limites

- Um passo é uma decisão do modelo no loop principal. Contar tools, tentativas do provedor e compactações separadamente; todas as chamadas ao modelo, inclusive resumos e revisão de memória, entram na contabilidade de tokens/custo apropriada.
- Exemplo inicial configurável: bloco de 24 decisões, extensão de mais 24, teto de 100. Centralizar a política no backend; o modelo não pode aumentar o teto duro.
- Persistir política e consumo acumulado. Retry, pausa/retomada, compactação, troca de modelo e novo job não zeram contadores. Jobs de continuação preservam o mesmo `runId`. Novos objetivos respeitam também o teto global configurado.
- Conferir orçamento antes de cada chamada externa e cada tool, inclusive dentro de um lote. Reservar custo máximo estimado e limitar saída antes da chamada; reconciliar com uso real depois. Uso desconhecido após falha não vale zero. Registrar estimativa conservadora e incerteza; não prometer faturamento exato sem dados do provedor.
- Extender o limite brando somente com evidência: subobjetivo concluído, artefato validado ou mudança útil de estado. Variar argumentos sem resultado não demonstra progresso. Repetições de ação/resultado acionam recuperação limitada e depois pausa explicada. Polling legítimo tem intervalo e prazo próprios.
- Separar tempo ativo acumulado, timeout por chamada e prazo absoluto opcional. Pausas e espera pelo usuário não consomem tempo ativo. Observar pausa/cancelamento entre ações, inclusive durante compactação.
- `budget_exhausted` preserva checkpoint e motivo (passos, tokens, custo ou tempo), não entra em retry automático nem vira conclusão bem-sucedida. Retomar exige aumento explícito do limite atingido pelo usuário, mantendo consumo anterior; play sozinho não contorna o teto.
- Testar: tarefa simulada supera 30 decisões com progresso; loop para antes do teto; restart/retry/compactação preservam consumo; orçamento pode acabar entre duas tools do mesmo lote; timeout e custo desconhecido são tratados; extensão explícita retoma do checkpoint sem repetir efeitos.

Estado verificado em 16/09/2026: `packages/agent-runtime/src/computer-use.ts` ainda define padrão de 16 passos; a rota legada `apps/api/src/routes/computer.ts` já admite até 100. O teto 30 citado no diagnóstico inicial é histórico. Conferir também `POST /v1/runs`, contratos compartilhados e banco; unificar a política em todos os caminhos.

## 6. Continuidade de contexto e rotação de modelo

Não existe uma “sessão interna do modelo” que possa ser continuada entre fornecedores; a continuidade deve ser propriedade do Atlas.

### 6.0 Duas noções diferentes de sessão

Para o usuário, a conversa e o run continuam sendo os mesmos. Internamente, o Atlas pode abrir uma nova **época de inferência** quando o contexto estiver cheio. Essa época é uma chamada/sessão limpa do modelo, alimentada por um pacote compactado da época anterior.

Adicionar `ModelContextEpoch` (ou nome equivalente) com `conversationId`, `runId`, modelo, faixa de mensagens, estimativa de tokens, resumo/checkpoint de entrada e motivo da rotação. A rotação não cria outro bot, outra conversa visível ou outro histórico na interface.

### 6.0.1 Serviço de sessão próprio

Estado verificado em 16/09/2026: a interface envia a mensagem atual, mas `packages/db/src/memory-context.ts` (`buildMemoryAugmentedMessages`) acrescenta até 40 mensagens persistidas e a memória renderizada. Portanto, o request ao OpenRouter normalmente inclui histórico recente. Durante o run, o histórico de decisões/tools também cresce e é restaurado pelo checkpoint. Medir o payload final em `packages/llm`, sem registrar conteúdo sensível, antes e depois da implementação.

Implementar um `ConversationSessionService` como a única porta de leitura e escrita do contexto operacional. Antes de cada run, ele carrega o histórico aplicável; ao confirmar um passo, persiste mensagem, evento, checkpoint e versão da sessão. API, worker, rotinas e retomadas devem usar esse serviço, nunca reconstruir o histórico a partir do estado do frontend.

O serviço mantém o transcript íntegro no Postgres e entrega ao modelo somente o pacote de contexto da época ativa. Assim, uma chamada nova ao DeepSeek mantém continuidade sem depender de uma sessão interna do provedor.

Fluxo obrigatório de rollover:

1. antes de cada chamada, calcular a ocupação estimada do próximo prompt;
2. ao alcançar o limite preventivo, pausar a próxima decisão do agente;
3. gerar um resumo estruturado da época antiga;
4. preparar o resumo e o `ContextCheckpoint` candidato;
5. validar esquema, referências, objetivo, plano, fatos, decisões, IDs, resultados, pendências e próxima ação;
6. publicar resumo, checkpoint e nova época atomicamente após conferir a versão, ligados à mesma `conversationId` e ao mesmo `runId`;
7. montar o novo contexto com prompt fixo, memórias relevantes, checkpoint e uma pequena janela recente;
8. continuar a execução automaticamente, sem pedir ao usuário para começar outro chat;
9. manter o transcript original no banco para busca, auditoria e nova compactação.

Se a compactação falhar, não descartar a época antiga. Repetir com um modelo de resumo apropriado ou encerrar em estado recuperável. A memória durável não substitui o checkpoint: memória guarda fatos reutilizáveis; checkpoint guarda o estado exato do trabalho em andamento.

### 6.1 Padrão de contexto enxuto inspirado no Hermes Agent

Adotar a estratégia de compactação `lean` do Hermes Agent como referência, adaptada ao Postgres e aos runs duráveis do Atlas. O objetivo é continuidade de longo prazo sem reenviar o transcript inteiro ao OpenRouter.

Cada chamada recebe somente um pacote com orçamento explícito:

1. prompt e política fixa do bot;
2. `ContextCheckpoint` da tarefa em andamento;
3. resumo estruturado da época anterior;
4. memórias recuperadas por relevância;
5. uma cauda pequena de mensagens recentes completas;
6. mensagens do usuário que ainda sejam necessárias literalmente;
7. resultado de tool estritamente necessário para a próxima decisão;
8. reserva para resposta, tool calls e margem de segurança.

O pacote não pode ser montado a partir do array da interface. O frontend envia a mensagem atual; o `ConversationSessionService` compõe o restante a partir do estado persistido. Isso corrige os dois extremos atuais: não reenviar toda a conversa a cada turno e não iniciar uma tarefa nova sem continuidade suficiente.

### 6.1.1 Índice literal e recuperação por tools

Além do resumo gerado pelo modelo, manter um índice mecânico, sem paráfrase, para valores cuja alteração quebra o trabalho: IDs, URLs, caminhos de arquivo, comandos, hashes, números, mensagens de erro, referências de artefatos e resultados externos confirmados.

Expor tools de recuperação com escopo e limite de tamanho:

- `transcript_search`: busca trechos do transcript original, com referências à origem;
- `memory_search`: recupera fatos do perfil do usuário ou da memória privada do bot;
- `checkpoint_read`: lê o estado operacional da tarefa atual;
- `artifact_read`: recupera um arquivo, screenshot ou resultado persistido sob demanda.

Tools reduzem muito o risco de esquecimento, mas não substituem o pacote mínimo de contexto: o modelo pode não perceber que precisa buscar algo. Objetivo, checkpoint, resumo, últimas instruções do usuário e índice literal relevante devem estar presentes antes de cada decisão.

### 6.2 Montagem de contexto por orçamento de tokens

Antes de cada chamada:

1. obter `context_length` do modelo;
2. reservar espaço para resposta, tools e margem de segurança;
3. incluir prompt/política fixa;
4. incluir resumo acumulado da conversa;
5. recuperar memórias relevantes;
6. incluir tarefas abertas, decisões e artefatos do checkpoint;
7. preencher o restante com mensagens recentes completas.

Não usar quantidade fixa de mensagens como principal controle.

### 6.3 Compactação incremental protegida

Quando o prompt atingir cerca de 70–80% do orçamento:

- resumir o trecho antigo em formato estruturado;
- preservar fatos, preferências, decisões, entidades, compromissos, resultados de tools, IDs e tarefas pendentes;
- armazenar referências às mensagens de origem;
- validar que o novo resumo não contradiz o anterior;
- marcar o intervalo compactado, sem apagar o transcript original.

Usar lock por conversa/época, cooldown após falha e proteção contra compactação repetida do mesmo intervalo. A compactação `lean` mantém uma cauda curta e transfere continuidade para o resumo, checkpoint e índice literal; não mantém uma cauda gigante apenas para parecer segura.

Cada compactação deve registrar a `snapshotVersion` da conversa que leu. A substituição do contexto só pode ocorrer se essa versão ainda for a ativa; se uma mensagem, tool ou outro run alterar a conversa enquanto o resumo é gerado, manter a alteração nova e repetir ou reagendar a compactação. Isso impede que um resumo antigo sobrescreva uma instrução recente.

Compactação não deve atrasar a entrega da resposta ao usuário. O worker deve enfileirá-la depois do stream, entre decisões ou quando o agente estiver ocioso. Se a ocupação estiver crítica antes de uma nova chamada, compactar de forma síncrona apenas como último recurso e exibir o estado de preparação, sem parecer que o agente travou.

### 6.4 Handoff para novo modelo

Ao trocar modelo, estourar contexto ou falhar repetidamente:

- persistir `ContextCheckpoint`;
- escolher um modelo compatível com as tools e o tamanho do pacote;
- iniciar a próxima chamada com o checkpoint, memória e janela recente;
- registrar `fromModel`, `toModel` e motivo;
- executar uma verificação curta de continuidade: objetivo, progresso, pendências e próxima ação.

O modelo novo pode estar em um request novo, mas o usuário continua vendo a mesma conversa e a mesma execução.

### 6.5 Hierarquia de memória

Compactar normalmente mantém o mesmo DeepSeek escolhido pelo usuário. Contexto cheio não exige trocar de modelo. Fallback só usa modelos previamente permitidos pela política, com orçamento e capacidades compatíveis.

- **Perfil do usuário**: compartilhado entre agentes, controlado pelo usuário.
- **Memória do agente**: privada por bot.
- **Conhecimento compartilhado**: somente itens explicitamente promovidos para um espaço comum.
- **Transcript**: fonte íntegra e pesquisável.
- **Resumo/checkpoint**: continuidade operacional, versionada.

Um agente não deve ler silenciosamente toda a memória privada de outro. Criar uma tool de consulta com escopo, motivo e auditoria, retornando apenas trechos relevantes.

### 6.6 Contratos adicionais para delegação

**Persistência por anos.** Postgres é a fonte de verdade; não adicionar SQLite para memória principal. `USER.md` e `MEMORY.md`, se expostos, são visões importáveis/editáveis sincronizadas pelo mesmo serviço. Preservar IDs dos bots em migrações, indexar e paginar histórico, permitir exportação e testar restauração de backup. Arquivamento mantém recuperação por referência. Exclusões solicitadas invalidam também resumos, índices e memórias derivados.

**Curadoria.** Separar fatos duráveis do estado temporário da tarefa. Fatos têm fonte, escopo, data, versão e validade/substituição. Correções explícitas substituem fatos antigos; buscas normais não apresentam versões revogadas como atuais. Revisão de memória é idempotente por bot e intervalo processado. Manter um núcleo pequeno no prompt e recuperar o restante por relevância; limites atuais de caracteres não podem limitar o conhecimento guardado por anos. Migrar entradas existentes sem perder escopo e origem. Busca textual indexada e recuperação exata por ID são a base; ranking híbrido/embeddings é incremental e precisa demonstrar ganho nos testes.

**Tools.** Evoluir `session_search` e `memory` quando adequado, evitando implementações duplicadas só para mudar nomes. Consultas recebem texto/IDs, cursor e limite; retornam trechos, referências, escopo, versão/data e indicação de truncamento. Identidade e permissões vêm do runtime, não dos argumentos livres do modelo. Consulta a outro bot exige permissão explícita. Conteúdo recuperado é dado, não instrução privilegiada. Índice literal também tem orçamento e referências; não carregar todos os números/comandos de anos de histórico nem prometer extração perfeita por regex.

**Orçamento do prompt.** Seja `W` a janela efetiva, `O` a reserva de saída e `S` a margem; o teto de entrada é `B = W - O - S`. Contabilizar mensagens, schemas de tools, resultados e imagens conforme o modelo. Usar tokenizer compatível quando disponível e estimativa conservadora quando não; reconciliar com uso reportado. Limiar inicial: 75% de `B`, visando voltar abaixo de 50% de `B`, ambos configuráveis. Limitar também resumo e resultados de busca. Se o núcleo obrigatório não couber, parar de forma recuperável sem truncar instruções silenciosamente ou repetir requests excessivos.

**Histórico válido.** Compactar somente blocos concluídos; preservar pares de tool call/result e seus IDs. Resultados grandes e screenshots ficam como artefatos recuperáveis, transportando só o necessário. Preservar literalmente instruções recentes e restrições ainda vigentes; não injetar todas as mensagens do usuário para sempre. O resumo semântico não substitui o checkpoint técnico usado para evitar repetição de efeitos externos.

**Concorrência.** Capturar um limite de sequência estável e versão da época ao começar. Publicar só com versão válida; mensagens recebidas durante o resumo permanecem como sufixo não compactado e entram antes da próxima decisão. Conflitos descartam o candidato e reagendam com tentativas limitadas. Sob mensagens contínuas, compactar um prefixo concluído estável para evitar adiamento infinito. Lock tem lease e proteção contra escritor antigo. Crash antes do commit mantém época anterior; após o commit usa a nova. Cooldown não autoriza ultrapassar a janela. O composer permanece livre durante todo o processo.

**Validação e custo.** Testar várias compactações sucessivas com fixtures que superam duas janelas, fatos corrigidos, isolamento entre bots, busca de detalhe antigo, mensagem durante resumo, falha/crash antes e depois do commit, pares de tools válidos e troca para modelo com janela menor. Capturar requests com provedor simulado e comparar tokens incluindo chamadas auxiliares. Smoke real usa orçamento pequeno explícito. Tools não garantem esquecimento zero; cache, se suportado, é otimização adicional. Conversas curtas podem caber inteiras: o requisito é limitar crescimento em conversas longas, não remover contexto útil.

## 7. Navegador, logins e aplicativos

### 7.0 Política de janelas e abas

O agente deve trabalhar, por padrão, no mesmo `BrowserContext`, no mesmo perfil persistente e em uma aba principal por execução. Navegar para outra página nessa aba não pode trocar de container, perfil ou sessão autenticada.

Regras operacionais:

- cada `AgentRun` guarda `browserProfileId`, `browserContextId` e `activeTabId`;
- toda tool de browser recebe um `tabId` opcional; sem ele, usa a aba ativa do run;
- `navigate` reutiliza a aba ativa, em vez de criar página, contexto ou sandbox novos;
- uma nova aba só é criada quando o fluxo exigir, por exemplo OAuth, popup, comparação entre páginas ou pedido explícito do usuário;
- abas criadas pelo agente recebem IDs estáveis e são inventariadas; o agente deve voltar à aba de origem depois de concluir o fluxo auxiliar;
- popup de login permanece no mesmo `BrowserContext`, compartilhando cookies e storage compatíveis com o site;
- fechar uma aba nunca deve destruir o perfil, o contexto ou o container;
- após restart do control server, reconciliar as páginas existentes por URL/título e atualizar os IDs lógicos;
- se o site abrir uma nova página automaticamente, registrar o evento e selecionar essa página sem perder a referência da anterior;
- limitar a quantidade de abas e fechar apenas as que foram criadas pelo próprio run e já não são necessárias;
- diferentes runs do mesmo usuário só podem compartilhar perfil quando a política permitir; nunca misturar perfis de usuários diferentes.

Isso resolve o problema de “ir para outra página e perder o login”: autenticação pertence ao perfil/contexto, não à URL nem à aba. Manter tudo literalmente em uma única aba é o padrão mais simples, mas não pode bloquear OAuth e sites que abrem popups. Nesses casos, usa-se uma segunda aba temporária dentro da mesma sessão autenticada.

### 7.1 Sessão do navegador

Implementar perfil persistente por usuário ou por agente usando volume Docker dedicado. Como alternativa para sites compatíveis, exportar/importar `storageState` do Playwright de forma criptografada. `sessionStorage` exige captura e restauração adicional; cookies, localStorage e IndexedDB devem ser tratados conforme o provedor.

Nunca guardar senhas no prompt, transcript ou logs. Segredos devem ficar em um secret store; o agente recebe handles opacos.

Fluxo de login:

1. agente detecta autenticação necessária;
2. procura conexão/perfil válido;
3. se expirado, cria `ApprovalRequest`/`waiting_user` e abre o viewer no ponto certo;
4. usuário conclui senha, MFA ou consentimento;
5. backend valida que a sessão funciona e salva o estado permitido;
6. run é retomado do checkpoint automaticamente.

### 7.1.1 Pedir ajuda ao usuário na VM

Quando o agente encontrar uma etapa que só o usuário pode concluir — login, senha, credencial, MFA, CAPTCHA, consentimento OAuth ou confirmação fora da política do bot — ele não deve falhar, inventar uma resposta ou abandonar o run.

Implementar um `ApprovalRequest` persistido, vinculado ao `AgentRun`, ao `BrowserProfile` e à aba em que a ação é necessária. O worker deve mudar o run para `waiting_user`, emitir um evento e uma notificação acionável com link direto para o viewer da VM. O pedido precisa explicar em linguagem simples o que falta e oferecer ações de `abrir VM`, `retomar` e `cancelar`.

Regras:

- senha, código MFA e credenciais nunca entram no chat, logs, memória ou payload da tool;
- o usuário realiza a ação na VM ou conecta uma integração por fluxo OAuth próprio;
- ao receber a confirmação, o backend verifica a sessão/estado esperado antes de retomar o checkpoint;
- a notificação deve sobreviver a F5, worker reiniciado e navegador fechado;
- pedidos expirados ou recusados finalizam de modo explícito, sem deixar o run preso em `waiting_user`.

### 7.2 Apps como ferramentas de primeira classe

Criar `ToolRegistry` com manifesto por integração:

- nome e descrição para o modelo;
- schema de entrada/saída;
- capacidades e escopos OAuth;
- risco (`read`, `write`, `destructive`, `financial`);
- idempotência e política de retry;
- custo/timeout;
- adaptador API e fallback de navegador.

Começar com poucas integrações úteis e completas. GitHub, Gmail/Calendar e Drive são bons candidatos se fizerem parte do uso real. Não exibir gatilhos sem backend funcional.

Ordem de preferência: API estruturada do app, browser DOM e, por último, computer-use por coordenadas.

### 7.3 Evolução das ferramentas do navegador

Adicionar tools para:

- listar/criar/selecionar/fechar abas;
- snapshot de acessibilidade com referências estáveis;
- aguardar URL, elemento ou condição;
- upload/download e inventário de arquivos;
- dialogs, clipboard e PDFs;
- inspeção e restauração de storage autorizada;
- screenshot de página/elemento;
- limites de tamanho com paginação, sem cortar silenciosamente em 4.000 caracteres;
- detecção de login, CAPTCHA, MFA e bloqueios.

### 7.4 Entrevista inicial ao criar um bot

Depois de criar um bot, iniciar uma conversa de configuração curta e opcional. O agente deve usar nome, descrição, modelo escolhido e ferramentas permitidas para perguntar apenas o que melhora sua utilidade: objetivo, público, tom, limites, fontes, integrações, rotina desejada e critérios de conclusão.

As perguntas devem ser adaptativas: se a descrição já define algo, não perguntar de novo; se o modelo não suporta visão, por exemplo, não oferecer fluxo dependente de imagem. O usuário pode pular, responder depois ou editar essas definições nas configurações.

Respostas confirmadas alimentam a política/configuração do bot e sua memória privada; preferências globais explícitas vão para o perfil do usuário. Criar um bot nunca deve disparar ações externas, abrir VM ou salvar suposições como fatos.

## 8. Rotinas e execução em segundo plano

Interpretando “ChromeJobs” como cron jobs: o agendamento deve acontecer no servidor, independente do Chrome do usuário.

Usar BullMQ Job Schedulers na versão compatível instalada, ou um scheduler equivalente. O scheduler apenas dispara; o Postgres mantém a fonte de verdade da rotina e do histórico.

O desenho correto separa cadastro, disparo e execução:

1. a API salva a rotina no Postgres e calcula `nextRunAt` no timezone escolhido;
2. um serviço de scheduler sincroniza rotinas ativas com o BullMQ Job Scheduler;
3. no horário devido, o scheduler cria um disparo pequeno e idempotente;
4. o consumidor cria `RoutineRun` e `AgentRun` em transação, usando uma chave única;
5. o worker agêntico executa a instrução usando o mesmo runtime do chat;
6. passos e eventos são persistidos durante o trabalho;
7. ao terminar, o sistema atualiza histórico, próxima execução e notificação;
8. se o worker cair, outro worker retoma pelo checkpoint sem repetir efeitos externos.

O Chrome e a interface do usuário não participam do relógio. Quando uma rotina precisar do navegador, o worker recupera o `BrowserProfile` autorizado e inicia ou acorda uma sandbox no servidor. Se a autenticação tiver expirado, a rotina muda para `waiting_user`, notifica o usuário e continua depois da reautenticação.

Requisitos:

- salvar timezone IANA e regra normalizada;
- calcular e exibir próxima execução;
- criar `RoutineRun` e `AgentRun` com chave única por rotina + instante agendado;
- impedir duplicidade em retry ou múltiplas réplicas;
- suportar pausa, retomada, execução manual e backfill controlado;
- separar fila de chat interativo, execução agêntica e manutenção de memória;
- definir concorrência por usuário/agente e rate limits por provedor;
- registrar resultado e notificar apenas quando configurado ou quando houver ação necessária.

Para webhooks, validar assinatura, guardar o evento bruto com retenção e deduplicar pelo ID do provedor. Integrações como Slack e Git só entram quando o respectivo app/conector existir de verdade.

## 9. Contratos de API e interface

### API mínima

- `POST /v1/runs`: cria uma execução e retorna `runId` imediatamente.
- `GET /v1/runs/:id`: snapshot do estado.
- `GET /v1/runs/:id/events?after=seq`: replay/polling.
- `GET /v1/runs/:id/stream?after=seq`: SSE reconectável.
- `POST /v1/runs/:id/cancel|pause|resume`.
- CRUD `/v1/routines` e `/v1/routines/:id/run`.
- CRUD de conexões e perfis sem expor segredos.
- endpoint para responder `ApprovalRequest`.

SSE deve enviar `id: seq`; o cliente usa `Last-Event-ID` ou `after`. WebSocket não é necessário para o primeiro corte.

### Interface

- Ao enviar, guardar `runId` e navegar/assinar a execução.
- Ao dar F5, buscar runs ativos da conversa e refazer a assinatura.
- Mostrar estados reais: na fila, executando, aguardando você, pausado, concluído, falhou.
- Mostrar plano atual, passo em curso, tempo/custo consumido e resultado; detalhes técnicos ficam recolhidos.
- Permitir cancelar, pausar, retomar e aumentar orçamento conscientemente.
- Persistir rascunho do composer por conversa antes do envio.
- Persistir o modelo no bot/política no backend; cache local serve apenas para resposta imediata da UI.
- Vincular o estado visual do avatar ao estado operacional real.
- Quando um run estiver em `waiting_user`, exibir o pedido pendente e abrir a VM no estado exato em que o agente parou.
- Ao criar um bot, iniciar a entrevista de configuração adaptativa e permitir pular ou retomar depois.

### Mensagens durante uma execução ativa

O composer deve permanecer habilitado enquanto o agente trabalha. Uma mensagem nova não inicia silenciosamente um segundo run concorrente: ela entra na caixa de entrada persistente do run atual.

Comportamento recomendado:

- **Enviar agora** é o padrão: cria um `RunInput` no modo `steer`; o agente lê a mensagem no próximo ponto seguro e ajusta o plano atual.
- **Enviar depois** cria um `RunInput` no modo `queue`; ele vira o próximo objetivo somente depois que o run atual atingir um estado terminal.
- **Parar** é uma ação separada; solicita cancelamento e não deve ser inferida de uma mensagem comum.
- Mensagens como “use outro site”, “não envie ainda” ou “considere também X” devem orientar o run em andamento.
- Se o agente estiver executando uma tool, a mensagem não interrompe a operação no meio. O worker a incorpora logo após a tool terminar, antes da próxima chamada ao modelo.
- Para tools demoradas que suportem cancelamento seguro, o runtime pode cancelar quando a mensagem exigir mudança incompatível.
- Cada passo do modelo recebe todos os `RunInput` pendentes em ordem, confirma o que incorporou e os marca como `consumed` na mesma transação do checkpoint.
- O frontend mostra “enviada”, “na fila” e “incorporada pelo agente”, para o usuário saber se a correção já foi lida.
- Após F5, mensagens pendentes reaparecem porque pertencem ao backend, não ao estado React.
- Várias abas podem enviar mensagens usando uma chave de idempotência; a sequência do servidor define a ordem e evita duplicação.
- Se o run terminar entre o envio e o consumo, o backend cria um novo run encadeado ou pede ao usuário que escolha, conforme o modo selecionado.

API sugerida:

- `POST /v1/runs/:id/inputs` com `content`, `mode` e `idempotencyKey`;
- `GET /v1/runs/:id/inputs` para reconciliar o estado da interface;
- eventos `run.input_received` e `run.input_consumed` no stream persistente.

No worker, consultar a caixa de entrada antes de cada chamada ao modelo e imediatamente após cada resultado de tool. Opcionalmente, usar um sinal Redis para acordar o worker, mantendo o Postgres como fonte de verdade. Isso produz o comportamento de mensagens “em fila” visto em outros agentes sem acoplar a execução à aba.

## 10. Segurança mínima para sair do ambiente local

Antes de hospedar para outras pessoas:

- autenticação e autorização em todas as rotas;
- filtro obrigatório por `userId` em todas as consultas;
- rate limit, quotas e limite de custo;
- segredos criptografados e redaction de logs;
- política de egress e proteção contra SSRF nas URLs do navegador;
- allowlist/denylist de tools por agente;
- confirmação para efeitos sensíveis conforme política do produto;
- auditoria de tool calls e downloads;
- sandbox sem Docker socket diretamente na API pública; usar um serviço isolado de provisionamento;
- limites de CPU, memória, processos, disco, rede e duração;
- atualização e varredura da imagem de sandbox.

## 11. Plano de implementação por entregas

### Entrega 0 — Estabilizar a base

1. Inspecionar o estado Git e preservar alterações existentes; commit somente com nova autorização.
2. Atualizar README e diagramar o fluxo real.
3. Criar testes de fumaça para API, worker, Postgres, Redis e sandbox.
4. Reproduzir o limite observado de 8 passos e registrar o motivo.
5. Medir custo, tokens, duração e erros do fluxo atual em três tarefas reais.

Critério de aceite: stack completa sobe; uma tarefa de navegador usa pelo menos 10 ações e termina; reiniciar a API reencontra a sandbox; resultados ficam documentados.

### Entrega 1 — Runs duráveis e F5 seguro

1. Criar tabelas `AgentRun`, `AgentStep`, `RunEvent`, `RunInput` e `Artifact`.
2. Extrair o runtime agêntico da rota HTTP.
3. Criar fila/worker de runs e lease com heartbeat.
4. Transformar a API em produtora de jobs.
5. Implementar eventos persistidos e SSE reconectável.
6. Reconectar o frontend pelo `runId` após F5.
7. Implementar cancelamento e retry seguro.
8. Manter o composer habilitado e implementar mensagens `steer`/`queue` durante o run.

Critério de aceite: iniciar tarefa, enviar uma correção enquanto uma tool está rodando e verificar que ela é incorporada antes da próxima decisão; enfileirar um objetivo para depois; fechar a aba, aguardar, reabrir e ver o resultado completo; reiniciar API durante execução sem perder o job; reiniciar worker e retomar do último checkpoint seguro.

### Entrega 2 — Contexto adaptativo e handoff

1. Criar `ConversationSessionService` e `ModelContextEpoch` como fonte única do contexto operacional.
2. Criar contador/estimador de tokens por modelo e reservar saída, tools e margem.
3. Montar o pacote enxuto: política, checkpoint, resumo, memórias relevantes, cauda recente e mensagens essenciais do usuário.
4. Criar resumos incrementais versionados, com lock por época, `snapshotVersion`, cooldown de falha e compactação síncrona somente perto do limite duro.
5. Criar índice literal para IDs, URLs, paths, comandos, erros, números e artefatos; esses valores não podem depender de paráfrase do modelo.
6. Implementar `transcript_search`, `memory_search`, `checkpoint_read` e `artifact_read`, todos com escopo, referências e limite de tamanho.
7. Criar `ContextCheckpoint` e fallback/rotação de modelos sem criar outro chat ou outro run visível.
8. Remover limites baseados somente em número de mensagens e impedir que o frontend seja a fonte do histórico enviado ao modelo.

Critério de aceite: cumprir os testes da seção 6.6. Conversas longas mantêm entrada limitada, preservam fatos, decisões, IDs e pendências e recuperam detalhes pela fonte. Demonstrar tokens antes/depois incluindo resumos. Erro de contexto do provedor recebe recuperação limitada e não causa perda do histórico.

### Entrega 3 — Orçamento e autonomia

1. Implementar limites brando/duro, tempo, tokens e custo.
2. Detectar loops por assinatura de ação/resultado.
3. Medir progresso e permitir extensão automática controlada.
4. Adicionar estados `waiting_user` e `budget_exhausted`.
5. Expor orçamento e consumo na interface.

Critério de aceite: cumprir os testes da seção 5.3.1. Tarefas avançam além de 30 decisões quando permitido; loops param com diagnóstico; retry, restart e compactação não zeram consumo. O backend aplica limites e registra diferença entre custo estimado e reportado. Esgotamento preserva checkpoint e exige extensão explícita para retomar.

### Entrega 4 — Browser persistente e login assistido

1. Persistir perfil por usuário/agente em volume dedicado.
2. Criar ciclo de `BrowserProfile` e validação de sessão.
3. Implementar pausa para login/MFA e retomada.
4. Expandir tools de browser e testes de navegação.
5. Definir TTL, backup, revogação e limpeza de perfis.

Critério de aceite: login de teste continua após F5, reinício da API e suspensão/retomada do container; ao expirar, o usuário autentica e o mesmo run continua.

### Entrega 5 — Rotinas reais

1. Persistir rotina/gatilhos no banco.
2. Implementar scheduler server-side e deduplicação.
3. Executar rotina através do mesmo `AgentRun`.
4. Criar histórico, próxima execução e execução de teste.
5. Implementar timezone, pause/resume e notificações.

Critério de aceite: rotina dispara com navegador do usuário fechado, não duplica após retry e aparece no histórico com resultado e custo.

### Entrega 6 — Apps

1. Criar `ToolRegistry`, `AppConnection` e `ToolGrant`.
2. Implementar uma integração somente leitura ponta a ponta.
3. Implementar uma integração com escrita e idempotência.
4. Adicionar OAuth, renovação/revogação e auditoria.
5. Usar navegador como fallback declarado.

Critério de aceite: agente escolhe a tool do app, mantém autenticação e nunca duplica uma ação após retry.

### Entrega 7 — Escala multiusuário e produção (futuro)

Esta entrega não faz parte do escopo atual: o Atlas será uma instalação pessoal, com uma única conta e seus vários bots. Ela só será retomada se pessoas diferentes precisarem usar a mesma instalação.

1. Adicionar identidade e ownership.
2. Remover o uso global de `default`.
3. Isolar filas, sandboxes, perfis, memória e custos.
4. Separar provisionamento Docker da API pública.
5. Adicionar métricas, tracing, alertas, dead-letter e painel operacional.

Critério de aceite: testes demonstram isolamento entre dois usuários e dois agentes; falhas podem ser rastreadas por `runId`; limites financeiros e operacionais são aplicados.

## 12. Testes essenciais

### Durabilidade

- F5, fechar aba, desconectar rede e reconectar.
- enviar mensagens durante uma completion e durante uma tool longa;
- ordenar duas mensagens simultâneas vindas de abas diferentes;
- deduplicar o reenvio da mesma mensagem após falha de rede;
- garantir que `steer` seja consumido antes da próxima decisão e `queue` somente após o run atual;
- reiniciar API durante o run;
- encerrar worker entre dois passos;
- retry após tool externa ter concluído;
- evento SSE duplicado, atrasado e replay após sequência.

### Contexto

- conversa acima de 1x e 2x a janela do modelo;
- troca de modelo durante uma tarefa;
- memória relevante versus memória irrelevante;
- resumo preserva IDs, números, decisões e pendências;
- busca entre agentes respeita escopo.

### Sandbox e login

- cookies/localStorage/IndexedDB após suspensão e reinício;
- sessão expirada, MFA e CAPTCHA;
- duas abas e popup OAuth;
- download/upload;
- container removido e recuperação controlada;
- isolamento entre usuários.

### Rotinas

- timezone e horário de verão;
- atraso do scheduler;
- duas réplicas de worker;
- retry sem execução duplicada;
- rotina pausada no instante de disparo;
- navegador do usuário fechado.

### Segurança e custo

- SSRF para IPs internos/metadados;
- prompt injection em página web e memória;
- segredo ausente em logs/eventos;
- orçamento duro sob loop;
- autorização de bot, conversa, run e perfil.

## 13. Observabilidade

Registrar por `runId`, sem segredos:

- tempo na fila e tempo de execução;
- passos, retries e chamadas por tool;
- tokens e custo por modelo;
- taxa de conclusão, falha, cancelamento e espera por usuário;
- compactações e trocas de modelo;
- sessões de sandbox ativas, suspensas e removidas;
- rotinas atrasadas/duplicadas;
- causa terminal normalizada.

Criar dashboards e alertas somente após os eventos e métricas terem contratos estáveis.

## 14. Decisões que não devem ser tomadas como atalhos

- Apenas aumentar `MAX_STEPS`.
- Apenas salvar mais mensagens no prompt.
- Usar localStorage/sessionStorage como fonte de verdade.
- Fazer cron no frontend ou depender de uma aba aberta.
- Guardar credenciais em memória do agente.
- Criar um sandbox novo por navegação ou por passo.
- Executar ações externas sem chave de idempotência.
- Permitir que qualquer agente leia toda a memória de todos os outros.
- Tratar SSE como mecanismo de durabilidade.

## 15. Ordem recomendada para o DeepSeek

Implementar primeiro Entrega 1, depois Entregas 2 e 3. Elas resolvem o problema estrutural: execução presa à aba, perda de continuidade e limite arbitrário. Em seguida fazer login persistente e rotinas. Apps entram sobre esse runtime comum; escala multiusuário fica para uma fase futura, caso a instalação deixe de ser pessoal.

Para cada entrega:

1. ler o `AGENTS.md` aplicável e a documentação do Next instalada antes de alterar `apps/web`;
2. produzir migração pequena e reversível;
3. manter contratos em `packages/shared`;
4. adicionar testes de falha/restart, não apenas caminho feliz;
5. atualizar este documento com decisões reais;
6. rodar typecheck, testes e um cenário ponta a ponta;
7. não misturar redesign visual amplo com mudanças do runtime.

## 16. Evidências da revisão

- Typecheck: aprovado, 9/9 tarefas.
- Runtime local observado em 14/09/2026: somente Postgres e Redis estavam ativos e saudáveis.
- API, worker, web e sandbox não estavam ativos no momento da inspeção; portanto, a VM não foi validada ponta a ponta.
- Limite encontrado: 16 passos por padrão, teto de 30 na rota de computer-use e 4 passos no revisor de memória.
- Referências técnicas usadas para orientar o desenho: documentação oficial de BullMQ Job Schedulers/idempotência, Playwright authentication/storage state e OpenRouter tool calling.


## 17. Skills criadas automaticamente a partir do trabalho

Adendo de planejamento em 19/09/2026. A menção a skills estáticas na seção 2.3 não especificava aprendizagem procedural automática. Esta seção acrescenta esse escopo; não afirma que ele já foi implementado ou que o código atual foi auditado. Não inclui o diagnóstico de cancelamento por aparente inatividade do avatar, tratado em outra frente.

### 17.1 Objetivo e fronteiras

O Atlas deve transformar procedimentos comprovados em skills reutilizáveis, recuperadas quando relevantes. Isso melhora o repertório operacional sem treinar pesos do modelo. Memória guarda fatos e preferências; checkpoint guarda o trabalho em andamento; skill guarda quando e como executar um procedimento e verificar seu resultado.

Uma skill não concede permissões, não modifica a política do bot e não transforma conteúdo de páginas ou documentos em instruções do usuário. Ações externas continuam sujeitas à autorização da tarefa e ao ToolGrant vigente. Na primeira entrega, gerar somente instruções declarativas e referências a tools existentes; scripts executáveis, instalação de dependências e autoalteração do runtime ficam fora do escopo.

### 17.2 Contratos propostos

Adaptar nomes às entidades já existentes antes de criar migrações:

- `Skill`: ID, proprietário, escopo privado do bot ou compartilhado explicitamente, chave de capacidade, descrição curta, versão ativa e estado habilitado/desabilitado.
- `SkillVersion`: versão imutável, conteúdo, hash, precondições, entradas, passos, tools necessárias, pós-condições, restrições, compatibilidade e status `draft`, `validating`, `active`, `rejected` ou `retired`.
- `SkillEvidence`: referências autorizadas a run, passos e artefatos; resultado verificado e origem da evidência. Não copiar o transcript inteiro nem segredos.
- `SkillEvaluation`: versão, casos, resultados, limitações, tokens e custo da validação.
- `SkillUsage`: run, versão fixada, resultado, evidência, custo e motivo de abandono.
- `SkillLearningJob`: run de origem, versão do extrator, chave de deduplicação, estado, tentativas e orçamento persistido.

Postgres é a fonte de verdade. Um `SKILL.md` pode ser exportado, mas não deve ser lido automaticamente de diretórios arbitrários como instrução confiável. Isolar escopo já na instalação pessoal: um bot não publica dados privados para outros bots por padrão.

### 17.3 Orquestração do aprendizado

Fluxo: `resultado persistido -> triagem barata -> candidato -> deduplicação -> extração -> validação -> promoção -> recuperação futura -> medição`.

1. Após um resultado verificável e persistido, registrar intenção de aprendizagem em outbox transacional. Um consumidor publica o job na fila de manutenção. A resposta principal não espera esse processamento; falha de aprendizagem não altera o resultado do run.
2. Aplicar triagem determinística antes de chamar modelo: houve procedimento reutilizável, evidência suficiente e orçamento? Ignorar respostas triviais, repetições já cobertas e execuções canceladas ou inconclusivas. Uma recuperação de erro só vira procedimento depois de ter resultado confirmado.
3. Deduplicar por run e versão do extrator; procurar skill equivalente dentro do escopo permitido. Se já existir e continuar válida, acrescentar evidência, sem gerar outra skill. Se houver melhoria material, propor nova versão vinculada à anterior.
4. Um extrator com modelo econômico configurável recebe somente passos e evidências relevantes, sanitizados e limitados por tokens. Produz estrutura validável com gatilho, precondições, parâmetros, procedimento, falhas conhecidas e critério de conclusão. Não salvar raciocínio interno nem credenciais, cookies, tokens ou informações particulares como receita genérica.
5. Validação determinística confere schema, referências, tools disponíveis, parâmetros, permissões e ausência de segredos. Tratar instruções encontradas no material de origem como dados não confiáveis; rejeitar tentativas de elevar privilégios ou substituir políticas.
6. Avaliar em fixtures ou sandbox sem efeitos externos reais. Incluir um caso positivo, um caso em que a skill não se aplica e um caso de falha relevante. Uma segunda opinião de modelo, sozinha, não comprova sucesso. Quando a avaliação exigir credenciais ou ações reais sem autorização, manter como rascunho.
7. Promover automaticamente apenas versões declarativas que passem nos critérios e permaneçam no escopo permitido. Não pedir confirmação a cada skill inofensiva. Publicar versão ativa com comparação de versão/lock por capacidade para evitar promoções concorrentes conflitantes; preservar versões anteriores.
8. Registrar eventos e disponibilizar inspeção, edição, desativação e reversão. Aprendizagens rotineiras aparecem no histórico, sem notificação a cada execução.

### 17.4 Uso durante novas tarefas

Antes do planejamento, buscar metadados de skills ativas relevantes ao objetivo, escopo e tools disponíveis. Começar com busca lexical e filtros; só adicionar ranking mais caro após medir necessidade. Carregar conteúdo completo de poucas candidatas dentro de uma parcela explícita do orçamento de contexto da seção 6.

Revalidar aplicabilidade, conexões e permissões no momento do uso. Fixar IDs/versões no checkpoint; uma atualização em segundo plano não muda silenciosamente um run em curso. Uma revogação de segurança bloqueia o uso futuro da versão também em retomadas e provoca replanejamento seguro.

Executar os passos pelo runtime comum, com idempotência, orçamento e evidências de conclusão. A skill orienta o plano; não dispensa observação do estado real. Se uma precondição falhar, abandonar ou adaptar o procedimento dentro da tarefa autorizada. Registrar falha com causa: login expirado não prova que a receita está errada. Regressão confirmada permite desativar a versão e voltar à anterior validada.

### 17.5 Custo, concorrência e durabilidade

- Fila de manutenção com prioridade inferior à execução interativa; nenhuma chamada de aprendizagem por passo.
- Limites configuráveis por job e por dia para tokens, dinheiro, candidatos e tentativas. Reservar custo antes da chamada e reconciliar depois, conforme seção 5.3.1. Contabilizar também avaliação, retries e chamadas auxiliares no teto global.
- Ponto de partida proposto: até um candidato por run elegível, uma extração e uma correção de schema, sem cadeia aberta de revisores. Se faltar evidência ou orçamento, adiar ou rejeitar com motivo.
- Job de aprendizagem não produz outro job de aprendizagem. Usos rotineiros de uma skill ativa só acumulam métricas, salvo melhoria ou falha material.
- Idempotência no consumidor, unicidade no banco e outbox recuperável. Retry/restart não duplica versões nem zera consumo. Antes de gerar, conferir novamente se outro worker já resolveu o candidato.
- Medir custo de extração/validação e custo das execuções futuras. Não prometer economia sem comparar tarefas equivalentes e taxa de sucesso.

### 17.6 Entrega 6A — Implementação pelo próximo modelo

Inserir depois das Entregas 1, 2 e 3 e do contrato de tools/permissões da Entrega 6. O catálogo declarativo pode começar com tools já disponíveis; não depende de terminar todas as integrações nem da futura escala multiusuário.

1. Conferir implementação atual e alterações de outros agentes; mapear os contratos acima para banco, shared, runtime e worker existentes. Não recriar infraestrutura que já funciona.
2. Implementar armazenamento versionado, escopo, busca e carregamento de uma skill cadastrada manualmente; verificar que o runtime aplica permissões e fixa versão no checkpoint.
3. Implementar outbox, fila de aprendizagem, triagem e deduplicação. Inicialmente salvar somente rascunhos e custos.
4. Implementar extrator limitado, avaliador e promoção atômica atrás de flag de configuração. Validar em fixtures antes de habilitar promoção automática.
5. Integrar uso, evidências, métricas, desativação e rollback. Acrescentar uma interface pequena de skills aprendidas com origem e versão, sem redesign amplo.
6. Habilitar gradualmente e atualizar este plano com resultados reais. Nenhuma alteração no diagnóstico de inatividade do avatar faz parte desta entrega.

Critérios de aceite:

- Duas tarefas equivalentes comprovadas reutilizam uma única skill sem duplicação; tarefa não relacionada não a carrega.
- Reiniciar worker entre geração, persistência e promoção não perde o job, duplica a versão ou repete efeitos externos.
- Documento com prompt injection, segredo na evidência e tentativa de acesso entre bots são bloqueados pelos controles pertinentes.
- Rascunho não validado nunca entra no contexto operacional; falta de tool/permissão impede execução; avaliação não realiza escrita externa real.
- Atualização concorrente preserva consistência, retomada mantém versão fixada e revogação impede nova execução da versão revogada.
- Falha ou orçamento esgotado na aprendizagem não cancela o run original; tentativas permanecem limitadas e consumo persiste.
- Demonstrar custo e resultado com e sem recuperação da skill em cenários equivalentes; registrar limitações, sem declarar melhoria apenas porque um arquivo foi criado.

Escopo desta revisão: planejamento somente. Implementação, testes de código, commit e push não foram realizados por este adendo.
