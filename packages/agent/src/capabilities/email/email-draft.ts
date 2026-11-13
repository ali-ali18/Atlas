// `email_draft` (F7.1): rascunho para o dono REVISAR. Efeito `draft` (nada sai do Atlas para terceiros). No Gmail cria o
// rascunho de verdade na caixa do dono; na caixa do bot não há pasta de rascunhos, então o rascunho vive só no cartão do chat.
// Em ambos o cartão mostra para quem, assunto e texto. Enviar é outra tool (`email_send`), com aprovação.
import { emailDraftCardId } from "@workspace/shared";
import { z } from "zod";
import type { EmailPorts } from "../../ports/email.js";
import { defineTool } from "../../tools/define-tool.js";
import { singleAccount } from "./accounts.js";
import { messageShape, toPortMessage } from "./message-fields.js";

export function createEmailDraftTool(ports: EmailPorts) {
	return defineTool({
		name: "email_draft",
		description:
			"Write an e-mail draft for the owner to review, new or a reply (in_reply_to), and show it on a card. In Gmail it is saved in the owner's drafts; for the bot's own mailbox it lives on the card. Nothing is sent. " +
			"Use it when the owner wants a reply or message written, or whenever sending is not clearly asked. Send only with email_send after the owner asks for it. Do not copy secrets or private data into a draft unless the owner asked.",
		inputSchema: z.object(messageShape),
		effect: "draft",
		async execute(args, ctx) {
			const message = toPortMessage(args);
			const account = await singleAccount(ports, ctx.ownerId, args.source);
			const draft = await account.createDraft(ctx.ownerId, message, ctx.signal);
			const card = { source: account.info.source, to: draft.to, ...(draft.cc && draft.cc.length > 0 && { cc: draft.cc }), subject: draft.subject, body: args.body, ...(args.in_reply_to && { reply: true }), saved: draft.saved };
			await ports.cards.showDraft(ctx.ownerId, ctx.runId, { cardId: emailDraftCardId(ctx.runId, card), ...card });
			const where = draft.saved ? `Saved in the owner's ${account.info.label} drafts (${draft.draftId ?? "id unknown"}) and shown on a card.` : "Shown on a card for review; it is not saved in any mailbox.";
			return {
				ok: true,
				summary: `${where} NOT sent. To: ${draft.to.join(", ")}. Subject: ${draft.subject}. Tell the owner it is ready to review; to send it, they must ask (email_send, which shows them the recipients first).`,
				receipt: { what: `Draft written to ${draft.to.join(", ")}`, where: account.info.label, ...(draft.draftId && { externalId: draft.draftId }) },
			};
		},
	});
}
