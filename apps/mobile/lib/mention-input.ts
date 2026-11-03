// Autocompletar do composer (puro): o `@` oferece bots e o `/` habilidades, com as mesmas regras do web
// (`apps/web/lib/mention-input.ts`, via `@workspace/shared`). Escolher o item tira o gatilho do texto: quem fica no
// campo é o marcador (ver `composer-markers.ts`), não o texto cru.
import { activeTriggerQuery, COMPACT_COMMAND, filterMentionCandidates, filterSkillCandidates, type ComposerTrigger } from "@workspace/shared";
import type { Marker } from "./composer-markers";
import type { HomeBot } from "./home-types";

export type BotCandidate = { id: string; name: string; color?: string; shape?: string };
/** `kind: "command"`: comando do composer (`/compact`), que o `/` lista antes das habilidades e que não vira marcador. */
export type SkillCandidate = { id: string; name: string; description?: string | null; kind?: "command" };

/** Comandos do composer que o `/` oferece (como `composerCommandCandidates` do web). */
export function composerCommands(input: { compactAvailable: boolean }): SkillCandidate[] {
	if (!input.compactAvailable) return [];
	return [{ id: `command:${COMPACT_COMMAND}`, name: COMPACT_COMMAND, description: "Compactar a conversa", kind: "command" }];
}

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
	sources: { bots: readonly BotCandidate[]; skills: readonly SkillCandidate[] | null; commands?: readonly SkillCandidate[] },
): TriggerState | null {
	const slash = sources.skills ? activeTriggerQuery(text, caret, "/") : null;
	const at = activeTriggerQuery(text, caret, "@");
	if (slash && sources.skills && (!at || slash.start > at.start)) {
		return { trigger: "/", start: slash.start, query: slash.query, candidates: [...filterSkillCandidates(sources.commands ?? [], slash.query), ...filterSkillCandidates(sources.skills, slash.query)] };
	}
	// "custa @ 5": espaço logo depois do gatilho = a pessoa só escreveu um arroba, não uma menção.
	if (at && !/^\s/.test(at.query)) {
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
	if (before.trim() === "") {
		before = "";
		// O espaço que separava o gatilho do resto não fica de abertura do campo.
		after = after.replace(/^[ \t]/, "");
	}
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

/**
 * O que escolher na lista faz. O marcador (chip) só nasce quando o gatilho está no começo do texto livre; no meio da
 * frase entra `@Nome ` / `/slug ` como texto na posição do cursor (como o `applyMention` do web), e a frase fica como estava.
 * `null`: nada a inserir (habilidade escolhida com o limite batido); o gatilho segue no texto.
 */
export function applyPick(
	text: string,
	caret: number,
	state: TriggerState,
	index: number,
	options: { skillsFull?: boolean } = {},
): { text: string; caret: number; marker: Marker | null; /** Comando escolhido: entra no campo como `/compact ` (não vira marcador) e roda ao enviar. */ command?: "compact" } | null {
	const candidate = state.candidates[index];
	if (!candidate) return null;
	if (state.trigger === "/" && (candidate as SkillCandidate).kind === "command") {
		// O comando entra no campo (no lugar do gatilho), como no web: a pessoa ainda pode escrever o foco e envia.
		const base = removeTrigger(text, caret, state.start);
		const token = `/${COMPACT_COMMAND} `;
		return { text: token + base.text, caret: token.length, marker: null, command: "compact" };
	}
	if (state.trigger === "/" && options.skillsFull) return null;
	const marker: Marker =
		state.trigger === "@"
			? { kind: "bot", id: candidate.id, name: candidate.name.trim(), color: (candidate as BotCandidate).color, shape: (candidate as BotCandidate).shape }
			: { kind: "skill", id: candidate.id, name: candidate.name.trim() };
	if (text.slice(0, state.start).trim() === "") {
		const next = removeTrigger(text, caret, state.start);
		return { ...next, marker };
	}
	const before = text.slice(0, state.start);
	const after = text.slice(caret);
	const inserted = `${state.trigger}${candidate.name.trim()}${after.startsWith(" ") ? "" : " "}`;
	return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length + (after.startsWith(" ") ? 1 : 0), marker: null };
}
