/**
 * Regex de regra de alerta com orçamento de tempo. O padrão vem do modelo e o texto de um site de terceiros:
 * a checagem estática (`unsafeRegexReason`) não pega toda explosão polinomial (`\d*\d*\d*x`), então a execução
 * roda numa worker_thread que é encerrada se passar do orçamento. O motor da thread principal nunca roda o padrão.
 */
import { Worker } from "node:worker_threads";

export const REGEX_BUDGET_MS = 100;
/** Texto maior que isso não entra no regex de página inteira (ver `regexWindow`). */
export const REGEX_WINDOW_BYTES = 64 * 1024;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const match = new RegExp(workerData.pattern, "i").exec(workerData.text);
  parentPort.postMessage({ ok: true, value: match ? (match[1] ?? match[0]) : null });
} catch {
  parentPort.postMessage({ ok: false });
}
`;

export type RegexRun = { status: "match"; value: string } | { status: "none" } | { status: "timeout" } | { status: "error" };

export function runRegexWithBudget(text: string, pattern: string, budgetMs = REGEX_BUDGET_MS): Promise<RegexRun> {
	return new Promise((resolve) => {
		let settled = false;
		const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { text, pattern }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
		const finish = (result: RegexRun) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			resolve(result);
		};
		const timer = setTimeout(() => finish({ status: "timeout" }), budgetMs);
		worker.once("message", (message: { ok: boolean; value?: string | null }) => {
			if (!message.ok) return finish({ status: "error" });
			const value = typeof message.value === "string" ? message.value.trim() : "";
			finish(value ? { status: "match", value } : { status: "none" });
		});
		worker.once("error", () => finish({ status: "error" }));
		worker.once("exit", () => finish({ status: "error" }));
	});
}

/**
 * Janela de texto onde o regex roda: o corpo todo só se couber em 64 KB; senão o texto visível (sem script, estilo
 * nem tags) cortado em 64 KB. Menos texto = menos custo e menos chance de casar o número errado.
 */
export function regexWindow(body: string): string {
	if (body.length <= REGEX_WINDOW_BYTES) return body;
	const visible = body
		.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ");
	return visible.slice(0, REGEX_WINDOW_BYTES);
}
