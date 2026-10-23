import { visibleMentionApps } from "./mention-apps";
import {
	activeMentionQuery,
	activeTriggerQuery,
	filterMentionCandidates,
	filterSkillCandidates,
	foldText,
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

/**
 * A consulta de `@` aceita espaço (nomes como "Bot Financeiro"), então depois de escolher
 * "@Cookie " ela seguia "ativa" enquanto a pessoa digitava ("Cookie asd"). A menção está
 * completa quando a consulta começa por um nome conhecido seguido de espaço.
 */
export function isCompletedMention(query: string, names: readonly string[]): boolean {
	const folded = foldText(query);
	// "Ana " ainda pode virar "Ana Maria": se outro nome continua a consulta, segue digitando.
	if (names.some((name) => foldText(name.trim()).startsWith(folded) && foldText(name.trim()) !== foldText(query.trimEnd()))) return false;
	return names.some((name) => {
		const wanted = foldText(name.trim());
		return wanted.length > 0 && folded.startsWith(wanted) && /^\s/.test(folded.slice(wanted.length));
	});
}

export function mentionState<T extends GroupMember>(value: string, caret: number, members: readonly T[]): MentionState<T> | null {
	const active = activeMentionQuery(value, caret);
	if (!active) return null;
	if (isCompletedMention(active.query, members.map((member) => member.name))) return null;
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
	if (at && !isCompletedMention(at.query, [...sources.bots, ...(sources.apps ?? [])].map((item) => item.name))) {
		// Bots primeiro; apps depois (conectados sem consulta, qualquer um que case com ela). Nome de bot vence o de app.
		const bots = filterMentionCandidates(sources.bots, at.query);
		const apps = visibleMentionApps(sources.apps ?? [], at.query, sources.bots.map((bot) => bot.name));
		const candidates = [...bots, ...apps];
		// Já com espaço na consulta e sem nenhum resultado, a pessoa passou da menção: fecha em vez de mostrar o vazio.
		if (candidates.length === 0 && /\s/.test(at.query.trim())) return null;
		return { trigger: "@", start: at.start, query: at.query, candidates };
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
