import { toBotReactionEmoji, type BotReactionEmoji } from "@workspace/shared";
import { clipForJev, decideWithJev, jevModeFor, jevYes, type JevRuntime } from "./decide.js";

const yesNo = { true: "Yes", false: "No" };

export const REACTION_QUESTIONS = {
	no_reply: {
		instructions:
			"Is the user's latest message ONLY an acknowledgement, agreement, thanks, affection, amusement or farewell that expects nothing back (no answer, no action, no new information, no question, no correction, no complaint)? The message may be in any language.",
		criteria: yesNo,
	},
	thanks: {
		instructions: "Is the user's latest message mainly gratitude or affection?",
		criteria: yesNo,
	},
	funny: {
		instructions: "Is the user's latest message mainly laughter or amusement?",
		criteria: yesNo,
	},
};

/**
 * Camada 2 do "responder só com reação": o modelo barato (Jev) julga uma mensagem curta e ambígua.
 * Só vai a pergunta + a última fala do assistente (curta). Devolve o emoji (sempre do conjunto fixo do bot)
 * ou `null` quando o Jev está desligado/em sombra, falha, estoura o tempo ou não tem certeza: segue o fluxo normal.
 */
export async function detectReactionOnly(input: {
	rt: JevRuntime | undefined;
	latestUserMessage: string;
	previousAssistantMessage?: string;
	signal?: AbortSignal;
}): Promise<BotReactionEmoji | null> {
	const message = input.latestUserMessage.trim();
	if (jevModeFor(input.rt, "intent") !== "on" || !message) return null;
	try {
		const result = await decideWithJev({
			rt: input.rt,
			feature: "intent",
			state: {
				latestUserMessage: clipForJev(message, 200),
				...(input.previousAssistantMessage ? { previousAssistantMessage: clipForJev(input.previousAssistantMessage, 240) } : {}),
			},
			questions: REACTION_QUESTIONS,
			signal: input.signal,
		});
		if (!result || !jevYes(result.answers.no_reply, 0.9)) return null;
		if (jevYes(result.answers.thanks, 0.7)) return toBotReactionEmoji("❤️");
		if (jevYes(result.answers.funny, 0.7)) return toBotReactionEmoji("😂");
		return toBotReactionEmoji("👍");
	} catch {
		return null;
	}
}
