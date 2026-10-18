/**
 * F12/D2+D4 — estado da página e métricas do computador. Funções puras: a
 * chave de estado (URL + elementos + scroll) diz se uma ação mudou algo; o
 * rastreador de estagnação transforma "nada mudou" em dica e, no fim, em
 * aborto; as métricas vão para `usageJson.computer` (sem mudar o schema).
 */

/** FNV-1a de 32 bits em hex: curto, estável e sem dependência. */
export function hashString(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export type ComputerStateInput = {
	url?: string;
	/** Linhas do snapshot (`[e3] button "Salvar"`); o ref sai da comparação. */
	lines?: readonly string[];
	scrollY?: number;
	/** Qualquer fato extra que defina o estado (valor de campo, delta). */
	extra?: string;
};

/**
 * Mesmo estado = mesma chave. O ref (`[e3]`, `[f1e3]`) é ignorado (renumera a cada
 * snapshot) e o scroll entra em faixas de 50 px.
 */
export function computerStateKey(input: ComputerStateInput): string {
	const lines = (input.lines ?? []).map((line) => line.replace(/^\[(?:f\d+)?e\d+\]\s*/, "").trim());
	const scroll = typeof input.scrollY === "number" ? Math.floor(input.scrollY / 50) : "";
	return hashString(
		[(input.url ?? "").trim(), String(scroll), lines.join("\n"), input.extra ?? ""].join("\u0001"),
	);
}

export type StallLevel = "none" | "hint" | "strong" | "abort";

export const STALL_HINT_AT = 2;
export const STALL_STRONG_AT = 3;
export const STALL_ABORT_AT = 4;

export function stallLevel(stalled: number): StallLevel {
	if (stalled >= STALL_ABORT_AT) return "abort";
	if (stalled >= STALL_STRONG_AT) return "strong";
	if (stalled >= STALL_HINT_AT) return "hint";
	return "none";
}

/**
 * Conta ações seguidas que deixaram o estado igual ao da última observação
 * do mesmo tipo (snapshot, screenshot, act...). Reler sem agir no meio não
 * conta (isso é problema do detector de repetição da F4); mudança zera.
 */
export function createStallTracker() {
	const last = new Map<string, string>();
	let actionsSince = 0;
	let stalled = 0;
	return {
		/** Ação que não observa o estado (click/type/key/scroll). */
		action() {
			actionsSince += 1;
		},
		/** `isAction`: a própria chamada também agiu (ex.: browser_act). */
		observe(kind: string, state: string, isAction = false): { stalled: number; level: StallLevel } {
			if (isAction) actionsSince += 1;
			const previous = last.get(kind);
			last.set(kind, state);
			if (previous !== undefined) {
				if (previous !== state) stalled = 0;
				else if (actionsSince > 0) stalled += 1;
			}
			actionsSince = 0;
			return { stalled, level: stallLevel(stalled) };
		},
	};
}

/** Contadores por run; persistidos em `usageJson.computer`. */
export type ComputerMetrics = {
	/** Chamadas de tools do computador. */
	calls: number;
	screenshots: number;
	snapshots: number;
	/** Ações por ref (browser_act). */
	refActs: number;
	/** Ações por coordenada/teclado (click, type, key, scroll). */
	coordActs: number;
	failures: number;
	/** Ações em que a verificação achou divergência ou "nada mudou". */
	verifyWarnings: number;
	/** Páginas de bloqueio/captcha detectadas. */
	blocks: number;
	/** Vezes que o estado da página não mudou após agir. */
	stalls: number;
	/** Soma do tempo das tools do computador, em ms. */
	totalMs: number;
};

export function emptyComputerMetrics(): ComputerMetrics {
	return {
		calls: 0,
		screenshots: 0,
		snapshots: 0,
		refActs: 0,
		coordActs: 0,
		failures: 0,
		verifyWarnings: 0,
		blocks: 0,
		stalls: 0,
		totalMs: 0,
	};
}

const COORD_TOOLS = new Set(["click", "type", "key", "scroll"]);

/** Soma uma chamada às métricas (não muta). `tool` é o nome da tool. */
export function recordComputerCall(
	metrics: ComputerMetrics,
	call: { tool: string; ok: boolean; ms: number },
): ComputerMetrics {
	const next = { ...metrics, calls: metrics.calls + 1 };
	next.totalMs += Math.max(0, Math.round(Number.isFinite(call.ms) ? call.ms : 0));
	if (!call.ok) next.failures += 1;
	if (call.tool === "screenshot") next.screenshots += 1;
	else if (call.tool === "browser_snapshot") next.snapshots += 1;
	else if (call.tool === "browser_act") next.refActs += 1;
	else if (COORD_TOOLS.has(call.tool)) next.coordActs += 1;
	return next;
}
