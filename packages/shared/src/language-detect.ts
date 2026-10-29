import { BOT_LANGUAGES, isBotLanguage, type BotLanguage, type ReplyLanguage } from "./bot-language.js";
import { LANGUAGE_SPECS } from "./language-registry.js";

/**
 * Detecção determinística do idioma da mensagem do usuário, só para GRAVAR o último idioma (o modelo lê a mensagem
 * por conta própria; isto alimenta rotinas, alertas e mensagens ambíguas). Sem dependência: palavras-função de cada
 * idioma (`language-registry.ts`) e sinais de grafia. Prefere não gravar a gravar errado: texto curto, código,
 * URL, emoji e idioma sem maioria clara não valem.
 */

/** Letras mínimas (depois de tirar código, URL, emoji e menções) para a mensagem valer. */
export const LANGUAGE_MIN_LETTERS = 20;
/** Mensagem longa o bastante para trocar o idioma gravado de uma vez, sem segunda confirmação. */
export const LANGUAGE_LONG_MESSAGE_LETTERS = 120;
const MIN_WORDS = 4;
/** Indícios mínimos do idioma vencedor, e quantas vezes ele precisa superar o segundo. */
const MIN_HITS = 3;
const MAJORITY_RATIO = 2;
/** Parte mínima das palavras que são indícios do vencedor (evita texto longo de termos técnicos com 3 palavras soltas). */
const MIN_HIT_DENSITY = 0.2;

/** Palavra que aparece em um idioma só: palavra de dois idiomas (ex.: "de", "que", "no") não distingue ninguém. */
const DISTINCT_WORD = (() => {
	const owner = new Map<string, BotLanguage | null>();
	for (const language of BOT_LANGUAGES) {
		for (const word of LANGUAGE_SPECS[language].words) {
			const known = owner.get(word);
			owner.set(word, known === undefined || known === language ? language : null);
		}
	}
	return owner;
})();

/** Tira o que não é a fala do usuário: blocos e trechos de código, URLs, e-mails, menções, caminhos, emoji. */
export function stripForLanguageDetection(text: string): string {
	return text
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
		.replace(/\S+@\S+\.\S+/g, " ")
		.replace(/[@#][\w.-]+/g, " ")
		.replace(/\S*[/\\_{}<>=;|]\S*/g, " ")
		.replace(/[\p{Extended_Pictographic}‍️]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Verbo de "faça algo com este texto" no começo da mensagem: o que vem depois do `:` ou da quebra é texto colado. */
const TRANSFORM_VERB =
	/^\s*(?:(?:por favor|please|por favor,)\s+)?(?:traduz\p{L}*|translat\p{L}*|resum\p{L}*|summar\p{L}*|explic\p{L}*|explain\p{L}*|corrig\p{L}*|correct\p{L}*|revis\p{L}*|review\p{L}*|reescrev\p{L}*|rewrit\p{L}*|parafrase\p{L}*|paraphras\p{L}*|analis\p{L}*|analy\p{L}*|proofread\p{L}*|leia|lê|read)(?![\p{L}])/iu;
/** Instrução (antes do `:`/quebra) mais longa que isto não é "instrução curta + bloco". */
const MAX_INSTRUCTION_CHARS = 120;
/** Trecho entre aspas só é "texto citado" se tiver este tamanho. */
const MIN_QUOTED_CHARS = 30;

/**
 * Só as palavras do próprio usuário: sem citação (`>`), sem trechos entre aspas longos e, em "traduza/resuma/
 * explique … : <texto colado>", só a instrução (o bloco colado quase sempre está em outro idioma).
 */
export function userOwnWords(text: string): string {
	const withoutQuotes = text
		.replace(/^[ \t]*>.*$/gm, " ")
		.replace(new RegExp(`“[^”]{${MIN_QUOTED_CHARS},}”|«[^»]{${MIN_QUOTED_CHARS},}»|"[^"]{${MIN_QUOTED_CHARS},}"`, "g"), " ");
	const delimiter = withoutQuotes.search(/[:\n]/);
	if (delimiter > 0 && delimiter <= MAX_INSTRUCTION_CHARS && TRANSFORM_VERB.test(withoutQuotes)) {
		const rest = withoutQuotes.slice(delimiter + 1).trim();
		if (rest.length > 0) return withoutQuotes.slice(0, delimiter);
	}
	return withoutQuotes;
}

export type DetectedLanguage = { language: BotLanguage; letters: number };

/** Idioma da mensagem com confiança alta, ou `null` (curta demais, sem maioria clara, só código/URL/emoji). */
export function detectLanguage(text: string): DetectedLanguage | null {
	const clean = stripForLanguageDetection(userOwnWords(text.normalize("NFC"))).replace(/[’‘]/g, "'").toLowerCase();
	const letters = (clean.match(/\p{L}/gu) ?? []).length;
	if (letters < LANGUAGE_MIN_LETTERS) return null;
	const words = clean.match(/\p{L}[\p{L}\p{M}']*/gu) ?? [];
	if (words.length < MIN_WORDS) return null;
	const hits = new Map<BotLanguage, number>(BOT_LANGUAGES.map((language) => [language, 0]));
	for (const word of words) {
		const language = DISTINCT_WORD.get(word) ?? cueLanguage(word);
		if (language) hits.set(language, (hits.get(language) ?? 0) + 1);
	}
	const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
	const [best, second] = [ranked[0], ranked[1]];
	if (!best || best[1] < MIN_HITS) return null;
	if (best[1] < MAJORITY_RATIO * (second?.[1] ?? 0)) return null;
	if (best[1] / words.length < MIN_HIT_DENSITY) return null;
	return { language: best[0], letters };
}

/** Palavra com letra/sinal próprio de um idioma só (ã, ç, ñ, ¿): conta como indício mesmo fora da lista. */
function cueLanguage(word: string): BotLanguage | null {
	let found: BotLanguage | null = null;
	for (const language of BOT_LANGUAGES) {
		const cues = LANGUAGE_SPECS[language].cues;
		if (cues && [...word].some((char) => cues.includes(char))) {
			if (found) return null;
			found = language;
		}
	}
	return found;
}

/** Último idioma confirmado e o candidato que viu uma confirmação só. */
export type LanguageMemory = { last: BotLanguage | null; pending: BotLanguage | null };

/** Lê o que veio do banco: valor fora do registro vira vazio. */
export function toLanguageMemory(stored: { last?: string | null; pending?: string | null } | null | undefined): LanguageMemory {
	return {
		last: isBotLanguage(stored?.last) ? stored.last : null,
		pending: isBotLanguage(stored?.pending) ? stored.pending : null,
	};
}

/**
 * Próximo estado depois de uma mensagem do usuário. Grava o idioma novo só quando: ainda não havia nenhum, a
 * mensagem é longa, ou o mesmo idioma apareceu em duas mensagens seguidas (a confirmação). Mensagem sem confiança
 * alta, ou no idioma já gravado, nunca troca nada (a segunda só zera o candidato). Evita o vai-e-volta.
 */
export function nextLanguageMemory(memory: LanguageMemory, text: string): { memory: LanguageMemory; changed: boolean } {
	const detected = detectLanguage(text);
	if (!detected) return { memory, changed: false };
	const { language, letters } = detected;
	let next: LanguageMemory;
	if (language === memory.last) next = { last: language, pending: null };
	else if (!memory.last || letters >= LANGUAGE_LONG_MESSAGE_LETTERS || memory.pending === language) next = { last: language, pending: null };
	else next = { last: memory.last, pending: language };
	return { memory: next, changed: next.last !== memory.last || next.pending !== memory.pending };
}

/**
 * Idioma que o subagente herda do pai. Fixo ou sem mensagem na vez: o já resolvido. "auto" com mensagem: o da
 * mensagem atual quando a detecção é segura (o último idioma gravado pode ainda não ter virado), senão o resolvido.
 */
export function languageForChildRun(parent: ReplyLanguage, userText: string): BotLanguage {
	return parent.followsUser ? (detectLanguage(userText)?.language ?? parent.language) : parent.language;
}
