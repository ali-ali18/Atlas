// Reordenar seções na home: mesma troca de `order` do web (`template-4-client.tsx`, `moveSection`).
import type { SectionRef } from "./home-types";

export function swapSectionOrder(sections: readonly SectionRef[], id: string, direction: "up" | "down"): SectionRef[] | null {
	const ordered = [...sections].sort((a, b) => a.order - b.order);
	const index = ordered.findIndex((section) => section.id === id);
	const swapIndex = direction === "up" ? index - 1 : index + 1;
	if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) return null;
	const current = ordered[index]!;
	const other = ordered[swapIndex]!;
	return sections.map((section) =>
		section.id === current.id ? { ...section, order: other.order } : section.id === other.id ? { ...section, order: current.order } : section,
	);
}

export function canMoveSection(sections: readonly SectionRef[], id: string, direction: "up" | "down"): boolean {
	return swapSectionOrder(sections, id, direction) !== null;
}

/** Nome válido para salvar; vazio ou só espaços devolve `null`. */
export function normalizeSectionName(name: string): string | null {
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Ao apagar uma seção, os bots voltam para "Sem sessão" (o servidor faz `SetNull`). */
export function snapshotWithoutSection(snapshot: { bots: readonly { sectionId: string | null }[]; sections: SectionRef[] }, sectionId: string) {
	return {
		sections: snapshot.sections.filter((section) => section.id !== sectionId),
		bots: snapshot.bots.map((bot) => (bot.sectionId === sectionId ? { ...bot, sectionId: null } : bot)),
	};
}
