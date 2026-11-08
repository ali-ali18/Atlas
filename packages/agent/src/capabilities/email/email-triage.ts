// `email_triage` (F7.1): o MODELO declara, por mensagem, a categoria (precisa de ação, só pra saber, ignorar), o prazo, quem
// pede e uma frase. A tool NÃO decide nada: valida (enum, data, tamanhos), mostra o cartão agrupado e devolve o resumo.
// Decisão é campo declarado, nunca regra sobre o texto do e-mail. Não tem efeito fora do Atlas (só o cartão do chat).
import { EMAIL_TRIAGE_CATEGORIES, EMAIL_SOURCES, countEmailTriage, emailTriageCardId, normalizeEmailTriage, sortEmailTriage } from "@workspace/shared";
import { z } from "zod";
import type { EmailCards } from "../../ports/email.js";
import { defineTool } from "../../tools/define-tool.js";

export function createEmailTriageTool(cards: Pick<EmailCards, "showTriage">) {
	return defineTool({
		name: "email_triage",
		description:
			"Record your triage of messages you listed or read and show it to the owner as a card grouped by category, with deadline and who asks. For each message you declare: category (needs_action = the owner must do or answer something; fyi = just worth knowing; ignore = noise, promotions, automatic notices), a one-sentence summary, the deadline the message states (YYYY-MM-DD or ISO 8601 with time zone; omit if none) and who asks. " +
			"Use it after email_list/email_read whenever the owner asks what matters in the inbox. Do not invent deadlines or categories you did not judge. It sends and changes nothing in the mailbox.",
		inputSchema: z.object({
			items: z
				.array(
					z.object({
						id: z.string().describe("The id from email_list."),
						source: z.enum(EMAIL_SOURCES).optional(),
						category: z.enum(EMAIL_TRIAGE_CATEGORIES),
						summary: z.string().describe("One short sentence: what it asks or informs."),
						from: z.string().optional(),
						subject: z.string().optional(),
						requester: z.string().optional().describe("Who asks for the action, when clear."),
						deadline: z.string().optional().describe("YYYY-MM-DD or ISO 8601 with a time zone."),
					})
					// Campo desconhecido falha (sem descarte silencioso): o modelo corrige.
					.strict(),
				)
				.min(1)
				.max(30),
		}),
		effect: "read",
		async execute({ items }, ctx) {
			const parsed = normalizeEmailTriage(items);
			if (!parsed.ok) throw new Error(parsed.error);
			const sorted = sortEmailTriage(parsed.items);
			await cards.showTriage(ctx.ownerId, ctx.runId, { cardId: emailTriageCardId(ctx.runId, sorted), items: sorted });
			const counts = countEmailTriage(sorted);
			const lines = sorted.map((item) => `- [${item.category}] ${item.subject ?? item.id}${item.deadline ? ` | by ${item.deadline}` : ""}${item.requester ? ` | asked by ${item.requester}` : ""} | ${item.summary}`);
			return { ok: true, summary: `A triage card was shown to the owner (do not repeat every line): ${counts.needs_action} need action, ${counts.fyi} for information, ${counts.ignore} to ignore.\n${lines.join("\n")}` };
		},
	});
}
