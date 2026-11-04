import type { ToolResultStatus, StepTelemetry, RunStop, ContextMemory, ChatMessage, BotLanguageSetting, EffectiveAutonomy, ComputerUseEvent, ReasoningEffort, AgentRunCheckpoint, OpenBotRequest, HistoryImageGroup, SerializedLlmMessage, ToolCacheState, ProactiveSettings, RoutineRecord } from "@workspace/shared";
import type { FileEvent, CreateFileDeps } from "./tools/create-file.js";
import type { TokenUsage, AgentBudgetPolicy } from "./budget.js";
import type { ProviderHealth } from "./tools/provider-health.js";
import type { ModelTiersRuntime } from "./model-tiers.js";
import type { SandboxManager } from "@workspace/sandbox";
import type { DelegateDeps } from "./tools/delegate-task.js";
import type { DevSessionRuntimeDeps } from "./tools/dev-session.js";
import type { PreviewSetupToolContext } from "./tools/preview-setup/tool.js";
import type { ContextBudget } from "./context/budget.js";
import type { NativeComputerMode, CompleteChatWithToolsParams, StreamChatWithToolsHandlers, CompleteChatWithToolsResult } from "@workspace/llm";
import type { McpRuntime } from "./mcp/runtime.js";
import type { ApiConnectorRuntime } from "./api-connector/runtime.js";
import type { LessonCandidate } from "./mcp/connector-guide.js";
import type { RunLessonsParam } from "./lessons.js";
import type { HookLesson } from "./hooks/pre-tool.js";
import type { EmailRunContext } from "./email/tools.js";
import type { SkillsStore } from "./tools/skills.js";
import type { getBotProfile } from "@workspace/db";
import type { RunCodeDeps } from "./tools/run-code.js";
import type { OwnerWaitDeps } from "./tools/schedule-return.js";
import type { PagesStore, PageShareStore } from "./tools/pages.js";
import type { ResearchNotes } from "./tools/research-note.js";
import type { AttachmentRuntime } from "./attachments/runtime.js";
import type { VaultService } from "./secrets/vault-service.js";
import type { RunSignalSubscribe } from "./loop/interrupt.js";
import type { JevMcpMode, JevMcpEvaluator } from "./mcp/jev-gate.js";
import type { JevRuntime } from "./jev/decide.js";
import type { UserPushMode } from "./tools/proactive.js";
import type { AlertRunState } from "./tools/report-alert.js";
import type { AlertRuleReader } from "./tools/alert-rule.js";
import type { PageValueFinder } from "./tools/find-page-value.js";

export type CompletedToolReplay = {
	summary: string;
	ok: boolean;
	imageArtifactId?: string;
	/** Status estruturado gravado na execução original (L20). */
	status?: ToolResultStatus;
	/** Card de arquivo da execução original: reentregue sem recriar o arquivo. */
	file?: FileEvent;
};

/** subIndex do passo que registra as tools oferecidas (entre o model 0 e o 1). */
export const OFFERED_TOOLS_SUB_INDEX = 98;

export type RuntimeStepRecord = {
	decisionIndex: number;
	subIndex: number;
	type: "model" | "tool" | "tool_result" | "checkpoint";
	status: "running" | "completed" | "failed" | "skipped";
	idempotencyKey?: string;
	inputJson?: unknown;
	outputJson?: unknown;
	/** Tokens (prompt+completion) da decisão, quando medidos. */
	tokens?: number;
	/** F0: duração do passo em ms (modelo ou tool), quando medida. */
	durationMs?: number;
	/** F0: custo real do passo (OpenRouter), ausente quando desconhecido. */
	costUsd?: number;
	/** F0: telemetria só de metadados; o worker grava em `outputJson.telemetry`. */
	telemetry?: StepTelemetry;
};

export type RunComputerUseResult = {
	text: string;
	model: string;
	hitWall: boolean;
	usage: TokenUsage;
	/** Só com `backgroundObserveChecks`: termina quando as checagens de observação terminam; uso delas (ou `null`). */
	observeChecks?: Promise<TokenUsage | null>;
	/** Por que o run terminou sem erro (medição, F0 do ADR 0002). Não muda nada do loop. */
	stop?: RunStop;
};

export type ComputerUseParams = {
	/** Provedores sem créditos do run pai: o subagente herda (não repete a falha em cada filho). */
	providerHealth?: ProviderHealth;
	/** Modelo dos subagentes do bot (null/ausente = igual ao do pai). */
	subagentModel?: string | null;
	/**
	 * Modelo para código já resolvido (bot > conta) e conferido contra os provedores do
	 * usuário pelo worker. Vale a partir do início de um run com sessão de código ativa,
	 * ou logo depois de `dev_session_start`. Ausente = segue o modelo do run.
	 */
	codingModel?: string | null;
	/**
	 * Modo Automático (composer): modelos por dificuldade. O runtime classifica o pedido, usa o
	 * modelo do nível e sobe de nível quando o run trava. Ausente = o modelo do run, como sempre.
	 */
	modelTiers?: ModelTiersRuntime;
	/** Confere se um id de modelo existe (autoriza o `model` do delegate_task). */
	isKnownModel?: (modelId: string) => boolean | Promise<boolean>;
	/** Janela de contexto de um modelo no catálogo (dimensiona o orçamento do subagente). */
	getModelContextLength?: (modelId: string) => number | null | Promise<number | null>;
	manager: SandboxManager;
	/** Cria/reusa o sandbox sob demanda (só quando uma tool de sandbox é usada). */
	getSessionId: (context?: { signal?: AbortSignal; deadlineAtMs?: number }) => Promise<string>;
	/** Sessão da VM que o run já tem, sem criar nem reiniciar nada (null = nenhuma). */
	peekSessionId?: () => string | null;
	sandboxEnabled?: boolean;
	/** Disciplina de execução (ledger, referências, estagnação, lote). Omitido = `ATLAS_EXECUTION_DISCIPLINE`. */
	executionDiscipline?: boolean;
	/** Economia de contexto (tools nativas adiadas, prompt por intenção, resultado por referência). Omitido = `ATLAS_CONTEXT_ECONOMY`. */
	contextEconomy?: boolean;
	/** V8: expõe `delegate_task` com `mode: "browser_item"`. Omitido = `ATLAS_BROWSER_SUBAGENTS` (desligado). */
	browserSubagents?: boolean;
	/** Persistência dos subagentes (teste e harness injetam; omitido = banco). */
	delegateDeps?: DelegateDeps;
	/** V8 (só filho): aba própria do navegador; as tools de browser agem nela. */
	browserTabId?: string;
	/** Sessão de desenvolvimento: dependências injetáveis (teste); omitido = Docker + banco, só com DEV_SANDBOX_ENABLED. */
	devSession?: Pick<DevSessionRuntimeDeps, "provider" | "config" | "store" | "getGithubToken" | "makeClient"> | null;
	/** Configuração da prévia completa (injetável em teste; omitido = banco, só para o administrador; `null` = desligada). */
	previewSetup?: PreviewSetupToolContext | null;
	/** Filho de leitura: conversa cuja sessão de desenvolvimento ele pode ler (read_file/list_files/grep). */
	devConversationId?: string;
	/** Orçamento operacional de contexto (alvo/teto em tokens). Omitido = env (`ATLAS_CONTEXT_BUDGET_*`) ou 12k/20k. Só vale com a economia ligada. */
	contextBudget?: ContextBudget;
	/**
	 * Memória da conversa da conta: standard (padrão) resume a parte antiga perto do limite do modelo;
	 * economy enxuga cedo (12k/20k, sem resumo). Subagentes sempre usam o orçamento econômico.
	 */
	contextMemory?: ContextMemory;
	/** Fuso IANA da conta para a nota de hora do bot. Ausente ou inválido = América/São Paulo. Subagentes não levam a nota. */
	timeZone?: string;
	/** F12/C4: sobrescreve `COMPUTER_NATIVE_MODE` (off|shadow|on); usado em teste. */
	nativeComputerMode?: NativeComputerMode;
	model: string;
	apiKey: string;
	messages: ChatMessage[];
	/** Idioma do bot: fixo ou "auto" (ver `resolveReplyLanguage`). Subagente recebe o idioma já resolvido do pai. */
	language?: BotLanguageSetting;
	/** Só para "auto": último idioma detectado e locale da conta (ver `getLanguageContext`). */
	languageContext?: { lastLanguage?: string | null; accountLocale?: string | null };
	botId?: string;
	userId?: string;
	conversationId?: string;
	runId?: string;
	/** Origem do AgentRun (chat | routine | subagent | …). */
	origin?: string;
	/** Origem do run pai quando `origin` é `subagent` (a política em sombra herda a do pai). */
	parentOrigin?: string;
	/** `humanTurn` do run pai quando `origin` é `subagent` (a política em sombra herda). */
	parentHumanTurn?: boolean;
	/**
	 * A mensagem que abriu o run foi DIGITADA pelo dono no chat (gravada pela API, lida pelo worker). Run `chat`
	 * sintético (worker de grupo, proativo, questionário, retomada) vem sem ela: ausente = falso.
	 */
	humanTurn?: boolean;
	/**
	 * Filtro final de tools (F5): aplicado DEPOIS dos filtros de origem/autonomia
	 * sobre as tools nativas e as MCP (inclusive as ativadas por
	 * `mcp_tool_search`). Só restringe, nunca acrescenta.
	 */
	toolFilter?: (name: string) => boolean;
	/**
	 * Subagente: tools MCP de leitura já carregadas na largada (as do pai +
	 * Firecrawl). Passam pelo `toolFilter`; catálogo não adiado já as expõe.
	 */
	preactivateMcpTools?: string[];
	/**
	 * Agente principal: conectores citados pelo usuário com `@App` neste turno (nome ou prefixo do app).
	 * As tools deles entram já no 1º passo, pelo mesmo caminho de ativação (teto, autonomia, toolFilter).
	 */
	forcedConnectors?: string[];
	/**
	 * `AgentRun.objective` (pedido original deste run). Usado para: (1)
	 * detectar evento de config do bot (bot-created) mesmo
	 * quando o marcador não sobrevive em `messages`; (2)
	 * gravar a ORIGINAL REQUEST no card de questionário de tarefa.
	 */
	objective?: string;
	/** Conectores MCP carregados pelo caller (`loadMcpRuntime`). */
	mcp?: McpRuntime | null;
	/** APIs conectadas por OpenAPI carregadas pelo caller (`loadApiConnectorRuntime`). */
	apiConnector?: ApiConnectorRuntime | null;
	/** Falha seguida de sucesso no mesmo conector: o caller enfileira a lição (sugestão ao dono, nunca aplicada sozinha). */
	onConnectorLesson?: (lesson: LessonCandidate) => void | Promise<void>;
	/** Lições ativas do bot (memória procedural): conector/tool entram ao carregar o conector; `lesson_feedback` conta o uso. */
	lessons?: RunLessonsParam;
	/** Regras das lições aplicadas antes de cada ferramenta (hooks). Padrão: as regras de `lessons.items`. */
	preToolRules?: readonly HookLesson[];
	/** "Planejar antes de tarefas grandes" do bot (padrão ligado): `false` esconde `propose_plan`. */
	planMode?: boolean;
	/** Há um plano esperando aprovação nesta conversa: escritas voltam com erro até a decisão. */
	planPending?: boolean;
	/** Inspetor: acertos do portão do plano e das regras (só metadados). */
	onInspect?: (payload: import("@workspace/shared").InspectHooksPayload) => void;
	/** E-mail próprio do bot carregado pelo caller (`loadEmailRunContext`). */
	email?: EmailRunContext | null;
	/** Política de autonomia efetiva (F10). Sem ela: Equilibrado. */
	autonomy?: EffectiveAutonomy;
	/**
	 * Índice das skills ativas do dono (`buildSkillIndex`, carregado pelo worker). Vai no
	 * prefixo estável do prompt; vazio/ausente = sem bloco. Subagente não recebe.
	 */
	skillIndex?: string;
	/** Acesso às skills em Markdown (padrão: db; injetável em teste). */
	skillStore?: SkillsStore;
	/** Perfil do bot (persona e gate do onboarding). Padrão: db; o harness de avaliação injeta um fixo. */
	loadBotProfile?: typeof getBotProfile;
	/** Dependências do `create_file` (teste e harness de avaliação; produção usa db + Chromium). */
	createFileDeps?: Partial<CreateFileDeps>;
	/** Dependências do `run_code` (teste). */
	runCodeDeps?: Partial<RunCodeDeps>;
	/** Acesso às páginas vivas (padrão: db; injetável em teste). */
	pagesStore?: PagesStore;
	pageShareStore?: PageShareStore;
	/** Run de rotina ligada a uma página: `page_update` só vale nela (e marca `refreshedAt`). */
	routinePageId?: string;
	maxSteps?: number;
	/** Política de orçamento (soft/hard/wall/tokens/caps). */
	budget?: AgentBudgetPolicy;
	/** Epoch ms do início do run (só vale sem checkpoint; com checkpoint o tempo ativo vem de `activeElapsedMs`). */
	runStartedAt?: number;
	onEvent: (event: ComputerUseEvent) => void | Promise<void>;
	/** Retorna false para interromper o loop (cancelamento). */
	shouldContinue?: () => Promise<boolean>;
	/** Pausa cooperativa antes da próxima decisão ou ação externa. */
	shouldPause?: () => Promise<boolean>;
	abortSignal?: AbortSignal;
	/** Teto total por decisão ao modelo (padrão 90s, até duas tentativas). Sem ele, um stream travado segura o run. */
	modelCallTimeoutMs?: number;
	/** Prazos da conta (primeiro evento e ociosidade). Omitidos = env/padrão da lib. */
	firstEventTimeoutMs?: number;
	idleTimeoutMs?: number;
	/** Modelos de reserva do OpenRouter. Omitido = `OPENROUTER_FALLBACK_MODELS`. */
	fallbackModels?: string[];
	/** Modelo de geração de imagem. Omitido = `ATLAS_IMAGE_MODEL`. */
	imageModel?: string;
	maxOutputTokens?: number;
	/** Teto de caracteres do resultado de ferramenta de conector que vai inline ao modelo (conta). Omitido = 20 mil; o resto fica guardado para `artifact_read`. */
	toolResultMaxChars?: number;
	reasoningMaxTokens?: number;
	/** Nível de raciocínio do run (chat > bot > conta, já resolvido pelo worker). Só vai a modelo com suporte. */
	reasoningEffort?: ReasoningEffort;
	/** O modelo tem raciocínio controlável? (catálogo do provedor; sem isso vale a curadoria do `shared`.) */
	modelSupportsReasoning?: (modelId: string) => boolean | Promise<boolean>;
	/**
	 * Janela de contexto do modelo em tokens (para a higiene de prompt).
	 * Resolvida na criação do run (API grava em budgetJson.contextLength);
	 * ausente/desconhecida = fallback 128k. Nada de fetch por run no worker.
	 */
	contextLength?: number | null;
	restoredCheckpoint?: AgentRunCheckpoint | null;
	loadScreenshot?: (artifactId: string) => Promise<string | null>;
	/** Anexos de imagem do pedido inicial, já validados para o dono do run. */
	userImageArtifactIds?: string[];
	/** F3: notas de pesquisa de runs anteriores da conversa (já escopadas por dono; só leitura). */
	priorResearchNotes?: unknown;
	/** V3: ledger de itens de um run anterior da conversa (já escopado por dono); oferecido, nunca imposto. */
	priorTaskLedger?: unknown;
	/** Lista de passos (`update_task_list`) de um run anterior da conversa. */
	priorTaskList?: unknown;
	/** Itens abertos da lista do run anterior (mensagem digitada depois de um run que parou com itens abertos): só CONTEXTO, não semeia a lista. */
	priorOpenItems?: unknown;
	/** Caderno do trabalho longo anterior da conversa (já escopado por dono): semeia uma continuação curta ("continua"). */
	priorNotebook?: unknown;
	/** Este run é uma continuação automática (o worker agendou depois de uma parada com trabalho aberto): herda lista e caderno. */
	autoContinued?: boolean;
	/** O último run da conversa parou com itens abertos e esta mensagem foi digitada: recebe os itens como nota e o caderno (estado, não o texto); nunca perfil nem portão. */
	continuedWork?: boolean;
	/** Pedidos deste bot a outros bots ainda sem resposta (`send_to_bot`), já escopados por dono. */
	openBotRequests?: OpenBotRequest[];
	/** Subagente: notas do filho ficam num armazém do delegate_task, que as anexa ao relatório. */
	researchNotesStore?: ResearchNotes;
	/** Imagens de turnos anteriores da conversa, já filtradas pelo dono (ver `loadUserImageHistory`). */
	historyImages?: HistoryImageGroup[];
	/** Conversa completa dos turnos anteriores (chamadas e resultados de ferramenta); entra no lugar da marcação TRANSCRIPT_SLOT de `messages`. */
	priorTranscript?: SerializedLlmMessage[];
	/** Tools de conector/adiadas que os turnos anteriores deixaram carregadas (ficam carregadas neste run). */
	priorLoadedTools?: string[];
	/** Grupos e ordem de tools congelados na conversa pelo turno anterior (cache de prompt; ver `context/sticky-groups.ts`). */
	priorToolCache?: ToolCacheState;
	/** Motor v3: uso das tools congelado com `priorLoadedTools` pelo turno anterior (manifesto e busca iguais). */
	priorToolUsage?: Record<string, number>;
	/** `/compact` aplicado à conversa antes deste turno: vira a ação "Conversa compactada" no inspetor do 1º passo. */
	priorCompaction?: { before: number; after: number };
	/** Marca d'água da conversa (última mensagem vista ao montar o histórico); vai em todo checkpoint do run. */
	transcriptWatermark?: import("@workspace/shared").TranscriptWatermark;
	/** Notas de turno que seguem valendo; vão em todo checkpoint do run para o turno seguinte. */
	carriedNotes?: import("@workspace/shared").CarriedNote[];
	canSeeUserImages?: boolean;
	/** `retryTransient`: anexo do turno atual, pode repetir a leitura uma vez em falha transitória (o worker decide); histórico não repete. */
	loadUserImage?: (artifactId: string, options?: { retryTransient?: boolean }) => Promise<string | null>;
	/** `loadFailed`: a leitura da imagem falhou (≠ sem descrição porque não há modelo de apoio). */
	describeUserImage?: (artifactId: string, options?: { retryTransient?: boolean }) => Promise<{ description: string | null; costUsd?: number; costUnknown?: boolean; loadFailed?: boolean }>;
	/** Arquivos que o usuário anexou (PDF, Office, planilha, texto, zip...). */
	attachments?: AttachmentRuntime;
	persistScreenshot?: (pngBase64: string) => Promise<string>;
	findCompletedTool?: (
		idempotencyKey: string,
	) => Promise<CompletedToolReplay | null>;
	/** W9: escrita que começou (intenção gravada) e não tem resultado: efeito desconhecido, não se repete. */
	findStartedTool?: (idempotencyKey: string) => Promise<{ attemptId: string; tool: string } | null>;
	onStep?: (step: RuntimeStepRecord) => Promise<void>;
	/** Chamado quando uma tool de sandbox falha (p/ invalidar sessão cacheada). */
	onSandboxError?: (toolName: string, message: string) => void | Promise<void>;
	/** F12/B5: login pedido ao usuário. O worker marca o run como pausado; o runtime lança a pausa. */
	onLoginRequired?: (info: { loginId: string; site: string; url: string }) => void | Promise<void>;
	/** Cofre do dono (testes injetam um falso). */
	vault?: VaultService;
	/** Espera depois de preencher o login do Cofre antes de conferir a página (padrão 3 s). */
	vaultLoginSettleMs?: number;
	/**
	 * Cards de login da conversa nos últimos 30 min (vale entre runs): `asked` = sites com card pendente (não repetir),
	 * `vaultTried` = sites onde o Cofre já falhou (sem novo auto-login). Lido só quando aparece uma tela de login.
	 * Sem isto o guarda de "já pedi" só vale dentro do run e cada mensagem nova reabria o mesmo card.
	 */
	recentLoginAsks?: () => Promise<{ asked: readonly string[]; vaultTried: readonly string[] }>;
	/**
	 * Motor v3 (núcleo por uso, desenho 3.2): quantas vezes cada tool rodou nos runs deste bot nos últimos 30 dias.
	 * Lido só ao abrir conversa nova (o catálogo fica congelado nas seguintes); v1 e v2 não leem.
	 */
	loadToolUsage?: () => Promise<Record<string, number>>;
	/** Motor v3 (PR8a): filas do "esperar o dono" (prazo do cartão, `schedule_return`). v1 e v2 não leem. */
	ownerWait?: OwnerWaitDeps;
	/** Prazo da busca do código no e-mail (padrão 60 s). */
	vaultEmailTimeoutMs?: number;
	consumeSteerInputs?: () => Promise<
		Array<{ id: string; content: string; mode?: string; attachments?: Array<{ artifactId: string }> }>
	>;
	/**
	 * `interrupt` pendente (ids ainda não consumidos): o runtime aborta a chamada ao
	 * modelo em voo e processa a entrada como redirect. Ausente = sem interrupção.
	 */
	peekInterruptInputs?: () => Promise<string[]>;
	/** Modelo barato da triagem de mensagens `join` (sumarizador/manutenção). Ausente = modelo do run. */
	messageTriageModel?: string;
	/**
	 * O worker pode retomar sozinho depois de um teto de passos com progresso: o fechamento (resumo ou
	 * "responda continuar") fica por conta dele, que decide se retoma ou usa o fechamento padrão.
	 */
	autoContinue?: { canSchedule: boolean };
	/** Entrega offline: a triagem viu que o usuário vai sair (e quando quer o aviso). Falha não derruba o run. */
	onAwayNote?: (note: { deliverAt: string }) => Promise<void> | void;
	/** `later`: grava o pedido como entrada `queue` do run; o worker o encadeia ao concluir. Idempotente por `key`. */
	queueFollowUp?: (instruction: string, key: string) => Promise<void>;
	/**
	 * Cancela o run pelo mesmo caminho do botão "Parar" (flag persistida). A triagem
	 * ao vivo usa quando a mensagem pede para parar com uma tool longa em andamento.
	 */
	requestCancel?: () => Promise<void>;
	/** Intervalo da consulta de `peekInterruptInputs` durante a chamada ao modelo (ms). Só vale sem `onRunSignal`. */
	interruptPollMs?: number;
	/**
	 * Fonte de sinais do run (Redis no worker): avisa quando chega entrada nova. Com ela, o
	 * `peekInterruptInputs` e a triagem ao vivo consultam o db só quando avisam (mais uma
	 * consulta de segurança a cada 15 s). Ausente = consulta periódica de `interruptPollMs`.
	 */
	onRunSignal?: RunSignalSubscribe;
	streamChat?: (
		params: CompleteChatWithToolsParams,
		handlers?: StreamChatWithToolsHandlers,
	) => Promise<CompleteChatWithToolsResult>;
	jevMcpMode?: JevMcpMode;
	evaluateMcpWithJev?: JevMcpEvaluator;
	/** Decisões baratas com o Jev (F11): intenção, tools, verificação etc. Ausente = tudo `off`. */
	jev?: JevRuntime;
	/** Modo proativo ligado no bot principal (o worker só passa isto nesse caso). */
	proactive?: { settings: ProactiveSettings };
	/**
	 * Push avulso ao dono do run: rotina "só importante" (o fim do run não avisa sozinho) ou chat
	 * (aviso no meio de tarefa longa). `send` é ligado pelo worker ao notifier; `quiet` = silêncio do usuário.
	 */
	userPush?: { mode: UserPushMode; send: (text: string) => Promise<void>; quiet?: ProactiveSettings };
	/**
	 * Rotina de alerta por condição (só origin "routine"): habilita `report_alert` e a nota da tarefa.
	 * O worker passa o `report` vazio e lê o veredito depois do loop; quem avisa (com debounce) é ele.
	 */
	alertRun?: AlertRunState;
	/** Leitor da fonte do teste da regra de alerta (padrão: leitura real com guard SSRF; teste injeta). */
	alertRuleReader?: AlertRuleReader;
	/** Buscador do `find_page_value` (padrão: leitura real com guard SSRF; teste injeta). */
	pageValueFinder?: PageValueFinder;
	/** Persiste checkpoint após cada passo confirmado. */
	onCheckpoint?: (checkpoint: AgentRunCheckpoint) => Promise<void>;
	/** Sync BullMQ scheduler após create/update de rotina (cron). */
	onRoutineMutated?: (
		routine: Pick<
			RoutineRecord,
			"id" | "enabled" | "schedule" | "timezone" | "triggerType"
		>,
	) => Promise<void>;
	/** Bots do usuário (o worker injeta o db). Sem isto não há `send_to_bot`. */
	listBotRoster?: (userId: string) => Promise<Array<{ id: string; isPrimary?: boolean }>>;
	/** "Decidir pelos outros bots" ligado neste bot (policyJson): expõe `decide_bot_pending`. */
	decideForOtherBots?: boolean;
	/**
	 * Checagens que só observam a resposta final (correção de arquivo, verificador Jev em sombra) não
	 * seguram o fim do run: o resultado sai já e `observeChecks` termina depois, com o uso delas para
	 * o chamador somar (nunca rejeita). Sem isto elas são aguardadas antes de devolver (como antes).
	 */
	backgroundObserveChecks?: boolean;
};
