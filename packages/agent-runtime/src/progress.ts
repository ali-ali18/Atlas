import {
	RUN_ABORT_CONSECUTIVE_FAILURES,
	RUN_ABORT_DISTINCT_TOOLS,
} from "./budget.js";

/** Avaliação estruturada do limite brando. JSON inválido não é extensão. */
export type ProgressEvaluation = {
	concluded: boolean;
	summary: string;
	continueReason: string;
};

export function parseProgressEvaluation(raw: string): ProgressEvaluation | null {
	const match = raw.match(/\{[\s\S]*\}/)?.[0];
	if (!match) return null;
	try {
		const parsed = JSON.parse(match) as Record<string, unknown>;
		if (typeof parsed.concluded !== "boolean") return null;
		const summary =
			typeof parsed.summary === "string" ? parsed.summary.trim() : "";
		const continueReason =
			typeof parsed.continueReason === "string"
				? parsed.continueReason.trim()
				: "";
		if (parsed.concluded && summary.length === 0) return null;
		if (!parsed.concluded && continueReason.length === 0 && summary.length === 0) {
			return null;
		}
		return { concluded: parsed.concluded, summary, continueReason };
	} catch {
		return null;
	}
}

export type ToolOutcome = {
	name: string;
	argsKey: string;
	resultKey: string;
	ok: boolean;
	/** Passo (decisão do modelo) em que rodou; agrupa chamadas paralelas. */
	step?: number;
	/** Só em falhas: erro de argumento não conta para a trava global. */
	kind?: "argument" | "other";
	/** Resultado sintético (tool bloqueada ou teto de chamadas): a tool não rodou, então não é falha dela. */
	synthetic?: boolean;
	/** Leitura que deu certo mas voltou vazia (coleção vazia). */
	empty?: boolean;
};

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function toolArgsKey(
	name: string,
	args: Record<string, unknown>,
): string {
	return `${name}:${stableStringify(args)}`;
}

export function toolResultKey(summary: string, ok: boolean): string {
	const normalized = summary.replace(/\s+/g, " ").trim().slice(0, 400);
	return `${ok ? "ok" : "err"}:${normalized}`;
}

const LOOP_REPEAT_LIMIT = 3;

/**
 * Repetição sem progresso: mesmos args E mesmo resultado na janela.
 * Ler → rolar → ler de novo (args/resultado diferentes) é legítimo.
 */
export type LoopCheckResult = "ok" | "warn" | "abort";

export function isNoProgressLoop(
	outcomes: ToolOutcome[],
	warnedLoops: ReadonlySet<string>,
): { result: LoopCheckResult; reason: string | null; loopKey?: string } {
	if (outcomes.length < LOOP_REPEAT_LIMIT) return { result: "ok", reason: null };
	const last = outcomes.slice(-LOOP_REPEAT_LIMIT);
	const first = last[0];
	if (
		first &&
		last.every(
			(item) =>
				item.name === first.name &&
				item.argsKey === first.argsKey &&
				item.resultKey === first.resultKey,
		)
	) {
		const reason = `Repeated loop detected: ${first.name} keeps returning the same result. Try a different approach.`;
		const loopKey = `repeat|${first.name}|${first.argsKey}`;
		return {
			result: warnedLoops.has(loopKey) ? "abort" : "warn",
			reason,
			loopKey,
		};
	}
	// Ciclo de período 3: A,B,C,A,B,C,A,B,C (3 repetições = 9 elementos para legitimate polling)
	if (outcomes.length >= 9) {
		const window = outcomes.slice(-9);
		const [a, b, c, d, e, f, g, h, i] = window;
		if (
			a &&
			b &&
			c &&
			d &&
			e &&
			f &&
			g &&
			h &&
			i &&
			a.name === d.name &&
			b.name === e.name &&
			c.name === f.name &&
			d.name === g.name &&
			e.name === h.name &&
			f.name === i.name &&
			a.argsKey === d.argsKey &&
			b.argsKey === e.argsKey &&
			c.argsKey === f.argsKey &&
			d.argsKey === g.argsKey &&
			e.argsKey === h.argsKey &&
			f.argsKey === i.argsKey &&
			a.resultKey === d.resultKey &&
			b.resultKey === e.resultKey &&
			c.resultKey === f.resultKey &&
			d.resultKey === g.resultKey &&
			e.resultKey === h.resultKey &&
			f.resultKey === i.resultKey
		) {
			const reason = `Period-3 loop detected: ${a.name}, ${b.name}, ${c.name} repeating without progress. Try a different approach.`;
			// Canonicalize: pick the lexicographically smallest rotation
			const rotation0 = `${a.argsKey}|${b.argsKey}|${c.argsKey}`;
			const rotation1 = `${b.argsKey}|${c.argsKey}|${a.argsKey}`;
			const rotation2 = `${c.argsKey}|${a.argsKey}|${b.argsKey}`;
			const canonical = [rotation0, rotation1, rotation2].sort()[0];
			const loopKey = `cycle3|${canonical}`;
			return {
				result: warnedLoops.has(loopKey) ? "abort" : "warn",
				reason,
				loopKey,
			};
		}
	}
	// Ciclo de período 2: A,B,A,B,A,B (3 repetições = 6 elementos para legitimate polling)
	// Canonicaliza pela menor rotação para independência de posição da janela
	if (outcomes.length >= 6) {
		const window = outcomes.slice(-6);
		const [a, b, c, d, e, f] = window;
		if (
			a &&
			b &&
			c &&
			d &&
			e &&
			f &&
			a.name === c.name &&
			b.name === d.name &&
			c.name === e.name &&
			d.name === f.name &&
			a.argsKey === c.argsKey &&
			b.argsKey === d.argsKey &&
			c.argsKey === e.argsKey &&
			d.argsKey === f.argsKey &&
			a.resultKey === c.resultKey &&
			b.resultKey === d.resultKey &&
			c.resultKey === e.resultKey &&
			d.resultKey === f.resultKey
		) {
			const reason = `Alternating loop detected: ${a.name} and ${b.name} repeating without progress. Try a different approach.`;
			// Canonicalize: pick the lexicographically smallest rotation
			const rotation0 = `${a.argsKey}|${b.argsKey}`;
			const rotation1 = `${b.argsKey}|${a.argsKey}`;
			const canonical = [rotation0, rotation1].sort()[0];
			const loopKey = `alternate|${canonical}`;
			return {
				result: warnedLoops.has(loopKey) ? "abort" : "warn",
				reason,
				loopKey,
			};
		}
	}
	return { result: "ok", reason: null };
}

/**
 * F4 — trava por tool: falhas seguidas da MESMA tool no fim da lista.
 * Qualquer outro resultado no meio (outra tool ou sucesso) zera a sequência.
 */
export function sameToolFailureStreak(
	outcomes: ToolOutcome[],
	name: string,
): number {
	let count = 0;
	for (let i = outcomes.length - 1; i >= 0; i -= 1) {
		const item = outcomes[i];
		if (!item || item.name !== name || item.ok) break;
		count += 1;
	}
	return count;
}

/**
 * F4 — o run só aborta por falhas quando há N falhas seguidas envolvendo
 * M+ tools distintas. Falha isolada de tool opcional nunca mata o run.
 * Retorna o diagnóstico ou null.
 */
export function abortForConsecutiveFailures(
	outcomes: ToolOutcome[],
	consecutive: number = RUN_ABORT_CONSECUTIVE_FAILURES,
	distinct: number = RUN_ABORT_DISTINCT_TOOLS,
): string | null {
	if (outcomes.length < consecutive) return null;
	const tail = outcomes.slice(-consecutive);
	if (tail.some((item) => !item || item.ok)) return null;
	const tools = new Set(tail.map((item) => (item as ToolOutcome).name));
	if (tools.size < distinct) return null;
	const last = tail[tail.length - 1] as ToolOutcome;
	return (
		`${consecutive} ferramentas falharam em sequência ` +
		`(${[...tools].slice(0, 3).join(", ")} — última: ${last.name}).`
	);
}

export type RepeatCheck = "ok" | "warn" | "abort";

/**
 * F4 — repetição com aviso: os 2 últimos resultados têm mesmos args E mesmo
 * resultado do próximo passo? Primeira vez avisa ("warn"), repetindo de novo
 * aborta ("abort"). Erro de sandbox com recuperação no meio nunca chega aqui
 * com a mesma chave (o push diferencia a chave após recuperação).
 */
export function checkRepeat(
	outcomes: ToolOutcome[],
	argsKey: string,
	resultKey: string,
	warnedKeys: ReadonlySet<string>,
): RepeatCheck {
	const lastTwo = outcomes.slice(-2);
	if (lastTwo.length < 2) return "ok";
	const [a, b] = lastTwo;
	if (!a || !b) return "ok";
	if (a.argsKey !== argsKey || b.argsKey !== argsKey) return "ok";
	if (a.resultKey !== resultKey || b.resultKey !== resultKey) return "ok";
	return warnedKeys.has(`${argsKey}|${resultKey}`) ? "abort" : "warn";
}

/**
 * Evidência da tarefa vinda do ExecutionLedger (L6): com ela, "ganho" exige
 * ids ou conteúdo novos desde o passo da primeira chamada da janela, não só
 * um resultado ok qualquer.
 */
export type ProgressEvidence = { noveltySince(step: number): number };

export function hasVerifiableProgress(
	outcomes: ToolOutcome[],
	sinceIndex: number,
	evidence?: ProgressEvidence,
): boolean {
	const slice = outcomes.slice(Math.max(0, sinceIndex));
	if (slice.length === 0) return false;
	if (evidence && evidence.noveltySince(slice[0]?.step ?? 0) <= 0) return false;
	const seen = new Set<string>();
	for (const item of slice) {
		if (!item.ok) continue;
		const fingerprint = `${item.argsKey}|${item.resultKey}`;
		if (!seen.has(fingerprint)) {
			seen.add(fingerprint);
			if (seen.size >= 1 && item.resultKey !== "ok:") {
				return true;
			}
		}
	}
	return seen.size > 0;
}

export function hasSuccessfulToolEvidence(outcomes: ToolOutcome[]): boolean {
	return outcomes.some((item) => item.ok && item.resultKey.length > 3);
}
