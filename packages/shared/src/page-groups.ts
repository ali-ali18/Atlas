/**
 * Grupos de painéis: o painel usa o MESMO grupo das rotinas (RoutineGroup), para que "Vendas Loja Exemplo" reúna
 * as rotinas e os painéis do assunto. Funções puras, sem I/O.
 */

/** Resolve o grupo efetivo de cada painel: o explícito (`groupId`) ou, na falta, o da rotina ligada a ele (`Routine.pageId`). */
export function effectivePageGroupIds(
	pages: ReadonlyArray<{ id: string; groupId?: string | null }>,
	routines: ReadonlyArray<{ pageId?: string | null; groupId?: string | null }>,
): Map<string, string | null> {
	const fromRoutine = new Map<string, string>();
	for (const routine of routines) {
		if (routine.pageId && routine.groupId && !fromRoutine.has(routine.pageId)) fromRoutine.set(routine.pageId, routine.groupId);
	}
	const result = new Map<string, string | null>();
	for (const page of pages) result.set(page.id, page.groupId ?? fromRoutine.get(page.id) ?? null);
	return result;
}

export type PageGroupSection<T> = { groupId: string | null; items: T[] };

/**
 * Agrupa os painéis para a Biblioteca: uma seção por grupo (na ordem de `groups`, só as que têm painel) e,
 * por último, os sem grupo (`groupId: null`). Grupo desconhecido (apagado) cai em "sem grupo".
 */
export function groupPagesForDisplay<T extends { groupId?: string | null }>(items: readonly T[], groups: ReadonlyArray<{ id: string }>): Array<PageGroupSection<T>> {
	const known = new Set(groups.map((group) => group.id));
	const sections: Array<PageGroupSection<T>> = [];
	for (const group of groups) {
		const inGroup = items.filter((item) => item.groupId === group.id);
		if (inGroup.length > 0) sections.push({ groupId: group.id, items: inGroup });
	}
	const loose = items.filter((item) => !item.groupId || !known.has(item.groupId));
	if (loose.length > 0) sections.push({ groupId: null, items: loose });
	return sections;
}

/** "1 painel" / "N painéis". */
export function formatPageCount(count: number): string {
	return `${count} ${count === 1 ? "painel" : "painéis"}`;
}
