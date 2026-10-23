import type { ScenarioLanguage } from "./scenario.js";

/** Heurísticas de texto das verificações (funções puras). */

/** Remove blocos cercados (```chart …```, código): o conteúdo técnico deles não é fala ao usuário. */
export function stripFences(text: string): string {
	return text.replace(/```[\s\S]*?(```|$)/g, " ");
}

/** Termina numa pergunta ao usuário (última linha não vazia com "?"). */
export function endsWithQuestion(text: string): boolean {
	const lines = stripFences(text).trim().split("\n").filter((line) => line.trim());
	return /\?\s*[*_)"'»]*\s*$/.test(lines.at(-1) ?? "");
}

export function countQuestions(text: string): number {
	return (stripFences(text).match(/\?/g) ?? []).length;
}

const PROMISE = /^(vou|irei|deixa eu|deixe-me|já já|um momento|aguarde|i'll|i will|let me|one moment|voy a|déjame)\b/i;
const PROMISE_END = /\b(vou (gerar|criar|fazer|montar|enviar|preparar)|já (te )?envio|i'll (now )?(generate|create|send|prepare))\b[^.?!]*[.…]?\s*$/i;

/** Resposta final que só promete ("vou gerar agora") em vez de entregar. */
export function isUnfulfilledPromise(text: string): boolean {
	const clean = stripFences(text).trim();
	if (!clean) return false;
	return PROMISE.test(clean) || PROMISE_END.test(clean);
}

const STOPWORDS: Record<ScenarioLanguage, string[]> = {
	"pt-BR": ["você", "não", "para", "com", "uma", "que", "está", "são", "também", "isso", "seu", "sua", "mais", "pelo", "pela", "dos", "das", "em", "o", "os", "do", "da", "é"],
	"en-US": ["the", "and", "you", "your", "is", "are", "with", "for", "this", "that", "to", "of", "it", "in", "on", "be", "can", "will", "a", "an"],
	"es-ES": ["usted", "tú", "para", "con", "una", "que", "está", "son", "también", "esto", "su", "más", "los", "las", "del", "el", "es", "y", "en", "la"],
};

/** Idioma mais provável pela contagem de palavras funcionais; `null` se o texto for curto demais para decidir. */
export function detectLanguage(text: string): ScenarioLanguage | null {
	const words = stripFences(text).toLowerCase().match(/[\p{L}']+/gu) ?? [];
	if (words.length < 4) return null;
	let best: ScenarioLanguage | null = null;
	let bestScore = 0;
	for (const [language, list] of Object.entries(STOPWORDS) as Array<[ScenarioLanguage, string[]]>) {
		const set = new Set(list);
		const score = words.filter((word) => set.has(word)).length;
		if (score > bestScore) {
			best = language;
			bestScore = score;
		}
	}
	return bestScore >= 2 ? best : null;
}

const REVISION = /\b(revis(ão|ion|ión)|rev\.?)\s*#?\d+\b/i;
const INTERNAL_PHRASES = /\b(the tool rejected|a ferramenta recusou|tool_call|tool_result|function call)\b/i;

/**
 * Internals vazados no texto ao usuário: nomes de tool (com `_`), números de revisão e frases de runtime. `terms`
 * são palavras extras proibidas (ids de paleta, nomes de campo), conferidas como palavra inteira e sem diferenciar
 * maiúsculas.
 */
export function findInternals(text: string, toolNames: readonly string[], terms: readonly string[] = []): string[] {
	const clean = stripFences(text);
	const found = new Set<string>();
	for (const name of toolNames) {
		if (!name.includes("_")) continue;
		if (new RegExp(`(^|[^\\w])${escapeRegExp(name)}($|[^\\w])`).test(clean)) found.add(name);
	}
	for (const term of terms) {
		if (new RegExp(`(^|[^\\p{L}\\w])${escapeRegExp(term)}($|[^\\p{L}\\w])`, "iu").test(clean)) found.add(term);
	}
	const revision = clean.match(REVISION);
	if (revision) found.add(revision[0]);
	const phrase = clean.match(INTERNAL_PHRASES);
	if (phrase) found.add(phrase[0]);
	return [...found];
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Blocos ```chart do texto, em ordem. */
export function chartBlocks(text: string): string[] {
	return [...text.matchAll(/```chart[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
}
