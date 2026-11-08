// E-mail falso para teste (sem rede, sem Gmail, sem provedor): contas por dono, mensagens em memória e os cartões mostrados.
import type { EmailSourceId } from "@workspace/shared";
import type { EmailAccount, EmailAccountInfo, EmailCards, EmailDraftCardPayload, EmailDraftInput, EmailListQuery, EmailMessageContent, EmailPorts, EmailTriageCardPayload } from "../ports/email.js";

export type FakeMessage = EmailMessageContent & { userId: string; source: EmailSourceId };

export class FakeEmail {
	/** Mensagens de TODOS os donos: a conta só enxerga as do dono que a abriu (o IDOR fica por conta dela). */
	readonly messages: FakeMessage[] = [];
	readonly sent: Array<{ userId: string; source: EmailSourceId; message: EmailDraftInput; idempotencyKey?: string }> = [];
	readonly drafts: Array<{ userId: string; source: EmailSourceId; message: EmailDraftInput }> = [];
	readonly triageCards: Array<{ userId: string; runId: string; card: EmailTriageCardPayload }> = [];
	readonly draftCards: Array<{ userId: string; runId: string; card: EmailDraftCardPayload }> = [];
	readonly opened: Array<{ userId: string; source: EmailSourceId }> = [];
	/** Contas por dono. */
	readonly connected = new Map<string, EmailSourceId[]>();
	/** Quando preenchido, `send` falha com este erro (ex.: falta de permissão). */
	sendError: string | undefined;
	readonly cards: EmailCards = {
		showTriage: async (userId, runId, card) => {
			if (!this.triageCards.some((c) => c.card.cardId === card.cardId)) this.triageCards.push({ userId, runId, card });
		},
		showDraft: async (userId, runId, card) => {
			if (!this.draftCards.some((c) => c.card.cardId === card.cardId)) this.draftCards.push({ userId, runId, card });
		},
	};

	connect(userId: string, ...sources: EmailSourceId[]): this {
		this.connected.set(userId, sources);
		return this;
	}

	add(over: Partial<FakeMessage> & { userId: string; id: string }): this {
		this.messages.push({ source: "gmail", from: "ana@empresa.test", to: ["dono@exemplo.test"], cc: [], subject: "Assunto", snippet: "", date: "2026-11-07T10:00:00.000Z", body: "Corpo", attachments: [], ...over });
		return this;
	}

	private label(source: EmailSourceId): string {
		return source === "gmail" ? "Gmail" : "Bot mailbox";
	}

	private account(userId: string, source: EmailSourceId): EmailAccount {
		const info: EmailAccountInfo = { source, label: this.label(source) };
		const mine = () => this.messages.filter((m) => m.userId === userId && m.source === source);
		return {
			info,
			list: async (_user, query: EmailListQuery) => {
				let found = mine();
				if (query.from) found = found.filter((m) => m.from.toLowerCase().includes(query.from!.toLowerCase()));
				if (query.subject) found = found.filter((m) => m.subject.toLowerCase().includes(query.subject!.toLowerCase()));
				const unsupported = source === "bot" && query.unread ? ["unread"] : [];
				if (query.unread && source === "gmail") found = found.filter((m) => m.unread === true);
				return { messages: found.slice(0, query.limit), ...(unsupported.length > 0 && { unsupported }) };
			},
			read: async (_user, id) => {
				const found = mine().find((m) => m.id === id);
				if (!found) throw new Error("Message not found.");
				return found;
			},
			createDraft: async (_user, message) => {
				this.drafts.push({ userId, source, message });
				return { saved: source === "gmail", ...(source === "gmail" && { draftId: `draft-${this.drafts.length}` }), to: message.to, ...(message.cc && { cc: message.cc }), subject: message.subject ?? "Re: (original)" };
			},
			send: async (_user, message, _signal, options) => {
				if (this.sendError) throw new Error(this.sendError);
				this.sent.push({ userId, source, message, ...(options?.idempotencyKey && { idempotencyKey: options.idempotencyKey }) });
				return { messageId: `sent-${this.sent.length}`, to: message.to, subject: message.subject ?? "Re: (original)" };
			},
		};
	}

	readonly ports: EmailPorts = {
		accounts: {
			list: async (userId) => (this.connected.get(userId) ?? []).map((source) => ({ source, label: this.label(source) })),
			open: async (userId, source) => {
				this.opened.push({ userId, source });
				return (this.connected.get(userId) ?? []).includes(source) ? this.account(userId, source) : null;
			},
		},
		cards: this.cards,
	};
}
