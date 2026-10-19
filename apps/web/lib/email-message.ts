import { parseFramedInboundEmail, stripQuotedReply } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";

/**
 * Mensagem gravada de um run disparado por e-mail (`source.kind === "email"`) → cartão de e-mail recebido.
 * Nunca é fala do dono: o corpo aparece sem o histórico citado (o completo fica no registro do e-mail).
 * `null` quando o texto não é um e-mail emoldurado (o chamador cai no balão comum).
 */
export function inboundEmailThreadMessage(id: string, content: string): Message | null {
	const email = parseFramedInboundEmail(content);
	if (!email) return null;
	return { id, kind: "user", text: stripQuotedReply(email.body), email: { from: email.from, subject: email.subject, threadId: email.threadId } };
}

/** Corpo que a thread mostra para o objetivo de um run de e-mail (para casar com a fala gravada). */
export function inboundEmailBodyOf(objective: string): string | null {
	const email = parseFramedInboundEmail(objective);
	return email ? stripQuotedReply(email.body).trim() : null;
}
