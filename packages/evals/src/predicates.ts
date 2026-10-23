import type { ArgPredicate, ArgPredicates } from "./scenario.js";

/** Valor num caminho com pontos (`items.0.sku`); `undefined` se não existir. */
export function valueAt(source: unknown, path: string): unknown {
	let current: unknown = source;
	for (const key of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Motivo da falha do predicado, ou `null` quando bate. */
export function predicateProblem(value: unknown, predicate: ArgPredicate, path: string): string | null {
	if (predicate.exists !== undefined && (value !== undefined) !== predicate.exists) return `${path} ${predicate.exists ? "ausente" : "presente"}`;
	if (predicate.equals !== undefined && !sameValue(value, predicate.equals)) return `${path}=${JSON.stringify(value)} (esperado ${JSON.stringify(predicate.equals)})`;
	if (predicate.oneOf !== undefined && !predicate.oneOf.some((option) => sameValue(value, option))) return `${path}=${JSON.stringify(value)} fora de ${JSON.stringify(predicate.oneOf)}`;
	const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
	if (predicate.contains !== undefined && !text.toLowerCase().includes(predicate.contains.toLowerCase())) return `${path} sem "${predicate.contains}"`;
	if (predicate.matches !== undefined && !new RegExp(predicate.matches, "i").test(text)) return `${path} não casa /${predicate.matches}/`;
	return null;
}

/** Primeiro problema entre os predicados (todos precisam bater), ou `null`. */
export function argsProblem(args: unknown, predicates: ArgPredicates | undefined): string | null {
	for (const [path, predicate] of Object.entries(predicates ?? {})) {
		const problem = predicateProblem(valueAt(args, path), predicate, path);
		if (problem) return problem;
	}
	return null;
}

export const argsMatch = (args: unknown, predicates: ArgPredicates | undefined): boolean => argsProblem(args, predicates) === null;
