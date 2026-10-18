import { changeSourceFor, type MemoryChange, type MemoryChangeSource } from "@workspace/shared";

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

/** "agora", "há 5 min", "há 3 h", "ontem", "há 4 dias" e, depois de uma semana, "12 de out.". */
export function memoryRelativeDate(iso: string, now: Date = new Date(), timeZone?: string): string {
	const at = new Date(iso).getTime();
	if (!Number.isFinite(at)) return "";
	const diff = Math.max(0, now.getTime() - at);
	if (diff < MINUTE) return "agora";
	if (diff < HOUR) return `há ${Math.floor(diff / MINUTE)} min`;
	if (diff < DAY) return `há ${Math.floor(diff / HOUR)} h`;
	if (diff < 2 * DAY) return "ontem";
	if (diff < 7 * DAY) return `há ${Math.floor(diff / DAY)} dias`;
	return new Date(at).toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone });
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
