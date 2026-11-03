// Autocompletar do composer (puro): o `@` oferece bots e o `/` habilidades, com as mesmas regras do web
// (`apps/web/lib/mention-input.ts`, via `@workspace/shared`). Escolher o item tira o gatilho do texto: quem fica no
// campo é o marcador (ver `composer-markers.ts`), não o texto cru.
import { activeTriggerQuery, filterMentionCandidates, filterSkillCandidates, type ComposerTrigger } from "@workspace/shared";
import type { HomeBot } from "./home-types";

export type BotCandidate = { id: string; name: string; color?: string; shape?: string };
export type SkillCandidate = { id: string; name: string; description?: string | null };

export type TriggerState =
	| { trigger: "@"; start: number; query: string; candidates: BotCandidate[] }
	| { trigger: "/"; start: number; query: string; candidates: SkillCandidate[] };

/**
 * Qual lista abrir para o texto e o cursor. Vale o gatilho mais perto do cursor. `/` pode abrir vazio (o estado
 * "carregando" ou "nenhuma habilidade"); `@` já com espaço na consulta e sem resultado fecha: a pessoa passou da menção.
 * Sem habilidades (`skills` null, ex.: grupo) o `/` não abre.
 */
export function triggerState(
	text: string,
	caret: number,
	sources: { bots: readonly BotCandidate[]; skills: readonly SkillCandidate[] | null },
): TriggerState | null {
	const slash = sources.skills ? activeTriggerQuery(text, caret, "/") : null;
	const at = activeTriggerQuery(text, caret, "@");
	if (slash && sources.skills && (!at || slash.start > at.start)) {
		return { trigger: "/", start: slash.start, query: slash.query, candidates: filterSkillCandidates(sources.skills, slash.query) };
	}
	if (at) {
		const candidates = filterMentionCandidates(sources.bots, at.query);
		if (candidates.length === 0 && /\s/.test(at.query.trim())) return null;
		// Sem nenhum bot a oferecer e sem consulta, o "@" é só um arroba: não abre uma caixa vazia.
		if (candidates.length === 0 && sources.bots.length === 0) return null;
		return { trigger: "@", start: at.start, query: at.query, candidates };
	}
	return null;
}

/**
 * Tira o gatilho (`@consulta` ou `/consulta`, de `start` até o cursor) do texto e devolve o texto e onde o cursor fica.
 * Sobra um espaço só quando os dois lados tinham um.
 */
export function removeTrigger(text: string, caret: number, start: number): { text: string; caret: number } {
	let before = text.slice(0, start);
	let after = text.slice(caret);
	if (/\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^[ \t]/, "");
	// O gatilho era a única coisa na linha de cima: não deixa o espaço de antes grudado no começo do campo.
	if (before.trim() === "") before = "";
	return { text: before + after, caret: before.length };
}

/** Os bots que o `@` oferece: no 1:1, os outros bots (sem grupos nem o atual); num grupo, os membros dele. */
export function mentionableBots(bots: readonly HomeBot[], current: HomeBot | undefined): BotCandidate[] {
	if (!current) return [];
	const isGroup = current.memberIds.length > 0;
	const pick = isGroup ? bots.filter((bot) => current.memberIds.includes(bot.id)) : bots.filter((bot) => bot.id !== current.id && bot.memberIds.length === 0);
	return pick.map((bot) => ({ id: bot.id, name: bot.name, color: bot.color, shape: bot.shape }));
}

export type { ComposerTrigger };
