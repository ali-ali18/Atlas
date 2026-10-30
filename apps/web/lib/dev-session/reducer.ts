import { DEV_SESSION_EVENT_TYPES, redactSecrets, sumDevTiming } from "@workspace/shared";
import type {
	DevCiCheck,
	DevCiSummary,
	DevPrInfo,
	DevSessionEvent,
	DevSessionStatusValue,
	DevSessionTierValue,
	DevSetupCacheState,
	DevShellEndedReason,
	DevTimingEvent,
	DevTodoItemValue,
} from "@workspace/shared";
import { activeT, getActiveTranslator } from "@/lib/i18n/active";
import type { MessageKey, Translator } from "@/lib/i18n/translator";

/** Saída guardada por comando em memória (o resto é descartado do início). */
export const DEV_OUTPUT_CAP_CHARS = 200_000;

export type DevCommandView = {
	callId: string;
	jobId: string;
	cmd: string;
	cwd: string;
	startedAt: number;
	output: string;
	/** A saída passou do teto e o começo foi descartado. */
	truncated: boolean;
	status: "running" | "done";
	exitCode?: number | null;
	durationMs?: number;
	endedReason?: DevShellEndedReason;
	/** Foi para segundo plano (background explícito ou auto-background aos 30s): só estes entram em "Tarefas em segundo plano". */
	backgrounded?: boolean;
};

/** Auto-background do runtime: o comando que passa disso em primeiro plano vira job. */
export const DEV_AUTO_BACKGROUND_MS = 30_000;

/** Comando que virou tarefa em segundo plano (comandos curtos que terminaram no tempo normal ficam fora). */
export function isBackgroundCommand(command: Pick<DevCommandView, "backgrounded" | "durationMs">): boolean {
	return command.backgrounded === true || (command.durationMs ?? 0) >= DEV_AUTO_BACKGROUND_MS;
}

export type DevFileEditView = {
	callId: string;
	path: string;
	diff: string;
	added: number;
	removed: number;
	at: number;
};

export type DevSetupStepView = {
	step: string;
	status: "running" | "done" | "failed";
	exitCode?: number;
	durationMs?: number;
	/** Instalação: como o cache de dependências do ambiente foi usado. */
	cache?: DevSetupCacheState;
	/** Fim da saída da instalação/inicialização do ambiente (já redigida no servidor). */
	output?: string;
	startedAt: number;
};

export type DevTimelineEntry =
	| { key: string; kind: "setup"; ref: string; at: number }
	| { key: string; kind: "command"; ref: string; at: number }
	| { key: string; kind: "file"; ref: string; at: number };

export type DevSessionStats = {
	commandsRun: number;
	totalAdded: number;
	totalRemoved: number;
	filesChanged: { path: string; added: number; removed: number }[];
};

export type DevCiView = { checks: DevCiCheck[]; summary: DevCiSummary; at: number };

/** Uso atual da janela de contexto do agente (último `context_usage`). */
export type DevContextUsageView = { model?: string; usedTokens: number; windowTokens: number; compactAtTokens: number; at: number };

export type DevCompactionView = { key: string; at: number; before: number; after: number };

export type DevSessionView = {
	id: string;
	status: DevSessionStatusValue;
	tier?: DevSessionTierValue;
	repo?: string;
	branch?: string;
	/** Início da sessão (ms). */
	startedAt: number;
	/** Quando deixou de trabalhar (ms); ausente enquanto prepara/trabalha. */
	endedAt?: number;
	setup: DevSetupStepView[];
	commands: DevCommandView[];
	edits: DevFileEditView[];
	todos: DevTodoItemValue[];
	timeline: DevTimelineEntry[];
	/** Vezes que o contexto do agente foi resumido nesta sessão. */
	compactions: DevCompactionView[];
	/** Avisos do ambiente automático (activeT("status.dev.envDetected"), "Recursos aumentados para Médio"). */
	envNotes: string[];
	/** Medidor de contexto (ausente até o primeiro passo do modelo). */
	contextUsage?: DevContextUsageView;
	/** Onde o tempo foi gasto, por run (o último `dev_timing` de cada run vale; some com `sumDevTiming`). */
	timing?: Record<string, DevTimingEvent>;
	/** Pull request da sessão (aberto pelo agente ou obtido por checkout) e o CI dele. */
	pr?: DevPrInfo;
	ci?: DevCiView;
	/** Contadores vindos da API (sessões recarregadas sem o histórico de eventos). */
	apiStats?: DevSessionStats;
	/** Último `seq` aplicado por run, para o replay do SSE não repetir saída. */
	lastSeq: Record<string, number>;
	/** Runs do agente que já tocaram nesta sessão. */
	runIds: string[];
	/** Hora (ms) do primeiro evento de cada run nesta sessão. */
	runFirstAt?: Record<string, number>;
	/** Início do trecho de trabalho atual (ou do último, se parada): o relógio conta daqui, não da criação da sessão. */
	workStartedAt?: number;
	/** Algum desses runs ainda está ativo (mantido pelo store; ausente = desconhecido). */
	runActive?: boolean;
	/** Instante (ms) do último evento/atividade conhecido. */
	lastActivityAt: number;
};

export type DevEventMeta = { at: number; seq?: number; runId?: string };

export type DevSessionMap = Readonly<Record<string, DevSessionView>>;

const ACTIVE: readonly DevSessionStatusValue[] = ["CREATING", "QUEUED", "RUNNING"];

export function isDevSessionActive(status: DevSessionStatusValue): boolean {
	return ACTIVE.includes(status);
}

type WorkingView = Pick<DevSessionView, "status" | "commands"> & { runActive?: boolean };

/**
 * "Trabalhando" de verdade: preparando/na fila, ou container no ar COM run do
 * agente ativo ou comando rodando. Container RUNNING sem run = pronta (ociosa).
 * `runActive` ausente (view fora do store) mantém o comportamento antigo.
 */
export function devIsWorking(view: WorkingView): boolean {
	if (view.status !== "RUNNING") return isDevSessionActive(view.status);
	if (view.runActive === undefined) return true;
	return view.runActive || view.commands.some((c) => c.status === "running");
}

/** Recalcula `runActive`/`endedAt` das sessões a partir dos runs ativos (puro; mesmo mapa se nada mudou). */
export function withRunActivity(
	map: DevSessionMap,
	liveRuns: ReadonlySet<string>,
	now: number,
	runStarts?: ReadonlyMap<string, number>,
): DevSessionMap {
	let changed = false;
	const next: Record<string, DevSessionView> = {};
	for (const [id, view] of Object.entries(map)) {
		const runActive = view.runIds.some((runId) => liveRuns.has(runId));
		const working = devIsWorking({ ...view, runActive });
		let endedAt = view.endedAt;
		if (view.status === "RUNNING") {
			if (working) endedAt = undefined;
			else if (endedAt === undefined) endedAt = view.runActive === true ? now : view.lastActivityAt;
		}
		let workStartedAt = view.workStartedAt;
		if (working) {
			const starts = view.runIds
				.filter((runId) => liveRuns.has(runId))
				.flatMap((runId) => [runStarts?.get(runId), view.runFirstAt?.[runId]])
				.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
			const known = starts.length > 0 ? Math.min(...starts) : undefined;
			const fresh = workStartedAt === undefined || view.endedAt !== undefined || view.runActive === false;
			if (fresh) workStartedAt = known ?? devWorkStart({ ...view, workStartedAt: undefined });
			else if (known !== undefined && known < (workStartedAt ?? now)) workStartedAt = known;
		}
		if (runActive === view.runActive && endedAt === view.endedAt && workStartedAt === view.workStartedAt) {
			next[id] = view;
			continue;
		}
		changed = true;
		next[id] = { ...view, runActive, endedAt, ...(workStartedAt !== undefined ? { workStartedAt } : {}) };
	}
	return changed ? next : map;
}

export function emptyDevSession(id: string, at: number): DevSessionView {
	return {
		id,
		status: "CREATING",
		startedAt: at,
		setup: [],
		commands: [],
		edits: [],
		todos: [],
		timeline: [],
		compactions: [],
		envNotes: [],
		lastSeq: {},
		runIds: [],
		lastActivityAt: at,
	};
}

function capOutput(previous: string, chunk: string, truncated: boolean) {
	const joined = previous + chunk;
	if (joined.length <= DEV_OUTPUT_CAP_CHARS) return { output: joined, truncated };
	return { output: joined.slice(joined.length - DEV_OUTPUT_CAP_CHARS), truncated: true };
}

function pushTimeline(view: DevSessionView, entry: DevTimelineEntry): DevTimelineEntry[] {
	return view.timeline.some((item) => item.key === entry.key) ? view.timeline : [...view.timeline, entry];
}

/** Aplica um evento a UMA sessão (pura, idempotente para replays com `seq`). */
export function applyDevSessionEventToView(view: DevSessionView, event: DevSessionEvent, meta: DevEventMeta): DevSessionView {
	const runKey = meta.runId ?? "";
	if (meta.seq !== undefined) {
		const last = view.lastSeq[runKey];
		if (last !== undefined && meta.seq <= last) return view;
		view = { ...view, lastSeq: { ...view.lastSeq, [runKey]: meta.seq } };
	}
	view = {
		...view,
		lastActivityAt: Math.max(view.lastActivityAt, meta.at),
		...(meta.runId && !view.runIds.includes(meta.runId) ? { runIds: [...view.runIds, meta.runId] } : {}),
		...(meta.runId && (view.runFirstAt?.[meta.runId] ?? Number.POSITIVE_INFINITY) > meta.at ? { runFirstAt: { ...view.runFirstAt, [meta.runId]: meta.at } } : {}),
	};
	switch (event.type) {
		case "dev_session_status": {
			const active = isDevSessionActive(event.status);
			// Sessão parada/expirada: o container não roda mais nada; comando "em execução" vira "perdido" (sem contador eterno).
			const ended = event.status === "STOPPED" || event.status === "EXPIRED" || event.status === "ERROR";
			const commands = ended
				? view.commands.map((c) =>
						c.status === "running"
							? { ...c, status: "done" as const, exitCode: null, durationMs: Math.max(0, meta.at - c.startedAt), endedReason: (event.status === "STOPPED" ? "stopped" : "lost") as DevShellEndedReason }
							: c,
					)
				: view.commands;
			return {
				...view,
				commands,
				status: event.status,
				tier: event.tier,
				...(event.repo ? { repo: event.repo } : {}),
				...(event.branch ? { branch: event.branch } : {}),
				endedAt: active ? undefined : (view.endedAt ?? meta.at),
			};
		}
		case "dev_setup_step": {
			const existing = view.setup.find((item) => item.step === event.step);
			const next: DevSetupStepView = {
				step: event.step,
				status: event.status,
				startedAt: existing?.startedAt ?? meta.at,
				...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
				...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
				...(event.cache ? { cache: event.cache } : existing?.cache ? { cache: existing.cache } : {}),
				...(event.output ? { output: event.output } : existing?.output ? { output: existing.output } : {}),
			};
			const setup = existing
				? view.setup.map((item) => (item.step === event.step ? next : item))
				: [...view.setup, next];
			return {
				...view,
				setup,
				timeline: pushTimeline(view, { key: `setup:${event.step}`, kind: "setup", ref: event.step, at: next.startedAt }),
			};
		}
		case "shell_started": {
			if (view.commands.some((c) => c.callId === event.callId)) return view;
			const startedAt = Date.parse(event.startedAt);
			const command: DevCommandView = {
				callId: event.callId,
				jobId: event.jobId,
				cmd: event.cmd,
				cwd: event.cwd,
				startedAt: Number.isFinite(startedAt) ? startedAt : meta.at,
				output: "",
				truncated: false,
				status: "running",
			};
			// Evento atrasado depois da sessão parada: nada roda mais, não deixa o comando "em execução".
			if (view.status === "STOPPED" || view.status === "EXPIRED" || view.status === "ERROR") {
				command.status = "done";
				command.exitCode = null;
				command.durationMs = 0;
				command.endedReason = view.status === "STOPPED" ? "stopped" : "lost";
			}
			return {
				...view,
				commands: [...view.commands, command],
				timeline: pushTimeline(view, { key: `cmd:${event.callId}`, kind: "command", ref: event.callId, at: command.startedAt }),
			};
		}
		case "shell_output": {
			let found = false;
			const commands = view.commands.map((c) => {
				if (c.callId !== event.callId) return c;
				found = true;
				return { ...c, ...capOutput(c.output, event.chunk, c.truncated) };
			});
			// Saída sem o início (replay a partir do meio): cria o comando para não perder o texto.
			if (!found) {
				const capped = capOutput("", event.chunk, false);
				const command: DevCommandView = {
					callId: event.callId,
					jobId: event.jobId,
					cmd: "(comando anterior)",
					cwd: "",
					startedAt: meta.at,
					status: "running",
					...capped,
				};
				return {
					...view,
					commands: [...commands, command],
					timeline: pushTimeline(view, { key: `cmd:${event.callId}`, kind: "command", ref: event.callId, at: meta.at }),
				};
			}
			return { ...view, commands };
		}
		case "shell_done": {
			// Idempotente: um segundo shell_done (vigia + agente) não sobrescreve o resultado já final.
			if (view.commands.some((c) => c.callId === event.callId && c.status === "done" && c.endedReason !== "background_running")) return view;
			const commands = view.commands.map((c) =>
				c.callId === event.callId
					? {
							...c,
							status: event.endedReason === "background_running" ? ("running" as const) : ("done" as const),
							...(event.endedReason === "background_running" ? { backgrounded: true } : {}),
							exitCode: event.exitCode,
							// Em segundo plano o evento traz só a espera em primeiro plano: o tempo corrido segue contando desde o início.
							durationMs: event.endedReason === "background_running" ? undefined : event.durationMs,
							endedReason: event.endedReason,
						}
					: c,
			);
			return { ...view, commands };
		}
		case "file_edit": {
			const key = `${event.callId}:${event.path}`;
			if (view.edits.some((e) => `${e.callId}:${e.path}` === key)) return view;
			const edit: DevFileEditView = {
				callId: event.callId,
				path: event.path,
				diff: event.diff,
				added: event.added,
				removed: event.removed,
				at: meta.at,
			};
			return {
				...view,
				edits: [...view.edits, edit],
				timeline: pushTimeline(view, { key: `file:${key}`, kind: "file", ref: key, at: meta.at }),
			};
		}
		case "dev_environment_updated": {
			const note = event.note ?? (event.auto ? activeT("status.dev.envDetected") : null);
			if (!note || view.envNotes.includes(note)) return view;
			return { ...view, envNotes: [...view.envNotes, note] };
		}
		case "todo_updated":
			return { ...view, todos: event.items.map((item) => ({ ...item })) };
		case "dev_pr": {
			const { type: _type, sessionId: _sessionId, ...pr } = event;
			// Outro PR começa sem os checks do anterior.
			return { ...view, pr, ...(view.pr && view.pr.number !== pr.number ? { ci: undefined } : {}) };
		}
		case "dev_ci":
			return { ...view, ci: { checks: event.checks.map((check) => ({ ...check })), summary: event.summary, at: meta.at } };
	}
}

export type ContextUsageValue = { sessionId?: string; model?: string; usedTokens: number; windowTokens: number; compactAtTokens: number };

/** Guarda só o uso mais recente (eventos fora de ordem, como o replay do histórico, não regridem o medidor). */
export function applyContextUsage(map: DevSessionMap, event: ContextUsageValue, meta: DevEventMeta): DevSessionMap {
	if (!event.sessionId || !(event.windowTokens > 0) || !Number.isFinite(event.usedTokens)) return map;
	const current = map[event.sessionId] ?? emptyDevSession(event.sessionId, meta.at);
	if (current.contextUsage && current.contextUsage.at > meta.at) return map;
	const contextUsage: DevContextUsageView = {
		...(event.model ? { model: event.model } : {}),
		usedTokens: Math.max(0, event.usedTokens),
		windowTokens: event.windowTokens,
		compactAtTokens: Math.min(event.windowTokens, Math.max(1, event.compactAtTokens)),
		at: meta.at,
	};
	return { ...map, [event.sessionId]: { ...current, contextUsage } };
}

/** Guarda o `dev_timing` mais recente de cada run (idempotente no replay do histórico). */
export function applyDevTiming(map: DevSessionMap, event: DevTimingEvent, meta: DevEventMeta): DevSessionMap {
	if (!event.sessionId) return map;
	const current = map[event.sessionId] ?? emptyDevSession(event.sessionId, meta.at);
	const key = meta.runId ?? "run";
	const previous = current.timing?.[key];
	if (previous && previous.modelMs + previous.toolsMs + previous.setupMs > event.modelMs + event.toolsMs + event.setupMs) return map;
	return { ...map, [event.sessionId]: { ...current, timing: { ...current.timing, [key]: event } } };
}

export type ContextCompactedValue = { sessionId?: string; before: number; after: number };

/** Registra um resumo de contexto na sessão (idempotente por `runId:seq`). */
export function applyContextCompactedToView(view: DevSessionView, event: ContextCompactedValue, meta: DevEventMeta): DevSessionView {
	const key = `${meta.runId ?? ""}:${meta.seq ?? meta.at}`;
	if (view.compactions.some((item) => item.key === key)) return view;
	return { ...view, compactions: [...view.compactions, { key, at: meta.at, before: event.before, after: event.after }] };
}

export function applyContextCompacted(map: DevSessionMap, event: ContextCompactedValue, meta: DevEventMeta): DevSessionMap {
	if (!event.sessionId) return map;
	const current = map[event.sessionId] ?? emptyDevSession(event.sessionId, meta.at);
	const next = applyContextCompactedToView(current, event, meta);
	if (next === map[event.sessionId]) return map;
	return { ...map, [event.sessionId]: next };
}

/** Evento do histórico persistido (`GET /v1/dev-sessions/:id/events`). */
export type DevHistoryItem = { runId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string };

/**
 * Reaplica o histórico persistido na ordem em que ocorreu. O `seq` por run torna
 * a operação idempotente com o que já chegou ao vivo.
 */
export function applyDevHistory(map: DevSessionMap, history: readonly DevHistoryItem[]): DevSessionMap {
	let next = map;
	for (const item of history) {
		const at = Date.parse(item.createdAt);
		const meta: DevEventMeta = { at: Number.isFinite(at) ? at : Date.now(), seq: item.seq, runId: item.runId };
		if (item.type === "dev_timing") {
			next = applyDevTiming(next, item.payload as unknown as DevTimingEvent, meta);
		} else if (item.type === "context_usage") {
			next = applyContextUsage(next, item.payload as unknown as ContextUsageValue, meta);
		} else if (item.type === "context_compacted") {
			next = applyContextCompacted(next, item.payload as unknown as ContextCompactedValue, meta);
		} else if ((DEV_SESSION_EVENT_TYPES as readonly string[]).includes(item.type)) {
			next = applyDevSessionEvent(next, { ...item.payload, type: item.type } as unknown as DevSessionEvent, meta);
		}
	}
	return next;
}

/** Aplica um evento ao mapa de sessões (cria a sessão no primeiro evento). */
export function applyDevSessionEvent(map: DevSessionMap, event: DevSessionEvent, meta: DevEventMeta): DevSessionMap {
	const current = map[event.sessionId] ?? emptyDevSession(event.sessionId, meta.at);
	const next = applyDevSessionEventToView(current, event, meta);
	if (next === map[event.sessionId]) return map;
	return { ...map, [event.sessionId]: next };
}

export type DevSessionApiSummary = {
	id: string;
	status: DevSessionStatusValue;
	tier?: DevSessionTierValue;
	repo?: string | null;
	branch?: string | null;
	startedAt?: string;
	lastActiveAt?: string;
	todos?: DevTodoItemValue[];
	stats?: DevSessionStats;
	pr?: DevPrInfo | null;
};

/** Hidrata a sessão com o que a API sabe; eventos já recebidos ao vivo têm prioridade. */
export function hydrateDevSession(map: DevSessionMap, api: DevSessionApiSummary, options: { authoritativeStatus?: boolean } = {}): DevSessionMap {
	const existing = map[api.id];
	const started = api.startedAt ? Date.parse(api.startedAt) : Number.NaN;
	const last = api.lastActiveAt ? Date.parse(api.lastActiveAt) : Number.NaN;
	const base = existing ?? emptyDevSession(api.id, Number.isFinite(started) ? started : Date.now());
	const hasLive = !options.authoritativeStatus && existing !== undefined && (existing.commands.length > 0 || existing.edits.length > 0);
	const status = hasLive ? base.status : api.status;
	const next: DevSessionView = {
		...base,
		status,
		...(api.tier ? { tier: api.tier } : {}),
		...(api.repo ? { repo: api.repo } : {}),
		...(api.branch ? { branch: api.branch } : {}),
		startedAt: Number.isFinite(started) ? started : base.startedAt,
		endedAt: isDevSessionActive(status) ? undefined : (base.endedAt ?? (Number.isFinite(last) ? last : base.startedAt)),
		todos: base.todos.length > 0 ? base.todos : (api.todos ?? []),
		...(api.stats ? { apiStats: api.stats } : {}),
		...(api.pr && !base.pr ? { pr: { number: api.pr.number, url: api.pr.url, state: api.pr.state, title: api.pr.title, base: api.pr.base, head: api.pr.head, ...(api.pr.headSha ? { headSha: api.pr.headSha } : {}) } } : {}),
		lastActivityAt: Math.max(base.lastActivityAt, Number.isFinite(last) ? last : 0),
	};
	return { ...map, [api.id]: next };
}

export type DevCounters = { commands: number; files: number; added: number; removed: number };

export type DevChangedFile = { path: string; added: number; removed: number; diffs: string[] };

/** Linhas +/- de um diff unificado (sem cabeçalhos `+++`/`---`). */
function diffChangeLines(diff: string): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added.push(line.slice(1));
		else if (line.startsWith("-")) removed.push(line.slice(1));
	}
	return { added, removed };
}

/**
 * Mudança líquida de um arquivo a partir das edições em ordem: uma linha
 * removida que depois volta (ou adicionada que depois sai) se anula, então
 * reverter uma edição zera o saldo.
 */
export function netEditChange(edits: readonly Pick<DevFileEditView, "diff" | "added" | "removed">[]): { added: number; removed: number } {
	const pendingAdded = new Map<string, number>();
	const pendingRemoved = new Map<string, number>();
	let added = 0;
	let removed = 0;
	let cancelled = 0;
	const bump = (map: Map<string, number>, key: string, by: number) => map.set(key, (map.get(key) ?? 0) + by);
	for (const edit of edits) {
		// Os contadores do evento são a fonte; o diff só serve para detectar o que foi desfeito.
		added += edit.added;
		removed += edit.removed;
		// Cada edição só desfaz o que veio ANTES dela (linha movida dentro do mesmo diff não conta).
		const lines = diffChangeLines(edit.diff);
		const freshAdded: string[] = [];
		const freshRemoved: string[] = [];
		for (const line of lines.added) {
			if ((pendingRemoved.get(line) ?? 0) > 0) {
				bump(pendingRemoved, line, -1);
				cancelled += 1;
			} else freshAdded.push(line);
		}
		for (const line of lines.removed) {
			if ((pendingAdded.get(line) ?? 0) > 0) {
				bump(pendingAdded, line, -1);
				cancelled += 1;
			} else freshRemoved.push(line);
		}
		for (const line of freshAdded) bump(pendingAdded, line, 1);
		for (const line of freshRemoved) bump(pendingRemoved, line, 1);
	}
	// Cada par anulado tira uma linha de "+" e uma de "−".
	return { added: Math.max(0, added - cancelled), removed: Math.max(0, removed - cancelled) };
}

/** Arquivos com mudança líquida (um por caminho, diffs na ordem em que chegaram); os revertidos somem. */
export function devChangedFiles(view: DevSessionView): DevChangedFile[] {
	const byPath = new Map<string, DevFileEditView[]>();
	for (const edit of view.edits) byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
	const files: DevChangedFile[] = [];
	for (const [path, edits] of byPath) {
		const net = netEditChange(edits);
		if (net.added === 0 && net.removed === 0) continue;
		files.push({ path, ...net, diffs: edits.map((edit) => edit.diff) });
	}
	if (byPath.size === 0 && view.apiStats) {
		for (const file of view.apiStats.filesChanged) files.push({ ...file, diffs: [] });
	}
	return files;
}

export function devSessionCounters(view: DevSessionView): DevCounters {
	const files = devChangedFiles(view);
	const api = view.apiStats;
	const live = view.edits.length > 0;
	const added = files.reduce((n, f) => n + f.added, 0);
	const removed = files.reduce((n, f) => n + f.removed, 0);
	return {
		commands: Math.max(view.commands.length, api?.commandsRun ?? 0),
		files: live ? files.length : Math.max(files.length, api?.filesChanged.length ?? 0),
		added: live ? added : Math.max(added, api?.totalAdded ?? 0),
		removed: live ? removed : Math.max(removed, api?.totalRemoved ?? 0),
	};
}

const SETUP_LABEL_KEY = {
	container: "status.dev.setupCreating",
	clone: "status.dev.setup.clone",
	checkout: "status.dev.setup.checkout",
	detect: "status.dev.setup.detect",
	install: "status.dev.setup.install",
	start: "status.dev.setup.start",
	push: "status.dev.setup.push",
} as const;

export function devSetupLabel(step: string, cache?: DevSetupCacheState, durationMs?: number, { t }: Translator = getActiveTranslator()): string {
	const key = (SETUP_LABEL_KEY as Record<string, MessageKey>)[step];
	const base = key ? (t as (key: MessageKey) => string)(key) : step;
	if (step !== "install" || !cache || cache === "miss") return base;
	if (cache === "hit") return durationMs !== undefined ? t("status.dev.cacheHit", { label: base, elapsed: formatElapsed(durationMs) }) : t("status.dev.cacheHitNoTime", { label: base });
	return t("status.dev.cacheStale", { label: base });
}

/** Linha "agora: …" do que a sessão está fazendo neste instante. */
export function devCurrentStep(view: DevSessionView, translator: Translator = getActiveTranslator()): string | null {
	if (!devIsWorking(view)) return null;
	const running = [...view.commands].reverse().find((c) => c.status === "running");
	if (running) return redactSecrets(running.cmd).split("\n")[0]!.slice(0, 120);
	const setup = view.setup.find((s) => s.status === "running");
	if (setup) return devSetupLabel(setup.step, undefined, undefined, translator);
	const todo = view.todos.find((t) => t.status === "in_progress");
	if (todo) return todo.content;
	return null;
}

const DEV_STATUS_VALUES = ["CREATING", "QUEUED", "RUNNING", "IDLE", "STOPPED", "EXPIRED", "ERROR"] as const satisfies readonly DevSessionStatusValue[];

/** Getters: o rótulo segue o idioma da tela (lido ao desenhar, não ao importar o módulo). */
export const DEV_STATUS_LABEL = Object.defineProperties(
	{} as Record<DevSessionStatusValue, string>,
	Object.fromEntries(DEV_STATUS_VALUES.map((value) => [value, { enumerable: true, get: () => activeT(`status.dev.state.${value}`) }])),
);

export type DevTone = "info" | "working" | "idle" | "done" | "error";

export const DEV_STATUS_TONE: Record<DevSessionStatusValue, DevTone> = {
	CREATING: "info",
	QUEUED: "info",
	RUNNING: "working",
	IDLE: "idle",
	STOPPED: "done",
	EXPIRED: "idle",
	ERROR: "error",
};

/** Rótulo do estado: RUNNING sem run ativo nem comando = "Pronta". */
export function devStatusLabel(view: WorkingView, { t }: Translator = getActiveTranslator()): string {
	if (view.status === "RUNNING" && !devIsWorking(view)) return t("status.dev.ready");
	return t(`status.dev.state.${view.status}`);
}

export function devStatusTone(view: WorkingView): DevTone {
	if (view.status === "RUNNING" && !devIsWorking(view)) return "idle";
	return DEV_STATUS_TONE[view.status];
}

/** Marca curta dos checks para a linha do cartão: ✓ passou, ✗ falhou, … rodando. */
const CI_MARK: Record<DevCiSummary, string | null> = { passing: "✓", failing: "✗", pending: "…", none: null };

/** "PR #42 · checks ✓" / "PR #42 · mesclada" (linha 2 do cartão); `null` sem PR. */
export function devPrCardText(view: Pick<DevSessionView, "pr" | "ci">, { t }: Translator = getActiveTranslator()): string | null {
	if (!view.pr) return null;
	const head = `PR #${view.pr.number}`;
	if (view.pr.state === "merged") return t("status.dev.prMerged", { number: view.pr.number });
	if (view.pr.state === "closed") return t("status.dev.prClosed", { number: view.pr.number });
	const mark = view.ci ? CI_MARK[view.ci.summary] : null;
	return mark ? t("status.dev.prChecks", { number: view.pr.number, mark }) : head;
}

export function devSessionTitle(view: Pick<DevSessionView, "repo" | "branch">, { t }: Translator = getActiveTranslator()): string {
	const repo = view.repo?.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
	if (repo && view.branch) return `${repo} · ${view.branch}`;
	return repo || view.branch || t("status.dev.codeSession");
}

type TimedView = WorkingView & Pick<DevSessionView, "startedAt" | "endedAt"> & Partial<Pick<DevSessionView, "workStartedAt" | "runFirstAt" | "runIds">>;

/** Começo do trecho de trabalho atual/último: início do run, não a criação da sessão (que é reaproveitada entre runs). */
export function devWorkStart(view: TimedView): number {
	if (view.workStartedAt !== undefined) return view.workStartedAt;
	const lastRun = view.runIds?.[view.runIds.length - 1];
	const lastRunAt = lastRun ? view.runFirstAt?.[lastRun] : undefined;
	return lastRunAt ?? view.startedAt;
}

/** Tempo do trecho de trabalho: em andamento conta até `now`, parado até `endedAt`. */
export function devElapsedMs(view: TimedView, now: number): number {
	const end = devIsWorking(view) || view.endedAt === undefined ? now : view.endedAt;
	return Math.max(0, end - devWorkStart(view));
}

/** "12s", "4m12s", "1h02m". */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

/**
 * Resumo do painel "Tempo": só o que passou de 1s. "Comandos" soma shell em primeiro plano e esperas de
 * `shell_output`. Sem `dev_timing` (sessão antiga), devolve null e o painel não mostra a seção.
 */
export function devTimingParts(view: Pick<DevSessionView, "timing">, { t, tn }: Translator = getActiveTranslator()): { label: string; ms?: number; text: string }[] | null {
	const runs = Object.values(view.timing ?? {});
	if (runs.length === 0) return null;
	const total = sumDevTiming(runs);
	const parts: { label: string; ms?: number; text: string }[] = [];
	const add = (label: string, ms: number) => {
		if (ms >= 1000) parts.push({ label, ms, text: `${label} ${formatElapsed(ms)}` });
	};
	add(t("status.dev.timeModel"), total.modelMs);
	add(t("status.dev.timeCommands"), total.shellMs + total.pollWaitMs);
	add(t("status.dev.timeApproval"), total.approvalMs);
	add(t("status.dev.timeSetup"), total.setupMs);
	if (total.steps > 0) parts.push({ label: t("status.dev.stepsLabel"), text: tn("status.dev.steps", total.steps) });
	return parts.length > 0 ? parts : null;
}

/** Primeiro token médio do modelo (ms) ou null. */
export function devAverageFirstTokenMs(view: Pick<DevSessionView, "timing">): number | null {
	const total = sumDevTiming(Object.values(view.timing ?? {}));
	return total.steps > 0 && total.firstTokenMs > 0 ? Math.round(total.firstTokenMs / total.steps) : null;
}

/** "13min 46s", "46s", "1h 02min". */
export function formatElapsedLong(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
	if (m > 0) return `${m}min ${s}s`;
	return `${s}s`;
}

/** Status curto: "4m52s" enquanto trabalha; "Concluída · 16s" depois (preparando/na fila levam o rótulo). */
export function devRowStatus(view: TimedView, now: number, translator: Translator = getActiveTranslator()): string {
	const time = formatElapsed(devElapsedMs(view, now));
	if (view.status === "QUEUED") return translator.t("status.dev.state.QUEUED");
	return devIsWorking(view) ? time : `${devStatusLabel(view, translator)} · ${time}`;
}

/** Texto único do cabeçalho do painel: "Trabalhando · 4m21s" / "Concluída · 6m03s". */
export function devPillLabel(view: TimedView, now: number, translator: Translator = getActiveTranslator()): string {
	if (view.status === "QUEUED") return translator.t("status.dev.state.QUEUED");
	return `${devStatusLabel(view, translator)} · ${formatElapsed(devElapsedMs(view, now))}`;
}

export function devTimerLabel(view: TimedView, now: number, { t }: Translator = getActiveTranslator()): string {
	const elapsed = formatElapsed(devElapsedMs(view, now));
	return devIsWorking(view) ? t("status.dev.workingFor", { elapsed }) : t("status.dev.workedFor", { elapsed });
}

/** Remove sequências ANSI (cores, cursor) e retornos de carro de barras de progresso. */
export function stripAnsi(text: string): string {
	return text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/[^\n]*\r(?!\n)/g, "");
}
