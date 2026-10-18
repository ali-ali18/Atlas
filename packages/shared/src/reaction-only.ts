/**
 * Reações em mensagens e "responder só com reação".
 *
 * Funções puras (sem I/O): o classificador determinístico (camada 1, custo zero), o filtro de mensagens
 * curtas e ambíguas que podem ir ao modelo barato (camada 2) e as travas que impedem a reação quando a
 * mensagem pode ser uma resposta de verdade. Quem decide e grava é a API (`apps/api/src/chat/reaction-only.ts`).
 */

/** Uma reação por ator e mensagem. `bot` = o bot da conversa; `user` = o dono. */
export type MessageReaction = { actor: "user" | "bot"; emoji: string };

export type ReactionCategory = "thanks" | "night" | "bye" | "laugh" | "ack";

/** Conjunto fixo e enxuto de reações do bot (e primeiras opções do seletor do usuário). */
export const BOT_REACTION_EMOJIS = ["❤️", "😂", "👍", "👎", "🙏", "😮"] as const;
export type BotReactionEmoji = (typeof BOT_REACTION_EMOJIS)[number];

/** Qualquer coisa fora do conjunto vira 👍. */
export function toBotReactionEmoji(value: unknown): BotReactionEmoji {
	return (BOT_REACTION_EMOJIS as readonly unknown[]).includes(value) ? (value as BotReactionEmoji) : "👍";
}

export const REACTION_ONLY_EMOJI: Record<ReactionCategory, BotReactionEmoji> = {
	thanks: "❤️",
	night: "👍",
	bye: "👍",
	laugh: "😂",
	ack: "👍",
};

export const REACTION_EMOJI_MAX_UNITS = 16;
/** 👎 do usuário numa fala do bot vira nota para a reflexão diária. */
export const DISLIKE_EMOJI = "👎";

const EMOJI_BODY =
	"(?:\\p{Extended_Pictographic}(?:\\ufe0f|\\p{Emoji_Modifier})?(?:\\u200d\\p{Extended_Pictographic}(?:\\ufe0f|\\p{Emoji_Modifier})?)*|[\\u{1F1E6}-\\u{1F1FF}]{2}|[0-9#*]\\ufe0f?\\u20e3)";
const EMOJI_ONLY = new RegExp(`^${EMOJI_BODY}+$`, "u");
const EMOJI_GLOBAL = new RegExp(EMOJI_BODY, "gu");

/** Emoji válido para reagir (um ou poucos pictogramas, sem texto). `null` = inválido. */
export function normalizeReactionEmoji(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const value = input.trim();
	if (!value || value.length > REACTION_EMOJI_MAX_UNITS) return null;
	return EMOJI_ONLY.test(value) ? value : null;
}

const baseOf = (emoji: string): string => emoji.replace(/[️\u{1F3FB}-\u{1F3FF}]/gu, "");

const LOVE_EMOJI = new Set(["🙏", "❤", "🧡", "💛", "💚", "💙", "💜", "😍", "🥰", "😘", "🤗", "😊", "☺", "💕", "💖"]);
const LAUGH_EMOJI = new Set(["😂", "🤣", "😆", "😅", "😹"]);
const ACK_EMOJI = new Set(["👍", "👌", "✅", "🙌", "👏", "🤝", "💪", "🎉", "🔥", "💯", "✨", "🙂", "😀", "😃", "😄", "😁", "😉", "🤙", "☑"]);

const WORD_CATEGORY = new Map<string, ReactionCategory>();
const PHRASES: Array<[ReactionCategory, string[]]> = [
	["thanks", ["obrigado", "obrigada", "obrigadao", "brigado", "brigada", "brigadao", "obg", "obgd", "obgda", "valeu", "vlw", "tmj", "thanks", "thx", "ty", "grato", "grata", "agradecido", "agradecida", "agradeco", "thank you", "muito obrigado", "muito obrigada", "valeu demais", "obrigado demais"]],
	["night", ["boa noite", "bom descanso", "durma bem", "good night", "gn", "ate amanha", "ate manha"]],
	["bye", ["tchau", "xau", "flw", "falou", "ate logo", "ate mais", "ate breve", "ate a proxima", "bye", "see you", "see ya", "bom fim de semana", "bom fds", "bom final de semana", "ate segunda"]],
	["ack", [
		"ok", "okay", "oki", "okei", "okk", "oks", "ok ok", "certo", "certinho", "entendi", "entendido", "combinado", "fechado", "fechou", "perfeito", "perfeita", "blz", "beleza", "belezinha", "tranquilo", "tranquila", "tamo", "ta", "ta bom", "ta certo", "ta ok", "ta blz", "show", "top", "massa", "legal", "bacana", "maravilha", "joia", "dahora", "da hora", "boa", "otimo", "otima", "excelente", "sensacional", "isso", "exato", "isso mesmo", "positivo", "got it", "gotcha", "cool", "nice", "great", "awesome", "perfect", "alright", "noted", "understood", "sounds good",
	]],
];
for (const [category, phrases] of PHRASES) for (const phrase of phrases) WORD_CATEGORY.set(phrase, category);
const MAX_PHRASE_WORDS = 4;
const FILLERS = new Set(["muito", "demais", "mesmo", "viu", "ne", "entao", "ai", "mto"]);
const LAUGH_WORD = /^(?:k{2,}|(?:ha){2,}h?|a(?:ha)+h?|(?:he){2,}h?|(?:hi){2,}h?|(?:rs)+|(?:hue)+|lol|lmao)$/;
const PRIORITY: ReactionCategory[] = ["thanks", "night", "bye", "laugh", "ack"];

/** Remove acentos e minúsculas; `null` se sobrar algo que não seja letra, espaço ou pontuação leve. */
function wordsOf(text: string): string[] | null {
	const folded = text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[.,!;:~\-–—…"'()]+/g, " ")
		.trim();
	if (!/^[a-z\s]*$/.test(folded)) return null;
	return folded.split(/\s+/).filter(Boolean);
}

export type ReactionOnlyMatch = { emoji: BotReactionEmoji; category: ReactionCategory };

/**
 * Camada 1: a mensagem inteira é só aceno/agradecimento/riso/despedida/emoji? Devolve o emoji para reagir.
 * Qualquer pergunta, número, link, menção ou palavra fora do vocabulário = `null` (segue o fluxo normal).
 */
export function classifyReactionOnly(text: string): ReactionOnlyMatch | null {
	const raw = text.trim();
	if (!raw || raw.length > 60 || raw.includes("\n")) return null;
	if (/[?¿]/.test(raw)) return null;

	const found = new Set<ReactionCategory>();
	for (const match of raw.matchAll(EMOJI_GLOBAL)) {
		const base = baseOf(match[0]);
		if (LOVE_EMOJI.has(base)) found.add("thanks");
		else if (LAUGH_EMOJI.has(base)) found.add("laugh");
		else if (ACK_EMOJI.has(base)) found.add("ack");
		else return null;
	}
	const rest = raw.replace(EMOJI_GLOBAL, " ");
	const words = wordsOf(rest);
	if (!words) return null;
	if (words.length > 6) return null;

	let index = 0;
	while (index < words.length) {
		let matched = 0;
		for (let size = Math.min(MAX_PHRASE_WORDS, words.length - index); size >= 1; size -= 1) {
			const phrase = words
				.slice(index, index + size)
				.map((word) => word.replace(/(.)\1{2,}/g, "$1"))
				.join(" ");
			const category = WORD_CATEGORY.get(phrase);
			if (category) {
				found.add(category);
				matched = size;
				break;
			}
		}
		if (matched) {
			index += matched;
			continue;
		}
		const word = words[index]!;
		if (LAUGH_WORD.test(word)) found.add("laugh");
		else if (!FILLERS.has(word.replace(/(.)\1{2,}/g, "$1"))) return null;
		index += 1;
	}
	const category = PRIORITY.find((candidate) => found.has(candidate));
	if (!category) return null;
	return { emoji: REACTION_ONLY_EMOJI[category], category };
}

const REQUEST_WORDS = new RegExp(
	[
		"manda", "mande", "envia", "envie", "faz", "faca", "fazer", "cria", "crie", "gera", "gere", "mostra", "mostre", "mostrar", "da", "me", "preciso", "precisa", "quero", "queria", "pode", "podes", "consegue", "poderia", "verifica", "verifique", "veja", "ve", "confere", "confira", "busca", "busque", "procura", "procure", "abre", "abra", "liga", "ligue", "desliga", "apaga", "apague", "delete", "deleta", "remove", "remova", "atualiza", "atualize", "muda", "mude", "troca", "troque", "lembra", "lembre", "avisa", "avise", "agenda", "agende", "marca", "marque", "resume", "resuma", "explica", "explique", "traduz", "traduza", "calcula", "calcule", "continua", "continue", "segue", "siga", "para", "pare", "cancela", "cancele", "tenta", "tente", "refaz", "refaca", "repete", "repita", "corrige", "corrija", "ajuda", "ajude", "responde", "responda", "diz", "diga", "fala", "fale", "conta", "conte", "lista", "liste", "salva", "salve", "anota", "anote", "compra", "compre", "paga", "pague", "qual", "quais", "quanto", "quantos", "quantas", "quando", "onde", "como", "quem", "porque", "por", "que", "cade", "nao", "nada", "errado", "errada", "erro", "problema", "falhou", "ruim", "pior", "sim", "send", "make", "create", "give", "please", "can", "could", "tell", "check", "find", "run", "do", "stop", "wait", "what", "why", "how", "when", "where", "who", "no", "not", "wrong", "fix",
	]
		.map((word) => `^${word}$`)
		.join("|"),
);

/**
 * Camada 2 (portão): mensagem curta e sem cara de pedido/pergunta/correção, que o modelo barato pode julgar.
 * Conservador: na dúvida, `false` (segue o fluxo normal).
 */
export function isAmbiguousShortMessage(text: string): boolean {
	const raw = text.trim();
	if (!raw || raw.length > 60 || raw.includes("\n")) return false;
	if (/[?¿@#/\\`<>{}[\]|=*_0-9]/.test(raw) || /https?:|www\./i.test(raw)) return false;
	const words = wordsOf(raw.replace(EMOJI_GLOBAL, " "));
	if (!words || words.length === 0 || words.length > 8) return false;
	return !words.some((word) => REQUEST_WORDS.test(word));
}

/** A fala anterior do assistente pergunta ou pede algo ao usuário? Então "ok" é uma resposta. */
export function assistantAskedSomething(text: string): boolean {
	const tail = text.trim().slice(-400);
	if (/[?¿]/.test(tail)) return true;
	return /\b(?:me (?:diga|avise|confirme|fale|passe|informe|envie|mande|responda)|quer que|gostaria que|deseja|prefere|pode me|let me know|would you like|do you want|shall i|confirma)\b/i.test(tail);
}

export const REACTION_ONLY_MAX_ASSISTANT_AGE_MS = 12 * 60 * 60 * 1000;

export type ReactionGuardContext = {
	/** Configuração da conta ("Responder só com reação…"), ligada por padrão. */
	enabled: boolean;
	origin: string | undefined;
	silent: boolean;
	hasAttachments: boolean;
	hasDecisionConfirm: boolean;
	isGroup: boolean;
	/** Run ativo ou na fila nesta conversa. */
	hasActiveRun: boolean;
	/** Cartão (pergunta, questionário, aprovação, proposta) ou intenção pendente esperando o usuário. */
	hasPendingCard: boolean;
	/** Última fala da conversa (usuário/assistente) antes desta mensagem. */
	previous: { role: string; text: string; at: Date } | null;
	now: Date;
};

export type ReactionBlock =
	| "disabled"
	| "origin"
	| "silent"
	| "attachments"
	| "confirm"
	| "group"
	| "active-run"
	| "pending-card"
	| "no-context"
	| "stale"
	| "asked";

/** `null` = pode reagir; senão o motivo (para teste/log). Não olha o texto: isso é da camada 1/2. */
export function reactionOnlyBlock(ctx: ReactionGuardContext): ReactionBlock | null {
	if (!ctx.enabled) return "disabled";
	if ((ctx.origin ?? "chat") !== "chat") return "origin";
	if (ctx.silent) return "silent";
	if (ctx.hasAttachments) return "attachments";
	if (ctx.hasDecisionConfirm) return "confirm";
	if (ctx.isGroup) return "group";
	if (ctx.hasActiveRun) return "active-run";
	if (ctx.hasPendingCard) return "pending-card";
	if (!ctx.previous || ctx.previous.role !== "assistant") return "no-context";
	if (ctx.now.getTime() - ctx.previous.at.getTime() > REACTION_ONLY_MAX_ASSISTANT_AGE_MS) return "stale";
	if (assistantAskedSomething(ctx.previous.text)) return "asked";
	return null;
}
