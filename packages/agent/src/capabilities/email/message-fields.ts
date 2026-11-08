// Campos comuns de `email_draft` e `email_send` (a mesma mensagem, com efeitos diferentes).
import { EMAIL_DRAFT_BODY_MAX, EMAIL_DRAFT_RECIPIENTS_MAX, EMAIL_DRAFT_SUBJECT_MAX, isPlausibleEmailAddress } from "@workspace/shared";
import { z } from "zod";
import { sourceField } from "./accounts.js";

const address = z.string().trim().refine(isPlausibleEmailAddress, { message: "not an e-mail address (one plain address, no display name, no spaces)" });

export const messageShape = {
	source: sourceField,
	to: z.array(address).min(1).max(EMAIL_DRAFT_RECIPIENTS_MAX).describe("Recipients: plain addresses. For a reply, the person who wrote."),
	cc: z.array(address).max(EMAIL_DRAFT_RECIPIENTS_MAX).optional(),
	subject: z.string().trim().min(1).max(EMAIL_DRAFT_SUBJECT_MAX).optional().describe("Required for a new message; for a reply the conversation's subject is kept."),
	body: z.string().trim().min(1).max(EMAIL_DRAFT_BODY_MAX).describe("Plain text, in the language of the conversation."),
	in_reply_to: z.string().trim().min(1).max(200).optional().describe("The id (from email_list/email_read) of the message you answer. Keeps the reply in its conversation."),
};

type MessageArgs = { to: string[]; cc?: string[] | undefined; subject?: string | undefined; body: string; in_reply_to?: string | undefined };

/** Falha com a dica quando falta o assunto de uma mensagem nova. Devolve a forma que a porta recebe. */
export function toPortMessage(args: MessageArgs) {
	if (!args.in_reply_to && !args.subject) throw new Error("A new message needs a subject. Hint: give subject, or in_reply_to to answer an existing message.");
	return { to: args.to, ...(args.cc && args.cc.length > 0 && { cc: args.cc }), ...(args.subject && { subject: args.subject }), body: args.body, ...(args.in_reply_to && { inReplyTo: args.in_reply_to }) };
}
