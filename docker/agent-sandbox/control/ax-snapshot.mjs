// Motor v2 — captura da árvore de acessibilidade com refs (a mesma que o
// Playwright MCP e o browser-use leem). Só captura: poda, refs e diff moram em
// `ax-prune.mjs`, `ax-refs.mjs` e `ax-diff.mjs`.
//
// Ordem de preferência: `page.ariaSnapshot({ mode: "ai", boxes: true })`
// (Playwright >= 1.63); `page._snapshotForAI()` (1.56+, sem boxes); senão o
// chamador cai no snapshot v1 do DOM. Detecção por recurso, nunca por versão.

export const AX_TIMEOUT_MS = 4000;

export class AxUnavailableError extends Error {
	constructor(message, reason) {
		super(message);
		this.name = "AxUnavailableError";
		this.reason = reason; // "unsupported" | "timeout" | "failed"
	}
}

/** `ATLAS_AX_SNAPSHOT`: ligado por padrão; `off`, `0`, `false` ou `dom` voltam ao snapshot v1. */
export function axEnabled(env = process.env) {
	const flag = String(env.ATLAS_AX_SNAPSHOT ?? "on").trim().toLowerCase();
	return !["off", "0", "false", "dom", "no"].includes(flag);
}

function withTimeout(promise, ms) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new AxUnavailableError(`árvore de acessibilidade passou de ${ms} ms`, "timeout")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Erro de opção desconhecida (Playwright antigo) em vez de falha da página. */
function isUnsupportedOption(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /mode|boxes|unknown|invalid|unexpected|not a function|expected/i.test(message) && !/timeout|closed|detached|crash/i.test(message);
}

/**
 * Devolve `{ yaml, via, boxes }`. Lança `AxUnavailableError` (reason
 * unsupported/timeout/failed) para o chamador cair no snapshot v1.
 */
export async function takeAxSnapshot(page, { timeoutMs = AX_TIMEOUT_MS } = {}) {
	if (page && typeof page.ariaSnapshot === "function") {
		try {
			const yaml = await withTimeout(page.ariaSnapshot({ mode: "ai", boxes: true, timeout: timeoutMs }), timeoutMs);
			if (typeof yaml === "string") return { yaml, via: "ai", boxes: true };
		} catch (error) {
			if (error instanceof AxUnavailableError) throw error;
			if (!isUnsupportedOption(error)) throw new AxUnavailableError(compact(error), "failed");
		}
	}
	if (page && typeof page._snapshotForAI === "function") {
		try {
			const result = await withTimeout(page._snapshotForAI({ timeout: timeoutMs }), timeoutMs);
			const yaml = typeof result === "string" ? result : result?.full;
			if (typeof yaml === "string") return { yaml, via: "forAI", boxes: false };
		} catch (error) {
			if (error instanceof AxUnavailableError) throw error;
			throw new AxUnavailableError(compact(error), "failed");
		}
	}
	throw new AxUnavailableError("este Playwright não expõe a árvore de acessibilidade para IA", "unsupported");
}

function compact(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n")[0].slice(0, 200);
}
