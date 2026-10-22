import type { EventEnvelope, RoutineHookInfo } from "./events/triggers.js";
import type {
	GithubTriggerEvent,
	RoutineGithubTriggerView,
} from "./routine-github.js";

/** Quem criou a rotina: o usuário (padrão) ou o bot, no modo proativo. */
export type RoutineCreatedBy = "user" | "bot";
/** Aviso (push) ao fim da execução: sempre, ou só quando o bot julgar importante. */
export type RoutineNotifyMode = "always" | "important";
export function parseRoutineNotifyMode(value: unknown): RoutineNotifyMode {
	return value === "important" ? "important" : "always";
}
export type RoutineTriggerType = "cron" | "event" | "once" | "interval";
export type RoutineTriggeredBy = "schedule" | "manual" | "event";
export type RoutineRunStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "skipped";

export type RoutineRecord = {
	id: string;
	userId: string;
	botId: string;
	conversationId: string | null;
	/** Grupo da rotina (null = sem grupo). */
	groupId?: string | null;
	group?: { id: string; name: string } | null;
	name: string;
	prompt: string;
	/** Id OpenRouter escolhido no painel para esta rotina. */
	model: string;
	allowChatgptPlan?: boolean;
	/** Ausente = "always". */
	notify?: RoutineNotifyMode;
	enabled: boolean;
	triggerType: RoutineTriggerType;
	schedule: string | null;
	timezone: string;
	triggerJson?: unknown;
	/** "bot" = criada pelo bot no modo proativo (selo "Criada pelo bot"). */
	createdBy?: RoutineCreatedBy;
	lastRunAt: string | null;
	createdAt: string;
	updatedAt: string;
	lastRun?: RoutineRunRecord | null;
	/**
	 * Presente em rotinas event/generic|github. No generic é o webhook
	 * próprio da rotina (hookKey+secret); no github, o endpoint é o mesmo
	 * pra todo mundo (secret compartilhado via env var) — aqui só serve pra
	 * expor `url`/`setupUrl` informativos, sem secret nem hookKey real.
	 */
	hook?: Omit<RoutineHookInfo, "secret">;
	/** Presente em rotinas event/github — config completa do gatilho (não há mais secret por rotina pra esconder). */
	github?: RoutineGithubTriggerView;
	/** Presente em rotinas `once` — horário (UTC) do disparo único. */
	once?: { runAt: string };
	/** Presente em rotinas `interval` — repete a cada N minutos. */
	interval?: { everyMinutes: number };
};

export type RoutineGroupRecord = {
	id: string;
	botId: string;
	name: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	/** Total de rotinas no grupo. */
	routineCount: number;
	/** Quantas dessas estão ativas. */
	enabledCount: number;
};

export type RoutineRunRecord = {
	id: string;
	routineId: string;
	agentRunId: string | null;
	triggeredBy: RoutineTriggeredBy;
	scheduledFor: string | null;
	status: RoutineRunStatus;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
	summary: string | null;
	/** Envelope (ou resumo) que disparou — só event. */
	eventJson?: unknown;
	createdAt: string;
};

export type CreateRoutineInput = {
	botId: string;
	/** Grupo existente do mesmo bot/usuário. */
	groupId?: string | null;
	name: string;
	prompt: string;
	model?: string;
	allowChatgptPlan?: boolean;
	/** Default "always". */
	notify?: RoutineNotifyMode;
	/** Default "user". */
	createdBy?: RoutineCreatedBy;
	/** Default "cron". */
	triggerType?: RoutineTriggerType;
	schedule?: string | null;
	enabled?: boolean;
	timezone?: string;
	triggerJson?: unknown;
	/**
	 * Criação de webhook genérico (kind="generic": server gera hookKey +
	 * secret) ou gatilho GitHub (kind="github": webhook único do Atlas,
	 * secret compartilhado via env var — nada por-rotina pra decidir aqui).
	 */
	trigger?:
		| { kind: "generic" }
		| {
				kind: "github";
				repo: string;
				events: GithubTriggerEvent[];
				/** Babá de um PR específico. */
				prNumber?: number;
				/** Filtro de autor/ator (ci_* isento). */
				users?: string[];
				/**
				 * Filtro de branch (ci_* → branch do check suite; push → branch do
				 * push; pr_* → branch base/destino). Obrigatório se algum evento
				 * ci_* estiver selecionado sem `prNumber`.
				 */
				branch?: string;
				/** @deprecated alias legado de `branch` (nome anterior à generalização v4) — ainda aceito, migrado internamente. */
				ciBranch?: string;
		  }
		| {
				kind: "once";
				/** ISO 8601 em UTC — já validado/normalizado por `parseOnceRunAt`. */
				runAt: string;
		  }
		| {
				kind: "interval";
				/** Já validado por `parseIntervalEveryMinutes` (inteiro de 5 a 1440). */
				everyMinutes: number;
		  };
};

export type UpdateRoutineInput = {
	/** Move para o grupo (id) ou `null` para tirar do grupo. */
	groupId?: string | null;
	name?: string;
	prompt?: string;
	model?: string;
	allowChatgptPlan?: boolean;
	notify?: RoutineNotifyMode;
	triggerType?: RoutineTriggerType;
	schedule?: string | null;
	enabled?: boolean;
	timezone?: string;
	triggerJson?: unknown;
	/** Patch de config do gatilho GitHub. */
	githubTrigger?: {
		repo?: string;
		events?: GithubTriggerEvent[];
		/** `null` remove o filtro. */
		prNumber?: number | null;
		users?: string[] | null;
		branch?: string | null;
		/** @deprecated alias legado de `branch` — ainda aceito, migrado internamente. */
		ciBranch?: string | null;
	};
	/** Patch do horário de uma rotina `once` (ISO 8601 UTC, já validado). */
	onceTrigger?: { runAt: string };
	/** Patch do intervalo de uma rotina `interval` (minutos, já validado). */
	intervalTrigger?: { everyMinutes: number };
};

export type CreateRoutineResult = {
	routine: RoutineRecord;
	/**
	 * Só no create/rotate de webhook genérico (hookKey + secret por rotina).
	 * Gatilho GitHub não gera nada aqui: usa o endpoint fixo do Atlas com um
	 * secret compartilhado (env var) — a config em si já volta em
	 * `routine.github`.
	 */
	hook?: RoutineHookInfo;
};

export type RoutineRunListItem = RoutineRunRecord & {
	routineName: string;
};

export type ExecuteRoutineJobPayload = {
	routineId: string;
	/** Request-id da requisição que enfileirou (logs da API e do worker casam por ele). */
	requestId?: string;
	routineRunId?: string;
	triggeredBy: RoutineTriggeredBy;
	/** Presente quando triggeredBy === "event". AgentRun fica origin:"routine". */
	event?: EventEnvelope;
	/** ISO da 1ª vez que o job foi adiado por o bot estar ocupado (só event). */
	deferredSince?: string;
	/** Quantas vezes o job já foi adiado. */
	deferrals?: number;
};

export type ExecuteRoutineJobResult = {
	routineId: string;
	routineRunId: string;
	status: RoutineRunStatus;
	agentRunId?: string;
};
