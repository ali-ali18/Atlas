// Achar UMA rotina ou UM grupo pelo que o modelo escreveu (id ou nome). Puro: recebe a lista do dono (já escopada) e devolve
// o único que casa, ou diz que não achou / que são vários. Nada de chute: ambíguo volta a lista para o dono escolher.
import type { RoutineGroupView, RoutineView } from "../../ports/routines.js";

export type Found<T> = { kind: "one"; item: T } | { kind: "none" } | { kind: "ambiguous"; items: T[] };

function find<T extends { id: string; name: string }>(items: readonly T[], query: string): Found<T> {
	const wanted = query.trim().toLowerCase();
	if (wanted.length === 0) return { kind: "none" };
	const byId = items.find((item) => item.id === query.trim());
	if (byId) return { kind: "one", item: byId };
	const same = (list: T[]): Found<T> => (list.length === 1 ? { kind: "one", item: list[0]! } : { kind: "ambiguous", items: list });
	const exact = items.filter((item) => item.name.trim().toLowerCase() === wanted);
	if (exact.length > 0) return same(exact);
	const partial = items.filter((item) => item.name.toLowerCase().includes(wanted));
	if (partial.length > 0) return same(partial);
	return { kind: "none" };
}

export const findRoutine = (routines: readonly RoutineView[], query: string): Found<RoutineView> => find(routines, query);
export const findGroup = (groups: readonly RoutineGroupView[], query: string): Found<RoutineGroupView> => find(groups, query);

/** O que o modelo escreveu é o id ou o nome COMPLETO (sem diferença de caixa), não um pedaço? Apagar só aceita isto. */
export function isExactRef(item: { id: string; name: string }, query: string): boolean {
	const wanted = query.trim();
	return item.id === wanted || item.name.trim().toLowerCase() === wanted.toLowerCase();
}

const MAX_OPTIONS = 5;

/** Lista curta (até 5) de opções, só nome e id, para o erro "qual delas?". */
export function optionsLine(items: readonly { id: string; name: string }[]): string {
	return items.slice(0, MAX_OPTIONS).map((item) => `"${item.name}" (id ${item.id})`).join("; ");
}
