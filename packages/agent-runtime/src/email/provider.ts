import type { EmailDomainStatus, EmailProviderId, InboundEmailAttachment } from "@workspace/shared";

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
		readonly code: "auth_failed" | "rate_limited" | "not_found" | "invalid_request" | "upstream_error" | "bad_webhook" | "plan_required" | "domain_exists" | "invalid_domain" | "domain_in_use",
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

export type ProviderDomainRecord = { type: "TXT" | "CNAME" | "MX"; name: string; value: string; priority: number | null; valid: boolean };

export type ProviderDomain = { id: string; domain: string; status: EmailDomainStatus; records: ProviderDomainRecord[] };

/** Domínios próprios da conta (opcional: nem todo provedor tem). */
export interface EmailDomainSupport {
	list(credentials: EmailCredentials): Promise<ProviderDomain[]>;
	/** Registra o domínio e devolve os registros DNS a publicar. */
	add(credentials: EmailCredentials, domain: string): Promise<ProviderDomain>;
	/** Força uma nova checagem do DNS e devolve o estado atual. */
	verify(credentials: EmailCredentials, domainId: string): Promise<ProviderDomain>;
	remove(credentials: EmailCredentials, domainId: string): Promise<void>;
}

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
	/** Presente só se o provedor sabe gerir domínios próprios. */
	readonly domains?: EmailDomainSupport;
	createInbox(credentials: EmailCredentials, input: { displayName: string; nameHint: string; webhookUrl: string; /** Nome exato da caixa (parte local do endereço); sem ele o adaptador deriva de `nameHint`. */ mailboxName?: string; /** Domínio próprio já verificado; sem ele vale o domínio padrão do provedor. */ domain?: string }): Promise<ProviderInbox>;
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
