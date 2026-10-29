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

/**
 * Tools que leem página da web: um 404/"not found" ali é do site (link morto), não do modelo
 * ter chutado um id. A dica "não chute valores" não se aplica e só confunde.
 */
export function isWebPageTool(name: string): boolean {
	return name.startsWith("web_") || name.startsWith("mcp__firecrawl__");
}

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
 * no meio zera a sequência. Só falha do tipo `other` conta: erro de argumento
 * (link morto, id errado) e resultado sintético são neutros (nem contam nem
 * zeram). `sinceStep` ignora passos anteriores (bloqueio que acabou de expirar
 * começa a contar do zero).
 */
export function perToolFailureStreak(
	outcomes: ToolOutcome[],
	name: string,
	sinceStep?: number,
): number {
	let count = 0;
	for (const group of groupByStep(outcomes).reverse()) {
		if (sinceStep !== undefined && group[0]?.step !== undefined && group[0].step < sinceStep) break;
		const relevant = group.filter((item) => item.name === name);
		if (relevant.length === 0 || relevant.some((item) => item.ok)) break;
		if (relevant.every((item) => item.synthetic || item.kind === "argument")) continue;
		count += 1;
	}
	return count;
}

/**
 * Tools de código em que errar é o ciclo normal do trabalho (o `old` não casa, o caminho estava errado): a trava por
 * tool não as bloqueia e a trava global não conta a falha delas. Bloquear `edit_file` depois de 3 misses matava o
 * run de código inteiro; o que o modelo precisa é de uma saída (ver `editEscalationHint`), não de ficar sem a tool.
 */
const BLOCK_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file", "read_file"]);
/** Só estas não entram na trava global: leitura que falha continua contando (caminho errado em 3 tools é chute). */
const GLOBAL_LOCK_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file"]);

export function isBlockExemptTool(name: string): boolean {
	return BLOCK_EXEMPT_TOOLS.has(name);
}

/** Falhas seguidas no mesmo arquivo a partir das quais o erro de edição ganha a dica de escalada. */
export const EDIT_ESCALATION_AFTER = 3;

/** Dica acionável (texto de modelo: inglês) anexada ao erro de `edit_file`/`write_file` na 3ª falha seguida no mesmo arquivo. */
export const EDIT_ESCALATION_HINT =
	"{n} consecutive failures on this file. Stop varying `old` by small tweaks: re-read the region with read_file, " +
	"use a longer unique anchor copied exactly from that output, or rewrite the whole file with write_file.";

/** Conta falhas seguidas de escrita por arquivo; qualquer sucesso no arquivo zera a contagem dele. */
export function createEditFailureTracker() {
	const streaks = new Map<string, number>();
	return {
		/** Registra o resultado e devolve a dica de escalada (ou `null`) quando for o caso. */
		record(name: string, path: unknown, ok: boolean): string | null {
			if (!GLOBAL_LOCK_EXEMPT_TOOLS.has(name) || typeof path !== "string" || !path) return null;
			if (ok) {
				streaks.delete(path);
				return null;
			}
			const count = (streaks.get(path) ?? 0) + 1;
			streaks.set(path, count);
			return count >= EDIT_ESCALATION_AFTER ? EDIT_ESCALATION_HINT.replace("{n}", String(count)) : null;
		},
	};
}

const isCountedFailure = (item: ToolOutcome) => item.kind !== "argument" && !item.synthetic && !GLOBAL_LOCK_EXEMPT_TOOLS.has(item.name);

/**
 * Trava global: N passos seguidos falhando, envolvendo M+ tools distintas.
 * Um passo conta 1 (mesmo com várias chamadas paralelas falhando). Passo só
 * com erro de argumento ou só com resultado sintético (tool bloqueada, teto) é
 * neutro (não conta e não zera). Sucesso zera.
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
		const counted = group.filter(isCountedFailure);
		if (counted.length === 0) continue;
		failing.push(new Set(counted.map((item) => item.name)));
	}
	if (failing.length < consecutive) return null;
	const tools = new Set(failing.flatMap((names) => [...names]));
	if (tools.size < distinct) return null;
	const lastGroup = [...groups]
		.reverse()
		.find((group) => group.some(isCountedFailure));
	const last = lastGroup?.filter(isCountedFailure).pop();
	return (
		`${consecutive} ferramentas falharam em sequência ` +
		`(${[...tools].slice(0, 3).join(", ")} — última: ${last?.name ?? "?"}).`
	);
}
