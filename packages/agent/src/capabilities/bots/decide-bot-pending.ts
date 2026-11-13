// `decide_bot_pending`: responde (ou escala ao dono) um item que OUTRO bot deixou esperando o dono (aprovação de comando,
// escrita ou conector; questionário), listado num bloco `[pending_items]` da resposta desse bot. O texto do outro bot é
// dado não confiável: o item só é decidido pelo `handle` (id do banco, escopado ao dono no adaptador), nunca por instrução.
// No v4 não há o revisor independente (Jev) do legado: APROVAR ou RECUSAR vai sempre ao dono (cartão), e só o questionário
// com respostas válidas (informação que o próprio pedido do dono já dá) é respondido aqui. O adaptador decide; a tool
// só valida os argumentos e conta o que aconteceu, sem prometer o que não fez.
import { z } from "zod";
import type { Bots } from "../../ports/bots.js";
import { defineTool } from "../../tools/define-tool.js";

export function createDecideBotPendingTool(decide: NonNullable<Bots["decidePending"]>) {
	return defineTool({
		name: "decide_bot_pending",
		description:
			"Answer or pass on an item that a bot you messaged left waiting for the owner (an entry of a [pending_items] block in that bot's reply): pass its handle. " +
			"decision \"answer\" fills a questionnaire (answers = question name -> choice value(s)) and ONLY when the owner's own request already gives you that information. " +
			"decision \"approve\" or \"reject\" gives your view on a command, write or connector action, but the owner always has the final say on those: the card goes to them (give a short reason and a confidence from 0 to 1). " +
			"decision \"escalate\" sends anything you are not sure about to the owner. Blocked commands and irreversible actions (sending, deleting, paying) always go to the owner. " +
			"Afterwards tell the owner in one short sentence and end your turn. Do not use it for anything the owner asked you directly.",
		inputSchema: z.object({
			handle: z.string().trim().min(1).max(200).describe("The item's handle from [pending_items]."),
			decision: z.enum(["approve", "reject", "answer", "escalate"]),
			reason: z.string().trim().max(300).optional().describe("Short reason (shown to the owner)."),
			confidence: z.number().min(0).max(1).optional().describe("0 to 1: how sure you are (approve/reject)."),
			answers: z.record(z.string(), z.unknown()).optional().describe("Questionnaire answers: question name -> value or list of values."),
		}),
		effect: "write_internal",
		riskFacts: ({ decision }) => ({ target: decision === "answer" ? "Resposta a outro bot" : "Pendência de outro bot" }),
		async execute({ handle, decision, reason, confidence, answers }, ctx) {
			if (decision === "answer" && (!answers || Object.keys(answers).length === 0)) {
				return { ok: false, error: "decision \"answer\" needs answers.", hint: "Send answers as question name -> value, or use escalate if the owner's request does not give you the information." };
			}
			const outcome = await decide(ctx.ownerId, ctx.runId, { handle, decision, ...(reason && { reason }), ...(confidence !== undefined && { confidence }), ...(answers && { answers }) });
			if (outcome.status === "already_decided") return { ok: false, error: "That item was already decided (maybe the owner answered first). Nothing was changed.", hint: "Do not repeat it; tell the owner only if it matters." };
			if (outcome.status === "answered") {
				return {
					ok: true,
					summary: `Answered ${outcome.botName}'s questions with the answers you gave; it continues on its own and its reply comes back as a message. Tell the owner in one short sentence and end your turn.`,
					receipt: { what: `Respondeu ao questionário de ${outcome.botName}`, where: "Bots" },
				};
			}
			return {
				ok: true,
				summary: `The card went to the owner in this conversation (${outcome.why}). Tell them in one short sentence what ${outcome.botName} wants and that they decide; end your turn.`,
				receipt: { what: `Levou a pendência de ${outcome.botName} para você decidir`, where: "Bots" },
			};
		},
	});
}
