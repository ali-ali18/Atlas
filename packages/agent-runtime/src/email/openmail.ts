import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEmailAddress, oneLineHeader } from "@workspace/shared";
import {
	EmailProviderError,
	type EmailCredentials,
	type EmailProvider,
	type ParsedInboundEmail,
	type ProviderDomain,
	type ProviderInbox,
	type ProviderMessage,
	type ProviderSendResult,
	type WebhookVerification,
} from "./provider.js";

/**
 * Adaptador OpenMail (https://openmail.sh, API https://api.openmail.sh).
 *
 * Fatos da documentação pública usados aqui:
 *  - Auth: `Authorization: Bearer <chave>`. Chaves `om_…` de conta alcançam tudo.
 *  - `POST /v1/inboxes` { mailboxName (3-30), displayName, webhookUrl } → { id, address, webhookSecret }.
 *    O `webhookSecret` só vem na criação, ao definir o webhook pela primeira vez e na rotação.
 *  - Domínios próprios (plano Pro): `POST /v1/domains` {domain}, `GET /v1/domains` {data,total}, `GET /v1/domains/{id}`,
 *    `POST /v1/domains/{id}/verify`, `DELETE /v1/domains/{id}`. Domain = { id, domain, status (pending|verifying|verified|failed|under_review),
 *    records[{ type TXT|CNAME|MX, name, value, priority, purpose, status missing|invalid|valid }] }. `POST /v1/inboxes` aceita `domain` (verificado).
 *    Erros: 403 plan_limit, 409 domain_exists/domain_taken, 422 invalid_domain/domain_has_inboxes/domain_blocked.
 *  - `POST /v1/inboxes/{id}/send` { to, subject, body, bodyHtml?, threadId? } + `Idempotency-Key`.
 *  - `GET /v1/inboxes/{id}/messages?direction=&limit=`; `GET /v1/threads/{id}/messages`.
 *  - Webhook `message.received`: POST JSON { event, event_id, occurred_at, inbox_id, thread_id,
 *    message: { id, from, to, cc, subject, body_text, attachments[{ filename, contentType, sizeBytes,
 *    url, parsedText, extractionMethod }], received_at } }, com cabeçalhos X-Event-Id, X-Timestamp
 *    (epoch s) e X-Signature = HMAC-SHA256 de "<timestamp>.<corpo cru>" com o segredo da inbox;
 *    a entrega é at-least-once (deduplicar por event_id) e o timestamp deve estar a ≤ 5 min.
 */

export const OPENMAIL_BASE_URL = "https://api.openmail.sh";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SKEW_MS = 5 * 60_000;

type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
}>;

export type OpenMailDeps = {
	fetchFn?: FetchFn;
	baseUrl?: string;
	timeoutMs?: number;
};

function rec(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** `from` pode vir como texto ("Nome <a@b>") ou objeto ({ address, name }). */
function addressOf(value: unknown): string {
	if (typeof value === "string") return normalizeEmailAddress(value) ?? oneLineHeader(value, 254);
	const obj = rec(value);
	return normalizeEmailAddress(obj.address ?? obj.email) ?? "";
}

function addressList(value: unknown): string[] {
	const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return items.map(addressOf).filter(Boolean);
}

/** Domínio padrão das caixas OpenMail (só para mostrar o endereço esperado antes de criar). */
export const OPENMAIL_DEFAULT_DOMAIN = "openmail.sh";

/** Nome de caixa válido (3-30; a-z, 0-9, hífen) derivado do nome do bot, com sufixo aleatório. */
export function suggestMailboxName(hint: string): string {
	const base = hint
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20);
	const suffix = Math.random().toString(36).slice(2, 8);
	const name = `${base || "bot"}-${suffix}`;
	return name.length >= 3 ? name.slice(0, 30) : `bot-${suffix}`;
}

function mapDomainError(status: number, text: string): void {
	let code = "";
	try {
		code = str(rec(JSON.parse(text)).error);
	} catch {
		// Corpo sem JSON: cai nos mapeamentos por status.
	}
	if (code === "plan_limit") throw new EmailProviderError("plan_required", "Domínio próprio exige um plano pago do OpenMail.", status);
	if (code === "spend_cap_paused") throw new EmailProviderError("invalid_request", "O limite de gasto mensal do OpenMail foi atingido.", status);
	if (code === "domain_exists" || code === "domain_taken" || code === "identity_exists") throw new EmailProviderError("domain_exists", "Esse domínio já está cadastrado.", status);
	if (code === "domain_has_inboxes") throw new EmailProviderError("domain_in_use", "Esse domínio ainda tem caixas. Apague as caixas antes.", status);
	if (code === "invalid_domain" || code === "domain_blocked") throw new EmailProviderError("invalid_domain", "Domínio inválido ou não permitido.", status);
}

const DOMAIN_STATUSES: readonly string[] = ["pending", "verifying", "verified", "failed", "under_review"];

function toProviderDomain(raw: unknown): ProviderDomain {
	const d = rec(raw);
	const status = str(d.status);
	return {
		id: str(d.id),
		domain: str(d.domain).toLowerCase(),
		status: (DOMAIN_STATUSES.includes(status) ? status : "pending") as ProviderDomain["status"],
		records: (Array.isArray(d.records) ? d.records : []).map((item) => {
			const r = rec(item);
			const type = str(r.type).toUpperCase();
			return {
				type: (type === "MX" || type === "CNAME" ? type : "TXT") as "TXT" | "CNAME" | "MX",
				name: str(r.name),
				value: str(r.value),
				priority: typeof r.priority === "number" ? r.priority : null,
				valid: r.status === "valid",
			};
		}),
	};
}

function toProviderMessage(raw: unknown): ProviderMessage {
	const m = rec(raw);
	return {
		id: str(m.id),
		threadId: str(m.threadId),
		direction: m.direction === "outbound" ? "out" : "in",
		from: addressOf(m.fromAddr ?? m.from),
		to: addressList(m.toAddr ?? m.to),
		subject: str(m.subject),
		body: str(m.bodyText ?? m.body_text),
		createdAt: str(m.createdAt) || new Date(0).toISOString(),
	};
}

function signatureMatches(secret: string, timestamp: string, rawBody: string, header: string): boolean {
	const provided = header.trim().replace(/^sha256=/i, "");
	const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
	for (const candidate of [Buffer.from(provided, "hex"), Buffer.from(provided, "base64")]) {
		if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) return true;
	}
	return false;
}

export function createOpenMailProvider(deps: OpenMailDeps = {}): EmailProvider {
	const baseUrl = (deps.baseUrl ?? OPENMAIL_BASE_URL).replace(/\/$/, "");
	const fetchFn: FetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));

	async function call(credentials: EmailCredentials, method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; domainErrors?: boolean } = {}): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
		try {
			const response = await fetchFn(`${baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${credentials.apiKey}`,
					Accept: "application/json",
					...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
					...options.headers,
				},
				...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
				signal: controller.signal,
			});
			const text = await response.text();
			if (!response.ok) {
				// Mensagens fixas: nada do upstream (nem a chave) sobe para o chat ou a UI.
				if (options.domainErrors) mapDomainError(response.status, text);
				if (response.status === 401 || response.status === 403) throw new EmailProviderError("auth_failed", "OpenMail recusou a chave. Confira a chave em Configurações.", response.status);
				if (response.status === 404) throw new EmailProviderError("not_found", "Recurso não encontrado no OpenMail.", 404);
				if (response.status === 429) throw new EmailProviderError("rate_limited", "OpenMail limitou o uso agora. Tente de novo em instantes.", 429);
				if (response.status >= 400 && response.status < 500) throw new EmailProviderError("invalid_request", `OpenMail recusou o pedido (${response.status}).`, response.status);
				throw new EmailProviderError("upstream_error", "OpenMail indisponível no momento.", response.status);
			}
			if (!text.trim()) return {};
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new EmailProviderError("upstream_error", "Resposta inesperada do OpenMail.", response.status);
			}
		} catch (error) {
			if (error instanceof EmailProviderError) throw error;
			throw new EmailProviderError("upstream_error", "Não foi possível falar com o OpenMail.");
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		id: "openmail",

		domains: {
			async list(credentials) {
				const result = rec(await call(credentials, "GET", "/v1/domains?limit=100", { domainErrors: true }));
				return (Array.isArray(result.data) ? result.data : []).map(toProviderDomain).filter((d) => d.id && d.domain);
			},
			async add(credentials, domain) {
				const result = toProviderDomain(await call(credentials, "POST", "/v1/domains", { body: { domain }, domainErrors: true }));
				if (!result.id) throw new EmailProviderError("upstream_error", "OpenMail não devolveu o domínio.");
				return result;
			},
			async verify(credentials, domainId) {
				const id = encodeURIComponent(domainId);
				await call(credentials, "POST", `/v1/domains/${id}/verify`, { domainErrors: true });
				// O GET traz o estado e os registros completos depois do re-check.
				const result = toProviderDomain(await call(credentials, "GET", `/v1/domains/${id}`, { domainErrors: true }));
				if (!result.id) throw new EmailProviderError("upstream_error", "OpenMail não devolveu o domínio.");
				return result;
			},
			async remove(credentials, domainId) {
				await call(credentials, "DELETE", `/v1/domains/${encodeURIComponent(domainId)}`, { domainErrors: true });
			},
		},

		async createInbox(credentials, input): Promise<ProviderInbox> {
			const result = rec(
				await call(credentials, "POST", "/v1/inboxes", {
					body: { mailboxName: input.mailboxName ?? suggestMailboxName(input.nameHint), displayName: oneLineHeader(input.displayName, 200), webhookUrl: input.webhookUrl, ...(input.domain ? { domain: input.domain } : {}) },
					domainErrors: Boolean(input.domain),
				}),
			);
			const inboxId = str(result.id);
			const address = normalizeEmailAddress(result.address);
			if (!inboxId || !address) throw new EmailProviderError("upstream_error", "OpenMail não devolveu o endereço da caixa.");
			return { inboxId, address, webhookSecret: str(result.webhookSecret) || null };
		},

		async deleteInbox(credentials, inboxId) {
			await call(credentials, "DELETE", `/v1/inboxes/${encodeURIComponent(inboxId)}`);
		},

		async rotateWebhookSecret(credentials, inboxId) {
			const result = rec(await call(credentials, "POST", `/v1/inboxes/${encodeURIComponent(inboxId)}/webhook/rotate-secret`));
			const secret = str(result.webhookSecret);
			if (!secret) throw new EmailProviderError("upstream_error", "OpenMail não devolveu o segredo do webhook.");
			return secret;
		},

		async send(credentials, input): Promise<ProviderSendResult> {
			const result = rec(
				await call(credentials, "POST", `/v1/inboxes/${encodeURIComponent(input.inboxId)}/send`, {
					body: {
						to: input.to,
						subject: input.subject,
						body: input.body,
						...(input.bodyHtml ? { bodyHtml: input.bodyHtml } : {}),
						...(input.threadId ? { threadId: input.threadId } : {}),
					},
					headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey.slice(0, 200) } : undefined,
				}),
			);
			const status = result.status === "failed" ? "failed" : result.status === "pending" ? "pending" : "sent";
			return { messageId: str(result.providerMessageId) || str(result.messageId), threadId: str(result.threadId), status };
		},

		async listMessages(credentials, inboxId, options = {}) {
			const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, options.limit ?? 20))) });
			if (options.direction) query.set("direction", options.direction === "in" ? "inbound" : "outbound");
			const result = rec(await call(credentials, "GET", `/v1/inboxes/${encodeURIComponent(inboxId)}/messages?${query}`));
			return (Array.isArray(result.data) ? result.data : []).map(toProviderMessage);
		},

		async getThread(credentials, threadId) {
			const result = rec(await call(credentials, "GET", `/v1/threads/${encodeURIComponent(threadId)}/messages`));
			return {
				threadId: str(result.threadId) || threadId,
				subject: str(result.subject),
				messages: (Array.isArray(result.data) ? result.data : []).map(toProviderMessage),
			};
		},

		verifyAndParseWebhook({ rawBody, headers, secret, now = new Date() }): WebhookVerification {
			const timestamp = headers("x-timestamp")?.trim();
			const signature = headers("x-signature")?.trim();
			if (!secret || !timestamp || !signature) return { ok: false, reason: "bad_signature" };
			if (!signatureMatches(secret, timestamp, rawBody, signature)) return { ok: false, reason: "bad_signature" };
			const seconds = Number(timestamp);
			if (!Number.isFinite(seconds) || Math.abs(now.getTime() - seconds * 1000) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
			let payload: Record<string, unknown>;
			try {
				payload = rec(JSON.parse(rawBody));
			} catch {
				return { ok: false, reason: "bad_payload" };
			}
			if (payload.event !== "message.received") return { ok: true, event: null };
			const message = rec(payload.message);
			const providerMessageId = str(message.id);
			const eventId = headers("x-event-id")?.trim() || str(payload.event_id);
			const from = addressOf(message.from);
			if (!providerMessageId || !eventId || !from) return { ok: false, reason: "bad_payload" };
			const attachments = (Array.isArray(message.attachments) ? message.attachments : []).map((raw) => {
				const a = rec(raw);
				return {
					filename: str(a.filename),
					...(str(a.contentType) ? { contentType: str(a.contentType) } : {}),
					...(typeof a.sizeBytes === "number" ? { sizeBytes: a.sizeBytes } : {}),
					text: typeof a.parsedText === "string" ? a.parsedText : null,
				};
			});
			const event: ParsedInboundEmail = {
				eventId,
				inboxId: str(payload.inbox_id),
				providerMessageId,
				threadId: str(payload.thread_id) || providerMessageId,
				from,
				to: addressList(message.to),
				subject: str(message.subject),
				body: str(message.body_text),
				attachments,
				receivedAt: str(message.received_at) || str(payload.occurred_at) || now.toISOString(),
			};
			return { ok: true, event };
		},
	};
}
