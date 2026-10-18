import { visibleMentionApps } from "./mention-apps";
import {
	activeMentionQuery,
	activeTriggerQuery,
	filterMentionCandidates,
	filterSkillCandidates,
	type ComposerTrigger,
	type GroupMember,
} from "@workspace/shared";

/**
 * Autocompletar do composer (puro): `@` (membros do grupo ou outros bots) e `/`
 * (skills). Lista de candidatos, navegação por teclado e inserção do token.
 */

export type MentionState<T extends GroupMember> = {
	/** Onde o `@` começa no texto. */
	start: number;
	query: string;
	candidates: T[];
};

export function mentionState<T extends GroupMember>(value: string, caret: number, members: readonly T[]): MentionState<T> | null {
	const active = activeMentionQuery(value, caret);
	if (!active) return null;
	const candidates = filterMentionCandidates(members, active.query);
	if (candidates.length === 0) return null;
	return { start: active.start, query: active.query, candidates };
}

export type TriggerState<T> = {
	trigger: ComposerTrigger;
	/** Onde o gatilho (`@` ou `/`) começa no texto. */
	start: number;
	query: string;
	/** Pode vir vazio: a lista mostra o estado "nenhum resultado". */
	candidates: T[];
};

/**
 * Chat 1:1: `/` oferece skills e `@` oferece os outros bots. Diferente do grupo,
 * sem resultado o popup segue aberto com o estado vazio. Vale o gatilho mais perto do cursor.
 */
export function triggerState<T extends { id: string; name: string; description?: string | null; connected?: boolean }>(
	value: string,
	caret: number,
	sources: { skills: readonly T[]; bots: readonly T[]; apps?: readonly T[] },
): TriggerState<T> | null {
	const slash = activeTriggerQuery(value, caret, "/");
	const at = activeTriggerQuery(value, caret, "@");
	if (slash && (!at || slash.start > at.start)) {
		return { trigger: "/", start: slash.start, query: slash.query, candidates: filterSkillCandidates(sources.skills, slash.query) };
	}
	if (at) {
		// Bots primeiro; apps depois (conectados sem consulta, qualquer um que case com ela). Nome de bot vence o de app.
		const bots = filterMentionCandidates(sources.bots, at.query);
		const apps = visibleMentionApps(sources.apps ?? [], at.query, sources.bots.map((bot) => bot.name));
		return { trigger: "@", start: at.start, query: at.query, candidates: [...bots, ...apps] };
	}
	return null;
}

/** Troca `@consulta` (ou `/consulta`) por `@Nome ` (ou `/nome `) e devolve o texto e a nova posição do cursor. */
export function applyMention(
	value: string,
	caret: number,
	start: number,
	name: string,
	trigger: ComposerTrigger = "@",
): { value: string; caret: number } {
	const before = value.slice(0, start);
	const after = value.slice(caret);
	const spaced = after.startsWith(" ");
	const inserted = `${trigger}${name.trim()}${spaced ? "" : " "}`;
	return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length + (spaced ? 1 : 0) };
}

/** Move o item destacado com ↑/↓, dando a volta nas pontas. */
export function stepMentionIndex(index: number, delta: 1 | -1, length: number): number {
	if (length <= 0) return 0;
	return (index + delta + length) % length;
}
