// Agrupa os itens da Biblioteca por período ("Hoje", "Esta semana", depois um por mês) e formata a idade curta.
// Tudo no fuso do aparelho (dia do calendário local) e com `now` injetado: nada lê o relógio aqui.
import type { LibraryItem } from "./library-items";
import { libraryKindLabel } from "./library-items";

export type LibraryGroup = { key: string; label: string; items: LibraryItem[] };

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const DAY_MS = 86_400_000;

/** Dia do calendário local como número (meia-noite UTC do mesmo Y-M-D): a diferença entre dois é em dias inteiros, sem erro de horário de verão. */
const dayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;

/**
 * Grupos na ordem em que aparecem (a lista já vem do mais novo ao mais velho): "Hoje" (inclui data no futuro, que é
 * relógio desencontrado), "Esta semana" (de ontem a 6 dias atrás), depois "Outubro" (com o ano quando não é o corrente).
 * Data inválida cai em "Sem data", no fim.
 */
export function groupLibraryItems(items: readonly LibraryItem[], now: Date): LibraryGroup[] {
	const today = dayNumber(now);
	const groups: LibraryGroup[] = [];
	const undated: LibraryItem[] = [];
	const bucket = (key: string, label: string): LibraryItem[] => {
		let group = groups.find((item) => item.key === key);
		if (!group) groups.push((group = { key, label, items: [] }));
		return group.items;
	};
	for (const item of items) {
		const date = new Date(item.date);
		if (Number.isNaN(date.getTime())) {
			undated.push(item);
			continue;
		}
		const age = today - dayNumber(date);
		if (age <= 0) bucket("today", "Hoje").push(item);
		else if (age < 7) bucket("week", "Esta semana").push(item);
		else {
			const year = date.getFullYear();
			const month = date.getMonth();
			bucket(`${year}-${month}`, year === now.getFullYear() ? MONTHS[month]! : `${MONTHS[month]} de ${year}`).push(item);
		}
	}
	if (undated.length > 0) groups.push({ key: "undated", label: "Sem data", items: undated });
	return groups;
}

/** Idade curta: "agora", "5 min", "2h", "1 d", "3 sem", "2 meses", "1 ano". Data inválida = "" (a linha mostra só o tipo). */
export function formatLibraryAge(iso: string, now: Date): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const minutes = Math.floor((now.getTime() - then) / 60_000);
	if (minutes < 1) return "agora";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days} d`;
	if (days < 30) return `${Math.floor(days / 7)} sem`;
	if (days < 365) {
		const months = Math.floor(days / 30);
		return months === 1 ? "1 mês" : `${months} meses`;
	}
	const years = Math.floor(days / 365);
	return years === 1 ? "1 ano" : `${years} anos`;
}

/** Subtítulo da linha: "Painel · 2h", "Documento · 1 d". */
export function libraryRowSubtitle(item: LibraryItem, now: Date): string {
	const age = formatLibraryAge(item.date, now);
	const label = libraryKindLabel(item.kind);
	return age ? `${label} · ${age}` : label;
}
