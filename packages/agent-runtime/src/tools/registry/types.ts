import type { BotLanguage, ComputerUseEvent, RoutineRecord, StepTelemetry } from "@workspace/shared";
import { type EffectiveAutonomy } from "@workspace/shared";
import { type ChatTool } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { type ShowImageEvent } from "../../tools/show-image.js";
import type { AttachmentRuntime } from "../../attachments/runtime.js";
import type { McpRuntime } from "../../mcp/runtime.js";
import { type JevMcpAudit, type JevMcpEvaluator, type JevMcpMode } from "../../mcp/jev-gate.js";
import { type JevIntents } from "../../jev/intent.js";
import { type JevRuntime } from "../../jev/decide.js";
import { type RereadGuard } from "../../execution/reread-guard.js";
import { type PreviewSetupToolContext } from "../../tools/preview-setup/tool.js";
import { type SecretSession } from "../../secrets/session.js";
import { type SkillsStore } from "../../tools/skills.js";
import type { ApiConnectorRuntime } from "../../api-connector/runtime.js";
import { type EmailRunContext } from "../../email/tools.js";
import { type NativeDeferral } from "../../context/native-deferral.js";

import { type LoginEvent } from "../../tools/computer-refs.js";
import { type DevSessionRuntime } from "../../tools/dev-session.js";
import { type DelegateContext } from "../../tools/delegate-task.js";
import { type CreateFileDeps, type FileEvent } from "../../tools/create-file.js";
import { type RunCodeDeps } from "../../tools/run-code.js";
import { type AlertRunState } from "../../tools/report-alert.js";
import { type AlertRuleReader } from "../../tools/alert-rule.js";
import { type PageValueFinder } from "../../tools/find-page-value.js";
import { type PageShareStore, type PagesStore } from "../../tools/pages.js";
import { type ProviderHealth } from "../../tools/provider-health.js";
import { type ResearchNotes } from "../../tools/research-note.js";
import { type LedgerStore } from "../../tools/track-items.js";
import { type TaskListStore } from "../../tools/task-list.js";
import { type ProactiveToolContext, type UserPushContext } from "../../tools/proactive.js";
import { type RunLessonsParam } from "../../lessons.js";

export type ConfirmEvent = Extract<ComputerUseEvent, { type: "confirm" }>;
export type SkillEvent = Extract<ComputerUseEvent, { type: "skill" }>;
export type SkillProposalEvent = Extract<ComputerUseEvent, { type: "skill-proposal" }>;
export type RoutineEvent = Extract<ComputerUseEvent, { type: "routine" }>;
export type QuestionnaireEvent = Extract<ComputerUseEvent, { type: "questionnaire" }>;
export type BotProfileEvent = Extract<ComputerUseEvent, { type: "bot-profile" }>;
export type BotProposalEvent = Extract<ComputerUseEvent, { type: "bot-proposal" }>;

/** Resultado de uma tool: `summary` volta ao modelo; o resto são eventos/metadados do laço. */
export type ToolResult = {
	summary: string;
	image?: string;
	/** Metadados de tempo da tool (V0), gravados em `telemetry` do passo. Nunca conteúdo. */
	toolTelemetry?: Pick<StepTelemetry, "nav" | "rung">;
	confirmEvent?: ConfirmEvent;
	skillEvent?: SkillEvent;
	skillProposalEvent?: SkillProposalEvent;
	botProposalEvent?: BotProposalEvent;
	routineEvent?: RoutineEvent;
	questionnaireEvent?: QuestionnaireEvent;
	profileEvent?: BotProfileEvent;
	loginEvent?: LoginEvent;
	fileEvent?: FileEvent;
	/** Imagens geradas (run_code) que o modelo deve ver no próximo turno; contam na higiene de imagens. */
	visionArtifactIds?: string[];
	jevAudit?: JevMcpAudit;
};

export type ToolContext = {
	manager: SandboxManager;
	/** Fuso IANA da conta (tool `current_time`). */
	timeZone?: string;
	/** Configuração da prévia completa (só administrador; ausente = a tool não existe neste run). */
	previewSetup?: PreviewSetupToolContext;
	/** Runtime das tools de sessão de desenvolvimento (ausente = desligado). */
	devSession?: DevSessionRuntime;
	/** Id da chamada de tool (liga os eventos de shell e edição ao card). */
	callId?: string;
	/** Feedback do modelo sobre as lições aplicadas (padrão: banco). */
	lessonFeedback?: RunLessonsParam["recordFeedback"];
	showImages?: { remaining: () => number; add: (count: number) => void; emit: (event: ShowImageEvent) => Promise<void> };
	/** Entrega cartões de arquivo extras (run_code pode gerar vários); persiste na conversa e emite o evento. */
	emitFile?: (event: FileEvent) => Promise<void>;
	/** Entrega gráficos nativos do run_code (*.chart.json): persiste o cartão e emite o evento. */
	emitChart?: (event: Extract<ComputerUseEvent, { type: "chart" }>) => Promise<void>;
	/** Páginas vivas (`page_*`): acesso (injetável em teste) e entrega do cartão (persiste e emite o evento). */
	pagesStore?: PagesStore;
	pageShareStore?: PageShareStore;
	/** Run de rotina ligada a uma página: `page_update` só vale nela (e marca `refreshedAt`). */
	routinePageId?: string;
	emitPage?: (event: Extract<ComputerUseEvent, { type: "page" }>) => Promise<void>;
	/** Id da chamada de tool em execução (liga o cartão gravado do run_code ao cartão ao vivo). */
	toolCallId?: string;
	/** Dependências do `run_code` (teste; produção usa o executor Docker). */
	runCodeDeps?: Partial<RunCodeDeps>;
	/** O modelo do run enxerga imagens (gráficos do run_code voltam como visão). */
	canSeeImages?: boolean;
	/** Anexos de arquivo do usuário (leitura/lista/cópia); `vmAvailable` = o run tem o computador da VM. */
	attachments?: { runtime: AttachmentRuntime; vmAvailable: boolean };
	imageGeneration?: { apiKey: string; model: string; remaining: () => number; add: (count: number) => void; onCost: (costUsd: number | undefined) => void };
	/** Conectores MCP do usuário (null/undefined = sem conectores). */
	mcp?: McpRuntime | null;
	/** APIs conectadas por especificação OpenAPI (null/undefined = nenhuma). */
	apiConnector?: ApiConnectorRuntime | null;
	/** E-mail próprio do bot (null/undefined = bot sem endereço: sem tools de e-mail). */
	email?: EmailRunContext | null;
	/**
	 * Ativa tools MCP sob demanda (índice + carregar sob demanda): recebe
	 * nomes (expostos) a ativar e devolve o que foi ativado/evictado pelo
	 * orçamento ativo. Muta o `tools` do run em vigor a partir do próximo passo.
	 */
	readRefresh?: boolean;
	/** Teto inline do resultado de conector neste run. */
	toolResultMaxChars?: number;
	activateMcpTools?: (names: string[]) => { activated: string[]; evicted: string[] };
	/** Tools MCP já carregadas no run (só com a disciplina de execução ligada). */
	loadedMcpToolNames?: () => string[];
	/** Tools nativas adiadas (economia de contexto): busca e carga sob demanda. */
	nativeDeferral?: NativeDeferral;
	abortSignal?: AbortSignal;
	getSessionId: (context?: { signal?: AbortSignal; deadlineAtMs?: number }) => Promise<string>;
	/** Sessão da VM que o run já tem, sem criar nada (null = nenhuma). Usada só para ler o aviso de aba. */
	peekSessionId?: () => string | null;
	/** F12/B5: URLs em que o login já foi pedido neste run (checkpoint). */
	loginAsked?: Set<string>;
	/** Estado do run para o Jev de conector: leu conteúdo externo? o que já foi aprovado e executado? */
	mcpRun?: {
		untrustedSeen: boolean;
		/** Nomes das tools de escrita executadas neste run (só o nome, nunca argumento). */
		executed: string[];
		/** Marca `untrustedAt` da conversa (run anterior leu conteúdo externo), lida sob demanda e uma vez por run. */
		conversationUntrusted?: () => Promise<boolean>;
	};
	/** Cofre: injeta {{secret:...}} nas ferramentas de saída permitidas e redige os resultados. */
	secrets?: SecretSession;
	/** Provedores externos sem créditos/cota neste run (não insistir; ver `tools/provider-health.ts`). */
	health?: ProviderHealth;
	/** A tool existe neste run (carregada ou adiada)? Dicas só citam alternativas reais. */
	hasTool?: (name: string) => boolean;
	botId: string | undefined;
	userId: string | undefined;
	conversationId?: string;
	runId?: string;
	/** Última fala do usuário neste run (gate de delete vs tarefa). */
	lastUserText?: string;
	/** Falas user recentes (mais nova primeiro) — skill create não depende só da última. */
	recentUserTexts?: string[];
	/** Falas do assistente nas últimas mensagens (links que o usuário viu). */
	recentAssistantTexts?: string[];
	/** Origem do AgentRun (chat | routine | …). */
	origin?: string;
	/** A fala que abriu o run foi digitada pelo dono (ver `ComputerUseParams.humanTurn`). */
	humanTurn?: boolean;
	/** Propostas de novo agente neste run (teto de uma por turno). */
	botProposals?: { count: number };
	/** Política de autonomia em vigor (`set_autonomy` troca no meio do run). */
	autonomy?: { get: () => EffectiveAutonomy; set: (next: EffectiveAutonomy) => void };
	/** Acesso às skills em Markdown (injetável em teste; padrão: db). */
	skillStore?: SkillsStore;
	/** Dependências do `create_file` (teste e harness de avaliação; produção usa db + Chromium). */
	createFileDeps?: Partial<CreateFileDeps>;
	jevMcpMode?: JevMcpMode;
	evaluateMcpWithJev?: JevMcpEvaluator;
	onJevAudit?: (audit: JevMcpAudit) => void;
	/** Fala do usuário que abriu o run (nunca resultado de tool): base do `set_autonomy`. */
	userRequestText?: string;
	/** Intenções lidas pelo Jev na última fala do usuário (F11). */
	jevIntents?: JevIntents;
	/** Jev do run (decisões baratas); `decide_bot_pending` o usa para julgar aprovações. */
	jev?: JevRuntime;
	/** Encanamento do `delegate_task` (F5); ausente em subagente. */
	delegation?: DelegateContext;
	/**
	 * `AgentRun.objective` (pedido original que criou este run). Fonte da
	 * ORIGINAL REQUEST guardada no card de questionário (`purpose: "task"`) e
	 * usada para detectar evento de config do bot mesmo quando o texto do
	 * evento (ex.: `[bot-created]`) não sobrevive como `lastUserText`.
	 */
	objective?: string;
	/** Foto do estado operacional (para checkpoint_read). */
	getOperationalSnapshot?: () => {
		step: number;
		model: string;
		messages: number;
		consumedInputs: string[];
	};
	/** IDs de screenshots/artefatos já na conversa (para artifact_read). */
	listScreenshotArtifacts?: () => string[];
	/** A3: releitura de artefato já lido por inteiro vira aviso curto. */
	rereadGuard?: RereadGuard;
	/** F3: notas de pesquisa do run. */
	researchNotes?: ResearchNotes;
	/** F4: confere o rascunho de um arquivo de pesquisa contra as fontes lidas. */
	deliverableVerifier?: { verify: (args: Record<string, unknown>) => void };
	/** V3: lista de itens da tarefa (`track_items`). */
	ledgerStore?: LedgerStore;
	/** Lista de passos visível (`update_task_list`). */
	taskListStore?: TaskListStore;
	/** Plano proposto (`propose_plan`): liga o portão que barra escritas até a decisão. */
	markPlanPending?: (plan: { title: string }) => void;
	/** Regra de lição `confirm_always` (hooks): força o cartão de confirmação mesmo que a autonomia deixasse. */
	forceConfirm?: boolean;
	/** Cartão da lista de passos na thread: grava (um por run) e emite o evento. */
	emitTaskList?: (items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>) => Promise<void>;
	/** V3: portão de entrega; lança com a nota ao modelo enquanto há itens abertos. */
	deliveryGate?: { check: (event: "create_file") => void };
	currentStep?: () => number;
	/** Modo proativo (bot principal): lembretes, ideias de rotina e mensagem da reflexão. */
	proactive?: ProactiveToolContext;
	/** Push avulso (`notify_user` em rotina "só importante" ou chat longo): só ao dono do run. */
	userPush?: UserPushContext;
	/** Run de rotina de alerta: `report_alert` guarda o veredito aqui (o worker decide avisar). */
	alertRun?: AlertRunState;
	/** Idioma da resposta (gera a condição e o formato dos valores de um alerta com regra). */
	replyLanguage?: BotLanguage;
	/** Leitor da fonte do teste da regra na criação (teste injeta; padrão lê a fonte com o guard SSRF). */
	alertRuleReader?: AlertRuleReader;
	/** Buscador do `find_page_value` (teste injeta; padrão lê a página com o guard SSRF). */
	pageValueFinder?: PageValueFinder;
	/** Quantas buscas do `find_page_value` este run já fez (teto por run). */
	pageValueUse?: { calls: number };
	/** Após create/update de rotina: sync BullMQ scheduler (cron-only). */
	onRoutineMutated?: (
		routine: Pick<
			RoutineRecord,
			"id" | "enabled" | "schedule" | "timezone" | "triggerType"
		>,
	) => Promise<void>;
};

/** Famílias de tools: o laço (hoje e o motor v2) agrupa carga, orçamento e relato por elas. */
export type ToolGroup =
	| "browser"
	| "sandbox"
	| "web"
	| "files"
	| "images"
	| "memory"
	| "routines"
	| "pages"
	| "planning"
	| "bots"
	| "vault"
	| "skills"
	| "email"
	| "connectors"
	| "proactive"
	| "dev"
	| "misc";

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

export type ToolRegistration = {
	handler: ToolHandler;
	group: ToolGroup;
	/** A tool só lê (não escreve em conta de usuário nem em conector). */
	readOnly?: boolean;
	/** Definição enviada ao modelo; preenchida a partir de `COMPUTER_USE_TOOLS` quando existe. */
	definition?: ChatTool;
};
