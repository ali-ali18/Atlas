/**
 * Sessões de desenvolvimento do agente (container leve por sessão): eventos do
 * run (persistidos e enviados por SSE) e utilitários puros da lista de tarefas.
 * Modelados nos itens do Codex: comando (started/output/done), edição de
 * arquivo com diff unificado e lista de tarefas.
 */

export type DevSessionStatusValue = "CREATING" | "QUEUED" | "RUNNING" | "IDLE" | "STOPPED" | "EXPIRED" | "ERROR";
export type DevSessionTierValue = "small" | "medium" | "large";
export type DevSetupStepName = "container" | "clone" | "checkout" | "detect" | "install" | "start" | (string & {});
/** Como o cache de dependências do ambiente entrou no passo de instalação. */
export type DevSetupCacheState = "hit" | "stale" | "rebuild" | "miss";
export type DevTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type DevTodoItemValue = { id: string; content: string; status: DevTodoStatus };

/** Estado do pull request (rascunho e mesclada são derivados do GitHub). */
export type DevPrState = "open" | "draft" | "merged" | "closed";

export type DevPrInfo = {
	number: number;
	url: string;
	state: DevPrState;
	title: string;
	base: string;
	head: string;
	headSha?: string;
};

export type DevCiCheckStatus = "queued" | "in_progress" | "completed";
export type DevCiCheck = {
	name: string;
	status: DevCiCheckStatus;
	/** success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | null (ainda sem resultado). */
	conclusion: string | null;
	url?: string;
	durationMs?: number;
	/** Id do job no GitHub Actions (para `dev_ci_logs`), quando houver. */
	jobId?: number;
};
/** `none` = o PR ainda não tem nenhuma verificação. */
export type DevCiSummary = "passing" | "failing" | "pending" | "none";

const CI_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const CI_OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export function ciCheckFailed(check: Pick<DevCiCheck, "status" | "conclusion">): boolean {
	return check.status === "completed" && CI_FAILURE_CONCLUSIONS.has(check.conclusion ?? "");
}

export function ciCheckPassed(check: Pick<DevCiCheck, "status" | "conclusion">): boolean {
	return check.status === "completed" && CI_OK_CONCLUSIONS.has(check.conclusion ?? "");
}

/** Falhou se alguma verificação falhou (mesmo com outras rodando); pendente se alguma não terminou; senão passou. */
export function summarizeCi(checks: readonly Pick<DevCiCheck, "status" | "conclusion">[]): DevCiSummary {
	if (checks.length === 0) return "none";
	if (checks.some(ciCheckFailed)) return "failing";
	if (checks.some((check) => check.status !== "completed")) return "pending";
	return "passing";
}

/** "3 de 4 passaram" / "1 falhou · 3 de 4 passaram" (texto curto para o painel). */
export function ciSummaryText(checks: readonly Pick<DevCiCheck, "status" | "conclusion">[]): string {
	const total = checks.length;
	if (total === 0) return "Sem verificações";
	const passed = checks.filter(ciCheckPassed).length;
	const failed = checks.filter(ciCheckFailed).length;
	const base = `${passed} de ${total} ${passed === 1 ? "passou" : "passaram"}`;
	if (failed > 0) return `${failed} ${failed === 1 ? "falhou" : "falharam"} · ${base}`;
	const running = total - passed;
	return running > 0 ? `${base} · ${running} em andamento` : base;
}

/** Texto do estado do PR para a UI (neutro). */
export const DEV_PR_STATE_LABEL: Record<DevPrState, string> = {
	open: "Aberta",
	draft: "Rascunho",
	merged: "Mesclada",
	closed: "Fechada",
};

/** Deriva o estado do PR a partir dos campos da API do GitHub. */
export function devPrStateFrom(input: { state?: string; merged?: boolean; draft?: boolean }): DevPrState {
	if (input.merged) return "merged";
	if (input.state === "closed") return "closed";
	return input.draft ? "draft" : "open";
}

/** `https://github.com/o/r/pull/12`, `#12` ou `12` -> número (e repositório, quando vem na URL). */
export function parsePrReference(input: string): { number: number; repo?: string } | null {
	const text = input.trim();
	const url = /^https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(text);
	if (url) return { number: Number(url[3]), repo: `${url[1]}/${url[2]}` };
	const plain = /^#?(\d{1,9})$/.exec(text);
	return plain ? { number: Number(plain[1]) } : null;
}

/**
 * `stopped`: a sessão/container parou com o comando rodando; `lost`: o container não conhece mais o job
 * (recriado/reiniciado) ou a sessão acabou.
 */
export type DevShellEndedReason = "exit" | "timeout" | "killed" | "background_running" | "error" | "stopped" | "lost";

/** Teto de um comando em segundo plano no container (docker/dev-sandbox/server/exec-jobs.mjs). */
export const DEV_JOB_MAX_MS = 30 * 60_000;

/** Comando normalizado para detectar relançamentos idênticos (espaços colapsados, sem `;`/espaço final). */
export function normalizeShellCmd(cmd: string): string {
	// Espaços/quebras de linha viram um espaço só; `;` e `&&` finais são ignorados.
	let out = "";
	let pendingSpace = false;
	for (const ch of cmd.trim()) {
		if (ch <= " ") {
			pendingSpace = out.length > 0;
			continue;
		}
		if (pendingSpace) out += " ";
		pendingSpace = false;
		out += ch;
	}
	while (out.endsWith(";") || out.endsWith(" ") || out.endsWith("&&")) out = out.endsWith("&&") ? out.slice(0, -2) : out.slice(0, -1);
	return out;
}

/** `streamed`: já houve algum `shell_output` gravado para o job (a saída já está no histórico). */
export type OpenDevJob = { jobId: string; callId: string; cmd: string; startedAt: number; streamed?: boolean };

type JobEventRow = { type: string; payload: unknown; createdAt?: Date | string };

/**
 * Jobs de shell ainda sem `shell_done` final de uma sessão (puro). `background_running` NÃO fecha o job:
 * é só "saí da espera em primeiro plano". Linhas em ordem cronológica.
 */
export function computeOpenDevJobs(rows: readonly JobEventRow[]): OpenDevJob[] {
	const open = new Map<string, OpenDevJob>();
	for (const row of rows) {
		const p = (row.payload ?? {}) as { jobId?: unknown; callId?: unknown; cmd?: unknown; startedAt?: unknown; endedReason?: unknown };
		if (typeof p.jobId !== "string" || typeof p.callId !== "string") continue;
		if (row.type === "shell_started") {
			const parsed = typeof p.startedAt === "string" ? Date.parse(p.startedAt) : Number.NaN;
			const created = row.createdAt ? new Date(row.createdAt).getTime() : Date.now();
			open.set(p.callId, { jobId: p.jobId, callId: p.callId, cmd: typeof p.cmd === "string" ? p.cmd : "", startedAt: Number.isFinite(parsed) ? parsed : created });
		} else if (row.type === "shell_output") {
			const job = open.get(p.callId);
			if (job) job.streamed = true;
		} else if (row.type === "shell_done" && p.endedReason !== "background_running") {
			open.delete(p.callId);
		}
	}
	return [...open.values()];
}

/** Máximo de bytes do diff unificado anexado a `file_edit`. */
export const DEV_DIFF_CAP_BYTES = 32 * 1024;
/** Teto de saída de shell enviada por eventos numa mesma chamada (o resto fica em `shell_output`). */
export const DEV_SHELL_EVENT_CAP_BYTES = 64 * 1024;
export const DEV_SHELL_OUTPUT_THROTTLE_MS = 250;
/** `shell_output`: espera padrão (long-poll) e janela para juntar saída que chega logo depois da primeira. */
export const DEV_SHELL_OUTPUT_DEFAULT_WAIT_MS = 15_000;
/** Teto da espera do `shell_output` e piso quando não há saída nova (o modelo não consegue girar em polls curtos). */
export const DEV_SHELL_OUTPUT_MAX_WAIT_MS = 30_000;
export const DEV_SHELL_OUTPUT_MIN_WAIT_MS = 5_000;
export const DEV_SHELL_SETTLE_MS = 750;
export const DEV_TODO_MAX_ITEMS = 50;
export const DEV_TODO_CONTENT_MAX = 300;

/** Todo evento de sessão de desenvolvimento carrega `sessionId` (o painel filtra os eventos da conversa por sessão). */
export type DevSessionEvent =
	| {
			type: "dev_session_status";
			sessionId: string;
			status: DevSessionStatusValue;
			tier: DevSessionTierValue;
			repo?: string;
			branch?: string;
	  }
	| {
			type: "dev_setup_step";
			sessionId: string;
			step: DevSetupStepName;
			status: "running" | "done" | "failed";
			exitCode?: number;
			durationMs?: number;
			/** Passo de instalação: hit (restaurado), stale (lockfile mudou, instala por cima), rebuild (comando/segredos mudaram), miss (primeira vez). */
			cache?: DevSetupCacheState;
			/** Fim da saída do passo (instalação/início), já redigida e com teto de bytes. */
			output?: string;
	  }
	| { type: "shell_started"; sessionId: string; callId: string; jobId: string; cmd: string; cwd: string; startedAt: string }
	| { type: "shell_output"; sessionId: string; callId: string; jobId: string; chunk: string }
	| {
			type: "shell_done";
			sessionId: string;
			callId: string;
			jobId: string;
			exitCode: number | null;
			durationMs: number;
			endedReason: DevShellEndedReason;
	  }
	| { type: "file_edit"; sessionId: string; callId: string; path: string; diff: string; added: number; removed: number }
	| { type: "todo_updated"; sessionId: string; items: DevTodoItemValue[] }
	| {
			/** O ambiente do repositório foi criado (detecção automática) ou ajustado pelo agente. */
			type: "dev_environment_updated";
			sessionId: string;
			repo: string;
			auto?: boolean;
			applied: string[];
			/** Texto curto para o painel ("Recursos aumentados para Médio"). */
			note?: string;
	  }
	| ({ type: "dev_pr"; sessionId: string } & DevPrInfo)
	| { type: "dev_ci"; sessionId: string; checks: DevCiCheck[]; summary: DevCiSummary };

export const DEV_SESSION_EVENT_TYPES = [
	"dev_session_status",
	"dev_setup_step",
	"shell_started",
	"shell_output",
	"shell_done",
	"file_edit",
	"todo_updated",
	"dev_environment_updated",
	"dev_pr",
	"dev_ci",
] as const;

export function isDevSessionEvent(event: { type?: unknown }): event is DevSessionEvent {
	return typeof event.type === "string" && (DEV_SESSION_EVENT_TYPES as readonly string[]).includes(event.type);
}

const TODO_STATUSES: readonly DevTodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];

/** Valida os itens do `todo_write`; lança em pt-BR (vira tool_result de erro). */
export function parseTodoItems(raw: unknown): DevTodoItemValue[] {
	if (!Array.isArray(raw)) throw new Error("items deve ser uma lista de {id, content, status}");
	if (raw.length > DEV_TODO_MAX_ITEMS) throw new Error(`no máximo ${DEV_TODO_MAX_ITEMS} itens`);
	const seen = new Set<string>();
	return raw.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`item ${index + 1} inválido`);
		const item = entry as Record<string, unknown>;
		const id = typeof item.id === "string" ? item.id.trim() : typeof item.id === "number" ? String(item.id) : "";
		if (!id || id.length > 64) throw new Error(`item ${index + 1}: id obrigatório (até 64 caracteres)`);
		if (seen.has(id)) throw new Error(`id repetido: ${id}`);
		seen.add(id);
		const content = typeof item.content === "string" ? item.content.trim() : "";
		if (!content) throw new Error(`item ${id}: content obrigatório`);
		const status = item.status === undefined ? "pending" : item.status;
		if (!TODO_STATUSES.includes(status as DevTodoStatus)) {
			throw new Error(`item ${id}: status deve ser ${TODO_STATUSES.join("|")}`);
		}
		return { id, content: content.slice(0, DEV_TODO_CONTENT_MAX), status: status as DevTodoStatus };
	});
}

/** `merge: true` atualiza por id e acrescenta os novos; senão substitui a lista inteira. */
export function mergeTodoItems(
	previous: readonly DevTodoItemValue[],
	incoming: readonly DevTodoItemValue[],
	merge: boolean,
): DevTodoItemValue[] {
	if (!merge) return incoming.map((item) => ({ ...item }));
	const byId = new Map(previous.map((item) => [item.id, { ...item }]));
	for (const item of incoming) byId.set(item.id, { ...item });
	return [...byId.values()].slice(0, DEV_TODO_MAX_ITEMS);
}

/** Corta o diff unificado em `cap` bytes (por linhas inteiras) e marca o corte. */
export function capDiffText(diff: string, cap = DEV_DIFF_CAP_BYTES): string {
	if (new TextEncoder().encode(diff).length <= cap) return diff;
	const kept: string[] = [];
	let bytes = 0;
	for (const line of diff.split("\n")) {
		bytes += new TextEncoder().encode(line).length + 1;
		if (bytes > cap) break;
		kept.push(line);
	}
	return `${kept.join("\n")}\n... [diff truncado]`;
}

/**
 * O contexto do agente foi resumido (passos antigos saíram do pacote enviado ao
 * modelo). `before`/`after` são estimativas de tokens. `sessionId` só existe em
 * runs de código; o histórico da sessão também lista este evento.
 */
export type ContextCompactedEvent = { type: "context_compacted"; sessionId?: string; before: number; after: number };

/**
 * Uso da janela de contexto depois de um passo do modelo (runs de código): `usedTokens`
 * estimados, `windowTokens` do modelo e `compactAtTokens`, onde o resumo automático dispara.
 */
export type ContextUsageEvent = {
	type: "context_usage";
	sessionId?: string;
	/** Modelo em uso no passo (muda quando o modelo para código entra). */
	model?: string;
	usedTokens: number;
	windowTokens: number;
	compactAtTokens: number;
};

/**
 * Onde o tempo de um run de código foi gasto (acumulado no run; o último evento do run vale).
 * `toolsMs` = todas as tools da sessão (comandos, polling e arquivos); `shellMs` = comandos em
 * primeiro plano; `pollWaitMs` = esperas de `shell_output`; `setupMs` = clone/instalação/início.
 * `approvalPendingAt` marca um cartão de confirmação aberto ao fim do run: a espera real vai até o
 * `startedAt` do run seguinte (somada por `sumDevTiming`).
 */
export type DevTimingEvent = {
	type: "dev_timing";
	sessionId: string;
	model?: string;
	startedAt: number;
	modelMs: number;
	firstTokenMs: number;
	toolsMs: number;
	shellMs: number;
	pollWaitMs: number;
	setupMs: number;
	approvalMs: number;
	approvalPendingAt?: number;
	steps: number;
};

export type DevTimingTotals = Pick<DevTimingEvent, "modelMs" | "firstTokenMs" | "toolsMs" | "shellMs" | "pollWaitMs" | "setupMs" | "approvalMs" | "steps">;

/** Soma os runs da sessão (ordem por `startedAt`) e inclui a espera de aprovação entre runs. */
export function sumDevTiming(runs: readonly Pick<DevTimingEvent, keyof DevTimingTotals | "startedAt" | "approvalPendingAt">[]): DevTimingTotals {
	const total: DevTimingTotals = { modelMs: 0, firstTokenMs: 0, toolsMs: 0, shellMs: 0, pollWaitMs: 0, setupMs: 0, approvalMs: 0, steps: 0 };
	const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt);
	ordered.forEach((run, index) => {
		for (const key of Object.keys(total) as Array<keyof DevTimingTotals>) total[key] += run[key] || 0;
		const next = ordered[index + 1];
		if (run.approvalPendingAt && next && next.startedAt > run.approvalPendingAt) total.approvalMs += next.startedAt - run.approvalPendingAt;
	});
	return total;
}

/** Tipos de evento (além de DEV_SESSION_EVENT_TYPES) que o histórico da sessão devolve. */
export const DEV_HISTORY_EVENT_TYPES = [...DEV_SESSION_EVENT_TYPES, "context_compacted", "context_usage", "dev_timing"] as const;

/** Teto de saída guardada por comando no histórico (o fim é o que importa). */
export const DEV_HISTORY_OUTPUT_CAP_BYTES = 64 * 1024;

export type DevHistoryEvent = {
	id: string;
	runId: string;
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
};

/**
 * Mantém só o FIM da saída de cada comando (`shell_output` por `callId`) até
 * `capBytes`; o primeiro bloco mantido ganha um aviso de início omitido.
 * Demais eventos passam intactos, na mesma ordem.
 */
export function capHistoryShellOutput<T extends { type: string; payload: Record<string, unknown> }>(
	events: readonly T[],
	capBytes = DEV_HISTORY_OUTPUT_CAP_BYTES,
): T[] {
	const encoder = new TextEncoder();
	const sizes = events.map((event) =>
		event.type === "shell_output" && typeof event.payload.chunk === "string" ? encoder.encode(event.payload.chunk).length : 0,
	);
	const kept = new Map<number, boolean>();
	const used = new Map<string, number>();
	const firstKept = new Map<string, number>();
	const dropped = new Set<string>();
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i]!;
		if (event.type !== "shell_output") continue;
		const callId = String(event.payload.callId ?? "");
		if (dropped.has(callId)) continue;
		const total = (used.get(callId) ?? 0) + sizes[i]!;
		if (total <= capBytes) {
			used.set(callId, total);
			kept.set(i, true);
			firstKept.set(callId, i);
		} else {
			dropped.add(callId);
		}
	}
	const out: T[] = [];
	events.forEach((event, i) => {
		if (event.type !== "shell_output") return void out.push(event);
		if (!kept.get(i)) return;
		const callId = String(event.payload.callId ?? "");
		if (dropped.has(callId) && firstKept.get(callId) === i) {
			out.push({ ...event, payload: { ...event.payload, chunk: `[início da saída omitido]\n${String(event.payload.chunk)}` } });
		} else {
			out.push(event);
		}
	});
	return out;
}
