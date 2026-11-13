// `ask_owner`: a ÚNICA forma de perguntar ou oferecer algo que atravessa o turno. Mostra um cartão
// e encerra o turno. Com `offer` (ex.: "continuar o resumo"), o cartão vira uma oferta com estado.
import { z } from "zod";
import { defineTool, type Tool } from "../tools/define-tool.js";

export const ASK_OWNER_TOOL = "ask_owner";

export function createAskOwnerTool(): Tool {
	return defineTool({
		name: ASK_OWNER_TOOL,
		description:
			"Ask the owner a question, or offer to continue something, as a card in the chat. This ends your turn: you get the answer in a later message. Use it when you need a decision only the owner can make, or to offer an optional continuation. Do not use it for questions you can answer yourself, or to re-offer something the owner already declined.",
		inputSchema: z.object({
			question: z.string().min(1).max(1000).describe("What to ask, in the owner's language."),
			offer: z.string().min(1).max(200).optional().describe("Short label of the continuation you are offering, only when this card is an offer."),
		}),
		effect: "read",
		endsTurn: true,
		execute: () => ({ ok: true, summary: "The question was shown to the owner as a card. Your turn ends here." }),
	});
}
