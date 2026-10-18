/**
 * Gatilhos do composer (puro): `/skill` e `@bot`. A detecção, o filtro e a leitura
 * do texto enviado (servidor e chips) usam as mesmas regras.
 */

export type ComposerTrigger = "@" | "/";

/** Máximo de skills forçadas num mesmo turno. */
export const SLASH_SKILL_MAX = 3;

const SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && char !== "" && WORD_CHAR.test(char);
}

function isSpace(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

/**
 * Consulta do gatilho logo antes do cursor, ou null. `/` só abre no começo do texto
 * ou depois de espaço e a consulta é uma palavra só (slug); `@` não abre colado a
 * uma palavra (e-mail) e aceita nomes com espaço.
 */
export function activeTriggerQuery(text: string, caret: number, trigger: ComposerTrigger): { query: string; start: number } | null {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf(trigger);
	if (at < 0) return null;
	const query = before.slice(at + 1);
	if (trigger === "/") {
		if (at > 0 && !isSpace(before[at - 1])) return null;
		if (/\s/.test(query) || query.length > 64) return null;
		return { query, start: at };
	}
	if (at > 0 && isWordChar(before[at - 1])) return null;
	if (query.includes("\n") || query.length > 40) return null;
	return { query, start: at };
}

function foldSimple(value: string): string {
	return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export type SkillCandidateLike = { name: string; description?: string | null };

/** Skills cujo nome (ou palavra do nome, separada por `-`) começa com a consulta. */
export function filterSkillCandidates<T extends SkillCandidateLike>(skills: readonly T[], query: string): T[] {
	const wanted = foldSimple(query.trim().replace(/^\//, ""));
	if (!wanted) return [...skills];
	return skills.filter((skill) => {
		const name = foldSimple(skill.name);
		return name.startsWith(wanted) || name.split("-").some((word) => word.startsWith(wanted));
	});
}

export type SlashSkillToken = { name: string; start: number; end: number };

/**
 * `/skill` escritos no texto: no começo ou depois de espaço, nome em slug minúsculo,
 * sem `/` colado depois (caminho). Ignora blocos de código; sem repetição.
 */
export function parseSlashSkills(text: string): SlashSkillToken[] {
	if (!text.includes("/")) return [];
	const found: SlashSkillToken[] = [];
	const seen = new Set<string>();
	let inFence = false;
	let offset = 0;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
		} else if (!inFence) {
			for (const match of line.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]*)/g)) {
				const name = match[2]!;
				const start = offset + match.index! + match[1]!.length;
				const end = start + 1 + name.length;
				const next = line[end - offset];
				if (next === "/" || next === "." && isWordChar(line[end - offset + 1]) || isWordChar(next)) continue;
				if (!SKILL_SLUG.test(name) || seen.has(name)) continue;
				seen.add(name);
				found.push({ name, start, end });
			}
		}
		offset += line.length + 1;
	}
	return found.slice(0, SLASH_SKILL_MAX);
}
