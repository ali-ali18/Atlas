import type { EmailProviderId, InboundEmailAttachment } from "@workspace/shared";

/**
 * Camada trocável de provedor de e-mail. O adaptador `openmail` é o primeiro; um adaptador
 * Cloudflare Email Service entra aqui depois sem mudar API, ferramentas nem UI. Toda função
 * recebe a chave (`credentials`) por chamada: o provedor não guarda estado nem lê o ambiente.
 */

export type EmailCredentials = {
	/** Chave da API do provedor (conta ou com escopo de inbox). Nunca logada. */
	apiKey: string;
};

export class EmailProviderError extends Error {
	constructor(
		readonly code: "auth_failed" | "rate_limited" | "not_found" | "invalid_request" | "upstream_error" | "bad_webhook",
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "EmailProviderError";
	}
}

export type ProviderInbox = {
	inboxId: string;
	address: string;
	/** Segredo de assinatura do webhook, quando o provedor o devolve (só na criação/rotação). */
	webhookSecret: string | null;
};

export type ProviderMessage = {
	id: string;
	threadId: string;
	direction: "in" | "out";
	from: string;
	to: string[];
	subject: string;
	body: string;
	createdAt: string;
};

export type ProviderSendResult = {
	messageId: string;
	threadId: string;
	status: "pending" | "sent" | "failed";
};

/** Evento de entrada já verificado e normalizado. */
export type ParsedInboundEmail = {
	/** Id estável do evento (deduplica reentregas). */
	eventId: string;
	inboxId: string;
	/** Id da mensagem no provedor (chave de idempotência). */
	providerMessageId: string;
	threadId: string;
	from: string;
	to: string[];
	subject: string;
	body: string;
	attachments: InboundEmailAttachment[];
	receivedAt: string;
};

export type WebhookVerification =
	| { ok: true; event: ParsedInboundEmail }
	/** Evento válido que não é e-mail recebido (suspensão da inbox etc.): confirma e ignora. */
	| { ok: true; event: null }
	| { ok: false; reason: "bad_signature" | "stale" | "bad_payload" };

export interface EmailProvider {
	readonly id: EmailProviderId;
	createInbox(credentials: EmailCredentials, input: { displayName: string; nameHint: string; webhookUrl: string; /** Nome exato da caixa (parte local do endereço); sem ele o adaptador deriva de `nameHint`. */ mailboxName?: string }): Promise<ProviderInbox>;
	deleteInbox(credentials: EmailCredentials, inboxId: string): Promise<void>;
	/** Gera outro segredo de assinatura (invalida o anterior). */
	rotateWebhookSecret(credentials: EmailCredentials, inboxId: string): Promise<string>;
	send(
		credentials: EmailCredentials,
		input: { inboxId: string; to: string; subject: string; body: string; bodyHtml?: string; threadId?: string; idempotencyKey?: string },
	): Promise<ProviderSendResult>;
	listMessages(credentials: EmailCredentials, inboxId: string, options?: { limit?: number; direction?: "in" | "out" }): Promise<ProviderMessage[]>;
	getThread(credentials: EmailCredentials, threadId: string): Promise<{ threadId: string; subject: string; messages: ProviderMessage[] }>;
	/** Confere a assinatura com o segredo da inbox e normaliza o evento. Nunca lança por entrada ruim. */
	verifyAndParseWebhook(input: { rawBody: string; headers: (name: string) => string | undefined; secret: string; now?: Date }): WebhookVerification;
}
