import { memoryRelativeDate } from "./memory-tab-helpers";

/** Seções recolhíveis da aba Biblioteca. Cada pessoa lembra, no próprio navegador, quais deixou abertas. */
export type LibrarySectionId = "pages" | "documents" | "routines";

/** Painéis começam abertos (é o que mais se consulta); o resto, fechado. */
export const LIBRARY_SECTION_DEFAULT_OPEN: Record<LibrarySectionId, boolean> = {
	pages: true,
	documents: false,
	routines: false,
};

export function librarySectionKey(id: LibrarySectionId): string {
	return `atlas:library-section:${id}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** `localStorage` pode não existir ou lançar (janela privada, dados bloqueados, prévia): nunca quebra a tela. */
function browserStorage(): StorageLike | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Estado lembrado da seção; sem valor válido (ou sem storage) vale o padrão. */
export function readLibrarySectionOpen(id: LibrarySectionId, storage: StorageLike | null = browserStorage()): boolean {
	try {
		const raw = storage?.getItem(librarySectionKey(id));
		if (raw === "1") return true;
		if (raw === "0") return false;
	} catch {
		// cai no padrão
	}
	return LIBRARY_SECTION_DEFAULT_OPEN[id];
}

export function writeLibrarySectionOpen(id: LibrarySectionId, open: boolean, storage: StorageLike | null = browserStorage()): void {
	try {
		storage?.setItem(librarySectionKey(id), open ? "1" : "0");
	} catch {
		// sem storage: a escolha vale só nesta sessão da tela
	}
}

type PageListFields = {
	id: string;
	title: string;
	sourceCount: number;
	updatedAt: string;
	refreshedAt: string | null;
};

export type PageCardModel = {
	id: string;
	title: string;
	/** "3 fontes"; vazio quando não há fontes. */
	sources: string | null;
	/** "Atualizado há 2 h": a última atualização com dados novos, senão a última edição. */
	updated: string | null;
	/** "Toda segunda às 08:00" quando uma rotina atualiza o painel. */
	routine: string | null;
};

/** "Atualizado há 5 min" (ou "Atualizado agora", "Atualizado ontem"). */
export function updatedAgo(iso: string | null | undefined, now: Date = new Date()): string | null {
	if (!iso) return null;
	const relative = memoryRelativeDate(iso, now);
	return relative ? `Atualizado ${relative}` : null;
}

/** O que o cartão do painel mostra na Biblioteca. Puro: o relógio entra por `now`. */
export function pageCardModel(item: PageListFields, routineSummary: string | null, now: Date = new Date()): PageCardModel {
	const count = item.sourceCount;
	return {
		id: item.id,
		title: item.title,
		sources: count > 0 ? (count === 1 ? "1 fonte" : `${count} fontes`) : null,
		updated: updatedAgo(item.refreshedAt ?? item.updatedAt, now),
		routine: routineSummary,
	};
}
