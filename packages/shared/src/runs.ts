import type { ChatMessage } from "./chat.js";
import type { ComputerUseEvent, RunUsage } from "./computer.js";
import type { RunConfigSnapshot } from "./effective-config.js";
import type { LoginConnector } from "./login-connector.js";
import type { LoginVaultOffer } from "./login-wall.js";
import type {
	CapabilitySnapshot,
	LedgerEffect,
	TaskState,
	ToolResultStatus,
} from "./task-contracts.js";

/** Origem de um AgentRun. */
/** `subagent`: run filho aberto por `delegate_task` (nunca criado pela API). */
export type AgentRunOrigin = "chat" | "routine" | "webhook" | "subagent" | "bot" | "proactive";

/** Estados terminais e intermediários do plano. */
export type AgentRunStatus =
	| "queued"
	| "running"
	| "waiting_user"
	| "waiting_external"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled"
	| "budget_exhausted"
	| "retrying";

export type AgentStepType =
	| "model"
	| "tool"
	| "tool_result"
	| "checkpoint"
	| "approval";

export type AgentStepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped";

/** Snapshot público de uma execução. */
export type AgentRun = {
	id: string;
	userId: string;
	botId: string | null;
	conversationId: string | null;
	origin: AgentRunOrigin;
	/** Run pai (só runs `subagent`). */
	parentRunId?: string | null;
	objective: string;
	status: AgentRunStatus;
	model: string;
	maxSteps: number;
	sandboxSessionId: string | null;
	error: string | null;
	resultText: string | null;
	cancelRequested: boolean;
	/** Orçamento resolvido e uso acumulado (observabilidade). */
	budgetJson?: unknown;
	usageJson?: unknown;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
};

export type RunEventRecord = {
	id: string;
	runId: string;
	seq: number;
	type: string;
	payload: ComputerUseEvent | Record<string, unknown>;
	createdAt: string;
};

/** Body de `POST /v1/runs`. */
export type CreateAgentRunRequest = {
	messages: ChatMessage[];
	attachments?: Array<{ artifactId: string }>;
	model?: string;
	conversationId?: string;
	botId?: string;
	sandboxSessionId?: string;
	maxSteps?: number;
	origin?: Exclude<AgentRunOrigin, "subagent">;
	objective?: string;
	/**
	 * Cartão de aprovação em que o usuário clicou (`confirmId`). O servidor só aplica a decisão se ele for a
	 * intenção pendente; um cartão antigo nunca aprova o comando mais novo. Ausente = comportamento de antes.
	 */
	decisionConfirmId?: string;
	/**
	 * Ciclo limpo (Fase 2): prompt enxuto (resumo + cauda mínima) em vez das
	 * 40 msgs. Futuro botão "Novo ciclo"; worker também liga sozinho com
	 * resumo fresco. Congelado no checkpoint (vale por run).
	 */
	compact?: boolean;
	/**
	 * Chave de idempotência para retry seguro (ex.: bot-created).
	 * Em colisão de 1-run-ativo-por-conversa (P2002 -> steer), é repassada a
	 * `createRunInput` e deduplicada por (runId, clientKey). Opcional: sem ela
	 * o retry cai em steer com novo seq (aceitável).
	 */
	clientKey?: string;
	/**
	 * Run silencioso: não grava o objective como mensagem `user` na conversa
	 * (nem via steer em colisão P2002). Para eventos proativos do sistema
	 * (bot-created, questionnaire-submitted) — a thread mostra
	 * só o que o agente responder/emitir, sem o balão sintético do evento.
	 */
	silent?: boolean;
	/** Sobrescreve a política de orçamento (antes do bot e dos padrões). */
	budget?: {
		softMaxSteps?: number;
		hardMaxSteps?: number;
		maxWallMs?: number;
		maxTokens?: number;
		maxCallsPerTool?: Record<string, number>;
		extensionSteps?: number;
	};
};

export type CreateAgentRunResponse = {
	runId: string;
	status: AgentRunStatus;
	enqueued?: boolean;
};

/** `POST /v1/runs` respondido só com uma reação do bot: a mensagem foi salva, sem run. */
export type ReactionOnlyRunResponse = {
	runId: null;
	status: "reacted";
	enqueued: true;
	messageId: string;
	reaction: string;
};

export type AgentRunSnapshotResponse = {
	run: AgentRun;
};

export type AgentRunEventsResponse = {
	events: RunEventRecord[];
	run: Pick<AgentRun, "id" | "status" | "resultText" | "error">;
};

/** Payload BullMQ `run-agent`. */
export type AgentRunJobPayload = {
	runId: string;
	/** Request-id da requisição que enfileirou (logs da API e do worker casam por ele). */
	requestId?: string;
};

export type AgentRunJobResult = {
	runId: string;
	status: AgentRunStatus;
	resultText?: string;
	error?: string;
};

/**
 * Como uma mensagem entra num run ativo (PLANO-RUN-V2 §6). `join` é o padrão:
 * entra como nota e nunca reescreve o objetivo. `steer` é o nome legado de `join`.
 */
export const RUN_INPUT_MODES = ["join", "redirect", "interrupt", "queue", "cancel"] as const;
export type RunInputMode = (typeof RUN_INPUT_MODES)[number] | "steer";
export const DEFAULT_RUN_INPUT_MODE = "join" as const;
/** Modos que entram no run em curso (os demais: fila ou cancelamento). */
export const LIVE_RUN_INPUT_MODES = ["join", "redirect", "interrupt", "steer"] as const;

/** Valida o modo vindo de fora: ausente = `join`, `steer` = `join`, desconhecido = `null`. */
export function parseRunInputMode(raw: unknown): Exclude<RunInputMode, "steer"> | null {
	if (raw === undefined || raw === null) return DEFAULT_RUN_INPUT_MODE;
	if (raw === "steer") return "join";
	return typeof raw === "string" && (RUN_INPUT_MODES as readonly string[]).includes(raw)
		? (raw as Exclude<RunInputMode, "steer">)
		: null;
}

/** Leitura tolerante (linha antiga ou desconhecida do db): `steer`/desconhecido viram `join`. */
export function normalizeRunInputMode(raw: unknown): Exclude<RunInputMode, "steer"> {
	return parseRunInputMode(raw) ?? DEFAULT_RUN_INPUT_MODE;
}

/** Revisão versionada do objetivo (só `redirect` classificado ou `interrupt` explícito). */
/** Nota de pesquisa compacta (F3): achado + fonte + confiança, guardada no checkpoint do run. */
export type ResearchNote = {
	sourceRef: string;
	findings: string;
	keyFacts: string[];
	links: string[];
	confidence: "high" | "medium" | "low";
	/** Decisão em que a nota foi gravada. */
	step: number;
};

/**
 * Rajada de mensagens `join` já triada com o run em ferramenta longa: o balão
 * saiu na hora e o veredito entra no histórico no próximo ponto seguro.
 */
export type TriagedInputBurst = {
	ids: string[];
	text: string;
	verdict: { kind: "chat" | "change" | "later"; cancel: boolean; reply: string; instruction: string; wantsFile?: boolean };
};

export type ObjectiveRevision = {
	previousText: string;
	newText: string;
	reason: string;
	/** Versão do objetivo DEPOIS da revisão. */
	version: number;
	/** ISO 8601. */
	at: string;
	atStep?: number;
};
export type RunInputStatus = "pending" | "consumed" | "superseded";

export type RunInputRecord = {
	id: string;
	runId: string;
	seq: number;
	author: string;
	content: string;
	attachments?: Array<{ artifactId: string }>;
	mode: RunInputMode;
	status: RunInputStatus;
	clientKey: string | null;
	createdAt: string;
	consumedAt: string | null;
};

export type CreateRunInputRequest = {
	content: string;
	attachments?: Array<{ artifactId: string }>;
	mode?: RunInputMode;
	author?: string;
	clientKey?: string;
	/** Não espelha em ConversationMessage (steer silencioso de evento). */
	silent?: boolean;
};

export const AGENT_RUNTIME_CHECKPOINT_VERSION = 2;

/** Conteúdo LLM persistível: screenshots viram `artifact:<id>`, nunca Data URL. */
export type SerializedLlmContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } }
	| { type: "image_ref"; artifactId: string; name?: string; description?: string }
	| { type: "screenshot_ref"; artifactId: string }
	| { type: "file_ref"; artifactId: string; filename: string };

export type SerializedLlmMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string | SerializedLlmContentPart[] | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
	/** Histórico opaco do provedor; ausente em checkpoints antigos. */
	providerItems?: {
		provider: "chatgpt";
		model: string;
		items: Record<string, unknown>[];
	};
};

/**
 * Livro-razão de execução do run (K1, primeira fatia): o que cada decisão
 * leu, quanto trouxe de novo e em que ponto da estagnação o run está.
 * Pequeno e limitado; sobrevive a resume dentro do checkpoint.
 */
export type ExecutionLedgerCall = {
	tool: string;
	/** Hash curto dos args normalizados (sem parâmetros de texto livre). */
	argKey: string;
	/** Hash do conteúdo devolvido pela tool. */
	hash: string;
	ok: boolean;
	/** Quantos ids de item foram extraídos do resultado. */
	ids: number;
	/** `result_ref` durável da chamada, quando houver. */
	ref?: string;
};

export type ExecutionLedgerDecision = {
	step: number;
	novelty: number;
	calls: ExecutionLedgerCall[];
};

export type ExecutionLedgerState = {
	v: 1;
	decisions: ExecutionLedgerDecision[];
	seenIds: string[];
	seenHashes: Array<{ hash: string; tool: string; step: number; ref?: string }>;
	/** Decisões seguidas sem novidade. */
	streak: number;
	/** Último aviso já emitido nesta sequência (0 = nenhum). */
	nudged: 0 | 1 | 2;
	/** Última decisão já fechada (evita contar duas vezes no resume). */
	closedStep: number;
	/** Journal de efeitos (W9): intenção antes da escrita, resultado depois. Ausente em checkpoint antigo. */
	effects?: LedgerEffect[];
	/** Status estruturado por `tool_call_id` (L20): o resume não lê prefixo de texto. */
	results?: Record<string, ToolResultStatus>;
};

/** Checkpoint serializado no AgentRun.checkpointJson. */
export type AgentRunCheckpoint = {
	version?: number;
	/**
	 * Tempo ATIVO acumulado do run (ms) até este checkpoint. O teto de relógio
	 * (`maxWallMs`) conta só isso: tempo pausado (card de login/captcha) e em
	 * fila não entra. Ausente em checkpoints antigos = 0.
	 */
	activeElapsedMs?: number;
	messages: ChatMessage[];
	userImageArtifactIds?: string[];
	/** Arquivos que o usuário anexou ao pedido inicial (o conteúdo entra no contexto no começo do run). */
	userFileArtifactIds?: string[];
	generatedImageCount?: number;
	shownImageCount?: number;
	llmMessages?: SerializedLlmMessage[];
	nextStepIndex?: number;
	/** Modo ciclo limpo congelado (vale por run, sobrevive a resume). */
	compact?: boolean;
	model?: string;
	sandboxSessionId?: string | null;
	consumedInputIds?: string[];
	usageTotals?: RunUsage;
	toolCallCounts?: Record<string, number>;
	/** Últimas chamadas por tool MCP (hash dos args + ok): base do teto adaptativo. */
	toolCallHistory?: Record<string, Array<{ argsHash: string; ok: boolean }>>;
	/** Tetos ampliados durante o run (tool → teto atual). */
	toolCapExtensions?: Record<string, number>;
	extensionCount?: number;
	consecutiveToolFailures?: number;
	/** Tools bloqueadas no run (F4): nome → último erro. Sobrevive a resume. */
	blockedTools?: Record<string, string>;
	effectiveHard?: number;
	progressCursor?: number;
	/** F12/B5: URLs (origem+caminho) em que já pedi login neste run — no máximo uma vez cada. */
	loginAsked?: string[];
	/** F12/B5: login pedido e ainda não confirmado; no resume vira o aviso "[login-complete]". */
	pendingLogin?: { loginId: string; site: string; url: string; reason?: "login" | "captcha"; composioToolkit?: string; connector?: LoginConnector; vault?: LoginVaultOffer; vaultTried?: string; useVault?: boolean; codeField?: boolean; codeEnc?: string };
	/** Disciplina de execução: livro-razão do run (ausente com a flag desligada). */
	executionLedger?: ExecutionLedgerState;
	/** Estado versionado da tarefa (K1): objetivo, critérios verificáveis, artefatos. */
	taskState?: TaskState;
	/** Histórico das revisões de objetivo (F1): só redirect/interrupt, nunca join. */
	objectiveRevisions?: ObjectiveRevision[];
	/** Pedidos "para depois" (triagem de mensagem): o worker os encadeia como próximo turno ao concluir. */
	pendingFollowUps?: string[];
	/** Mensagens `join` triadas durante uma tool longa e ainda não aplicadas ao histórico. */
	triagedInputs?: TriagedInputBurst[];
	/** Notas de pesquisa do run (F3): sobrevivem a higiene de contexto e a resume. */
	researchNotes?: ResearchNote[];
	/** Capacidades efetivas do run (K1): tools executáveis, visão, restrições. */
	capabilities?: CapabilitySnapshot;
	/**
	 * Configuração da conta congelada ao assumir o run (modelos de apoio, Jev,
	 * disciplina, prazos, limites). Retomada e subagentes reusam; mudar a conta
	 * no meio do run vale só para o próximo.
	 */
	configSnapshot?: RunConfigSnapshot;
};
