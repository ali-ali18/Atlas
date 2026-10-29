import { changeSourceFor, type MemoryChange, type MemoryChangeSource } from "@workspace/shared";

import { formatDate } from "@/lib/format";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";

/** Origem de uma memória, pelo `source` gravado nela: "Da conversa", "Revisão da conversa", "Reflexão diária" ou "Você adicionou". */
export function memoryOriginLabel(source: string | null | undefined): string {
	const kind = changeSourceFor(source);
	if (kind === "reflection") return "Reflexão diária";
	if (kind === "review") return "Revisão da conversa";
	if (kind === "user") return "Você adicionou";
	return "Da conversa";
}

/** Quem fez uma mudança do histórico ("O que mudou"). */
export function memoryChangeOriginLabel(source: MemoryChangeSource): string {
	if (source === "reflection") return "Reflexão diária";
	if (source === "review") return "Revisão da conversa";
	if (source === "user") return "Você";
	return "Da conversa";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "agora", "há 5 min", "há 3 h", "ontem", "há 4 dias" e, depois de uma semana, "12 de out." (pt-BR).
 * Os outros idiomas usam as palavras do próprio `Intl` ("5 min. ago", "yesterday", "hace 3 h").
 */
export function memoryRelativeDate(iso: string, now: Date = new Date(), timeZone?: string, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	const at = new Date(iso).getTime();
	if (!Number.isFinite(at)) return "";
	const diff = Math.max(0, now.getTime() - at);
	// "auto" dá "ontem"/"agora"; de 2 dias em diante "always", senão vira "anteontem".
	const text = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
		new Intl.RelativeTimeFormat(locale, { numeric: value >= 2 ? "always" : "auto", style: "short" })
			.format(-value, unit)
			// O Intl do pt-BR põe ponto em "há 5 min."; a tela sempre mostrou sem.
			.replace(/\.$/, "");
	if (diff < MINUTE) return text(0, "second");
	if (diff < HOUR) return text(Math.floor(diff / MINUTE), "minute");
	if (diff < DAY) return text(Math.floor(diff / HOUR), "hour");
	if (diff < 7 * DAY) return text(Math.floor(diff / DAY), "day");
	return formatDate(at, locale, { day: "numeric", month: "short", timeZone });
}

/** "Corrigir no chat": rascunho para o campo de mensagem; termina em " — " para a pessoa continuar a frase. */
export function memoryFixDraft(text: string): string {
	return `Sobre o que você lembra: "${text.trim()}" — `;
}

export type MemoryUndoState = "available" | "undone" | "not-undoable";

/** Um "desfazer" não se desfaz; o que já foi desfeito só mostra o estado; o resto oferece "Desfazer". */
export function memoryUndoState(change: Pick<MemoryChange, "undoneAt" | "undoOfId">): MemoryUndoState {
	if (change.undoOfId) return "not-undoable";
	if (change.undoneAt) return "undone";
	return "available";
}

/**
 * Verbo curto da mudança ("Adicionou", "Alterou", "Apagou"). Um desfazer é gravado como a mudança inversa;
 * aqui ele é nomeado pelo que foi desfeito: "Desfeito · Adicionou".
 */
export function memoryChangeVerb(change: Pick<MemoryChange, "action" | "undoOfId">): string {
	if (!change.undoOfId) return change.action === "add" ? "Adicionou" : change.action === "replace" ? "Alterou" : "Apagou";
	const undone = change.action === "remove" ? "Adicionou" : change.action === "add" ? "Apagou" : "Alterou";
	return `Desfeito · ${undone}`;
}

/** Onde a mudança aconteceu: o perfil compartilhado ou a memória do bot. */
export function memoryChangeScope(change: Pick<MemoryChange, "target">): string {
	return change.target === "user" ? "Sobre você" : "Deste bot";
}
