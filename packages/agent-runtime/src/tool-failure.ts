import {
	RUN_ABORT_CONSECUTIVE_FAILURES,
	RUN_ABORT_DISTINCT_TOOLS,
} from "./budget.js";
import type { ToolOutcome } from "./progress.js";

/**
 * F4 (caso loja-exemplo) — classificação de falhas de tool.
 * "argument": o modelo errou o caminho/id/parâmetro ("chute"); não é quebra
 * da tool, então não conta para a trava global do run (só para a por tool).
 */
export type ToolFailureKind = "argument" | "other";

const ARGUMENT_ERROR_PATTERNS: RegExp[] = [
	/\b404\b/,
	/path does not point/i,
	/validation failed/i,
	/invalid_args/i,
	/argumentos inválidos/i,
	/\bnot found\b/i,
];

export function classifyToolFailure(summary: string): ToolFailureKind {
	return ARGUMENT_ERROR_PATTERNS.some((pattern) => pattern.test(summary))
		? "argument"
		: "other";
}

/** Dica acionável para o modelo (texto de modelo: inglês). */
export const ARGUMENT_ERROR_HINT =
	"Invalid argument: check the path/id/parameters. List or search first " +
	"(e.g. list the parent folder, or use the list/search tool of the same " +
	"connector) before retrying, and do not guess values.";

export function withArgumentErrorHint(summary: string): string {
	return summary.includes(ARGUMENT_ERROR_HINT)
		? summary
		: `${summary}\n\n${ARGUMENT_ERROR_HINT}`;
}

/**
 * Agrupa por passo (decisão do modelo). Sem `step`, cada outcome é um grupo
 * próprio (checkpoint antigo / seed).
 */
function groupByStep(outcomes: ToolOutcome[]): ToolOutcome[][] {
	const groups: ToolOutcome[][] = [];
	let lastStep: number | undefined;
	for (const outcome of outcomes) {
		const current = groups[groups.length - 1];
		if (current && outcome.step !== undefined && outcome.step === lastStep) {
			current.push(outcome);
		} else {
			groups.push([outcome]);
		}
		lastStep = outcome.step;
	}
	return groups;
}

/**
 * Trava por tool: falhas seguidas da MESMA tool, com várias falhas no mesmo
 * passo (chamadas paralelas) contando como 1. Qualquer sucesso ou outra tool
 * no meio zera a sequência.
 */
export function perToolFailureStreak(
	outcomes: ToolOutcome[],
	name: string,
): number {
	let count = 0;
	for (const group of groupByStep(outcomes).reverse()) {
		const relevant = group.filter((item) => item.name === name);
		if (relevant.length === 0 || relevant.some((item) => item.ok)) break;
		count += 1;
	}
	return count;
}

/**
 * Trava global: N passos seguidos falhando, envolvendo M+ tools distintas.
 * Um passo conta 1 (mesmo com várias chamadas paralelas falhando). Passo só
 * com erro de argumento é neutro (não conta e não zera). Sucesso zera.
 */
export function globalFailureAbort(
	outcomes: ToolOutcome[],
	consecutive: number = RUN_ABORT_CONSECUTIVE_FAILURES,
	distinct: number = RUN_ABORT_DISTINCT_TOOLS,
): string | null {
	const failing: Set<string>[] = [];
	const groups = groupByStep(outcomes);
	for (let i = groups.length - 1; i >= 0 && failing.length < consecutive; i -= 1) {
		const group = groups[i] as ToolOutcome[];
		if (group.some((item) => item.ok)) break;
		const counted = group.filter((item) => item.kind !== "argument");
		if (counted.length === 0) continue;
		failing.push(new Set(counted.map((item) => item.name)));
	}
	if (failing.length < consecutive) return null;
	const tools = new Set(failing.flatMap((names) => [...names]));
	if (tools.size < distinct) return null;
	const lastGroup = [...groups]
		.reverse()
		.find((group) => group.some((item) => item.kind !== "argument"));
	const last = lastGroup?.filter((item) => item.kind !== "argument").pop();
	return (
		`${consecutive} ferramentas falharam em sequência ` +
		`(${[...tools].slice(0, 3).join(", ")} — última: ${last?.name ?? "?"}).`
	);
}
