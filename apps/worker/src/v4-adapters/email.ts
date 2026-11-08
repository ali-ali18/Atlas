// Portas de e-mail do v4 no worker (F7.1): o Gmail do dono (OAuth do conector embutido, token no cofre da conexão, renovado
// por `getFreshAccessToken`) e a caixa própria do bot (OpenMail, `emailService`). Montado POR RUN: dono, bot e conversa vêm do
// run, nunca de argumento do modelo.
//
// Escopo (IDOR): o Gmail vem de `listConnectedMcpConnections(userId)` (filtra pelo dono); a caixa do bot, de
// `getMailboxForBot(botId, userId)` (bot do run + dono). Pedir a conta de outro dono ou de outro bot devolve `null`, e a tool
// responde "não conectada" sem dizer que existe. `userId` diferente do dono do run também recusa.
//
// Segredo: o access token só vive dentro de `googleCall`. Toda mensagem de erro passa por `redactSecrets` com o token, e a
// mensagem ao modelo nunca repete o corpo cru do Google. O envio do Gmail precisa do escopo `gmail.send`; sem ele o Google
// responde 403 e a tool falha honesta com a dica de reconectar (e oferece o rascunho).
import type { EmailAccount, EmailAccountInfo, EmailAccounts, EmailCards, EmailDraftInput, EmailListQuery, EmailMessageContent, EmailMessageSummary, EmailPorts } from "@workspace/agent";
import { getMailboxForBot, listConnectedMcpConnections, persistConversationCardFromEvent, type BotMailboxRecord } from "@workspace/db";
import { redactSecrets, replySubject, type ComputerUseEvent, type EmailSourceId } from "@workspace/shared";
import type { GoogleApiContext, GoogleFetchFn } from "@workspace/agent-runtime";

type McpRecord = Awaited<ReturnType<typeof listConnectedMcpConnections>>[number];

/** O que o adaptador usa do serviço de e-mail do bot (`emailService` do agent-runtime). */
export type V4BotMailService = {
	prepareSend(request: { mailbox: BotMailboxRecord; threadId?: string; to?: string; subject?: string; body: string }): Promise<{ to: string; subject: string; body: string; threadId?: string; newRecipient: boolean }>;
	deliver(input: { mailbox: BotMailboxRecord; prepared: Awaited<ReturnType<V4BotMailService["prepareSend"]>>; idempotencyKey?: string }): Promise<{ threadId: string; messageId: string; to: string; subject: string }>;
	listFromProvider(mailbox: BotMailboxRecord, options?: { limit?: number; direction?: "in" | "out" }): Promise<Array<{ id: string; threadId: string; direction: "in" | "out"; from: string; to: string[]; subject: string; body: string; createdAt: string }>>;
	readThread(mailbox: BotMailboxRecord, threadId: string): Promise<{ threadId: string; subject: string; messages: Array<{ id: string; from: string; to: string[]; body: string; createdAt: string }> }>;
};

export type V4EmailDeps = {
	listConnected: (userId: string) => Promise<McpRecord[]>;
	/** Token de acesso da conexão (do cofre, renovado se preciso). Lança se não houver login. */
	accessToken: (record: McpRecord) => Promise<string>;
	googleFetch: GoogleFetchFn;
	googleJson: <T>(ctx: GoogleApiContext, url: string, init?: RequestInit) => Promise<T>;
	getMailbox: (botId: string, userId: string) => Promise<BotMailboxRecord | null>;
	botMail: () => Promise<V4BotMailService>;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

// O pacote do v2 é pesado: só carrega na primeira chamada que precisa (e os testes unitários nem o tocam).
export const realV4EmailDeps: V4EmailDeps = {
	listConnected: listConnectedMcpConnections,
	accessToken: async (record) => {
		const runtime = await import("@workspace/agent-runtime");
		if (!record.secretsEnc) throw new Error("The Gmail connection has no login. Hint: ask the owner to reconnect Gmail in Apps.");
		const config = runtime.buildMcpClientConfig(record, runtime.openSecrets(record.secretsEnc));
		if (!config.builtin) throw new Error("The Gmail connection has no login. Hint: ask the owner to reconnect Gmail in Apps.");
		return config.builtin.getAccessToken();
	},
	googleFetch: (url, init) => fetch(url, init),
	googleJson: async (ctx, url, init) => (await import("@workspace/agent-runtime")).googleJson(ctx, url, init),
	getMailbox: getMailboxForBot,
	botMail: async () => (await import("@workspace/agent-runtime")).emailService as unknown as V4BotMailService,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4EmailScope = {
	/** Dono do run (a sessão). */
	ownerId: string;
	botId?: string | null;
	conversationId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SNIPPET_CHARS = 200;

// ---------------------------------------------------------------- Gmail: funções puras

const unquote = (value: string): string => value.replace(/["\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
const gmailDay = (day: string): string => day.replaceAll("-", "/");

/** Consulta do Gmail a partir do filtro estruturado. Valores entram entre aspas, sem aspas internas (nada vira operador). */
export function gmailQuery(query: Pick<EmailListQuery, "unread" | "from" | "subject" | "since" | "until">): string {
	const parts: string[] = [];
	if (query.unread) parts.push("is:unread");
	if (query.from) parts.push(`from:"${unquote(query.from)}"`);
	if (query.subject) parts.push(`subject:"${unquote(query.subject)}"`);
	if (query.since) parts.push(`after:${gmailDay(query.since)}`);
	if (query.until) parts.push(`before:${gmailDay(query.until)}`);
	// Sem remetente nem assunto, "meu e-mail" é a caixa de entrada; com eles, busca em tudo (menos spam e lixeira).
	if (!query.from && !query.subject) parts.push("in:inbox");
	return parts.join(" ");
}

type GmailHeader = { name: string; value: string };
type GmailPart = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id: string; threadId?: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart & { headers?: GmailHeader[] } };

const header = (message: GmailMessage, name: string): string => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const isoOrEpoch = (ms: number): string => new Date(Number.isFinite(ms) ? ms : 0).toISOString();
const decodeB64 = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
	if (!part) return undefined;
	if (part.mimeType === mimeType && part.body?.data) return part;
	for (const child of part.parts ?? []) {
		const found = findPart(child, mimeType);
		if (found) return found;
	}
	return undefined;
}

function attachmentNames(part: GmailPart | undefined): string[] {
	if (!part) return [];
	return [...(part.filename ? [part.filename] : []), ...(part.parts ?? []).flatMap(attachmentNames)];
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

/** HTML do e-mail em texto: tira estilo e script, quebra em blocos e decodifica as entidades comuns. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

/** Corpo em texto: `text/plain` se houver, senão o HTML convertido. */
export function gmailBodyText(payload: GmailPart | undefined): string {
	const plain = findPart(payload, "text/plain");
	if (plain?.body?.data) return decodeB64(plain.body.data);
	const html = findPart(payload, "text/html");
	if (html?.body?.data) return htmlToText(decodeB64(html.body.data));
	if (payload?.body?.data) return decodeB64(payload.body.data);
	return "";
}

const mimeHeader = (value: string): string => {
	const clean = value.replace(/[\r\n\u0000-\u001f]+/g, " ").trim();
	// eslint-disable-next-line no-control-regex -- detecta qualquer caractere fora de ASCII
	return /^[\x00-\x7F]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
};

/** Mensagem RFC 5322 em base64url para o Gmail. Cabeçalhos sem quebra de linha; corpo em base64 (acentos e CRLF seguros). */
export function buildGmailRaw(input: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string; references?: string }): string {
	const lines = [
		`To: ${input.to.join(", ")}`,
		...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
		`Subject: ${mimeHeader(input.subject)}`,
		...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]+/g, " ")}`, `References: ${(input.references ?? input.inReplyTo).replace(/[\r\n]+/g, " ")}`] : []),
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		Buffer.from(input.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
	];
	return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

// ---------------------------------------------------------------- erros (sem segredo, com dica)

const RECONNECT = "ask the owner to reconnect Gmail in Apps";

/** Mensagem ao modelo, em inglês, sem o corpo cru do Google e sem o token. */
export function gmailErrorMessage(error: unknown, action: "read" | "send" | "draft", token?: string): string {
	// A classe do SDK não define `name`: o construtor é o sinal estável.
	const name = error instanceof Error ? error.constructor.name : "";
	const status = typeof error === "object" && error !== null && "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : undefined;
	const raw = error instanceof Error ? error.message : String(error);
	if (name === "UnauthorizedError") return `The Gmail login expired or was revoked. Hint: ${RECONNECT}.`;
	if (status === 403) {
		const missingScope = raw.toLowerCase().includes("insufficient");
		if (missingScope && action === "send") return `The Gmail connection does not have permission to send e-mail. Hint: ${RECONNECT} to allow sending, and offer to save a draft (email_draft) instead.`;
		if (missingScope) return `The Gmail connection is missing a permission. Hint: ${RECONNECT}.`;
		return "Gmail refused the request (access denied). Hint: check that the connected Google account can use Gmail.";
	}
	if (status === 404) return "Message not found. Hint: use an id from email_list.";
	if (status === 429) return "Gmail is limiting requests right now. Hint: try again in a few minutes.";
	if (error instanceof Error && error.message.startsWith(NO_LOGIN_PREFIX)) return redact(error.message, token);
	return redact(`Gmail failed: ${raw}`, token).slice(0, 300);
}

const NO_LOGIN_PREFIX = "The Gmail connection has no login";

/** Login do Gmail ausente, expirado ou revogado (o dono precisa reconectar). */
export function isGmailLoginProblem(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const status = "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : undefined;
	return error.constructor.name === "UnauthorizedError" || status === 401 || error.message.startsWith(NO_LOGIN_PREFIX);
}

const redact = (text: string, token?: string): string => redactSecrets(text, token ? [token] : []);

// ---------------------------------------------------------------- fonte Gmail

function openGmail(scope: V4EmailScope, deps: V4EmailDeps, record: McpRecord): EmailAccount {
	let token: string | undefined;
	const api: GoogleApiContext = {
		getAccessToken: async () => (token = await deps.accessToken(record)),
		fetchFn: deps.googleFetch,
	};
	const info: EmailAccountInfo = { source: "gmail", label: "Gmail", ...(record.accountLabel && { address: record.accountLabel }) };
	const guard = (userId: string): void => {
		if (userId !== scope.ownerId) throw new Error("The Gmail account is not connected.");
	};
	async function call<T>(action: "read" | "send" | "draft", run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			const failure = new Error(gmailErrorMessage(error, action, token));
			// Sinal estrutural para quem consome a porta (o brief distingue "reconectar" de "falhou").
			if (isGmailLoginProblem(error)) Object.assign(failure, { code: "needs_connection" });
			throw failure;
		}
	}
	const get = <T>(path: string, signal?: AbortSignal) => deps.googleJson<T>(api, `${GMAIL_API}${path}`, signal ? { signal } : undefined);
	const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
		deps.googleJson<T>(api, `${GMAIL_API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(signal && { signal }) });

	const summary = (message: GmailMessage): EmailMessageSummary => ({
		id: message.id,
		...(message.threadId && { threadId: message.threadId }),
		from: header(message, "From"),
		subject: header(message, "Subject") || "(no subject)",
		snippet: (message.snippet ?? "").slice(0, SNIPPET_CHARS),
		date: isoOrEpoch(message.internalDate ? Number(message.internalDate) : Date.parse(header(message, "Date"))),
		unread: message.labelIds?.includes("UNREAD") === true,
	});

	/** Cabeçalhos da mensagem a responder: conversa, assunto e Message-ID para o encadeamento. */
	async function replyContext(id: string, signal?: AbortSignal) {
		const params = ["Subject", "Message-ID", "References"].map((h) => `metadataHeaders=${h}`).join("&");
		const original = await get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=metadata&${params}`, signal);
		const messageId = header(original, "Message-ID");
		const references = header(original, "References");
		return { threadId: original.threadId, subject: replySubject(header(original, "Subject")), ...(messageId && { inReplyTo: messageId, references: [references, messageId].filter(Boolean).join(" ") }) };
	}

	async function rawFor(draft: EmailDraftInput, signal?: AbortSignal) {
		const reply = draft.inReplyTo ? await replyContext(draft.inReplyTo, signal) : undefined;
		const subject = draft.subject ?? reply?.subject;
		if (!subject) throw new Error("A new message needs a subject. Hint: give subject.");
		const raw = buildGmailRaw({ to: draft.to, ...(draft.cc && { cc: draft.cc }), subject, body: draft.body, ...(reply?.inReplyTo && { inReplyTo: reply.inReplyTo, references: reply.references }) });
		return { raw, threadId: reply?.threadId, subject };
	}

	return {
		info,
		async list(userId, query, signal) {
			guard(userId);
			return call("read", async () => {
				const url = new URLSearchParams({ q: gmailQuery(query), maxResults: String(query.limit) });
				const found = await get<{ messages?: Array<{ id: string }> }>(`/messages?${url.toString()}`, signal);
				const refs = found.messages ?? [];
				const metadata = ["From", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
				const messages = await Promise.all(refs.map((ref) => get<GmailMessage>(`/messages/${encodeURIComponent(ref.id)}?format=metadata&${metadata}`, signal)));
				return { messages: messages.map(summary) };
			});
		},
		async read(userId, id, signal) {
			guard(userId);
			return call("read", async () => {
				const message = await get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`, signal);
				const content: EmailMessageContent = {
					...summary(message),
					to: splitAddresses(header(message, "To")),
					cc: splitAddresses(header(message, "Cc")),
					body: gmailBodyText(message.payload),
					attachments: attachmentNames(message.payload),
				};
				return content;
			});
		},
		async createDraft(userId, draft, signal) {
			guard(userId);
			return call("draft", async () => {
				const { raw, threadId, subject } = await rawFor(draft, signal);
				const created = await post<{ id: string }>("/drafts", { message: { raw, ...(threadId && { threadId }) } }, signal);
				return { saved: true, draftId: created.id, to: draft.to, ...(draft.cc && { cc: draft.cc }), subject };
			});
		},
		// O Gmail não tem chave de idempotência no envio: quem impede o envio duplo é o journal do kernel (efeito iniciado ou concluído não roda de novo).
		async send(userId, message, signal) {
			guard(userId);
			return call("send", async () => {
				const { raw, threadId, subject } = await rawFor(message, signal);
				const sent = await post<{ id: string; threadId?: string }>("/messages/send", { raw, ...(threadId && { threadId }) }, signal);
				return { messageId: sent.id, ...(sent.threadId && { threadId: sent.threadId }), to: message.to, subject };
			});
		},
	};
}

/** `"Ana" <ana@x.test>, b@y.test` em endereços soltos (para o cartão e o resumo). */
function splitAddresses(value: string): string[] {
	return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------- fonte: caixa do bot

type BotError = { code?: string; message?: string };

/** Erros do `emailService` (pt-BR, feitos para o dono) viram texto em inglês para o modelo, com a dica certa. */
export function botMailErrorMessage(error: unknown): string {
	const { code, message } = (error ?? {}) as BotError;
	switch (code) {
		case "daily_limit":
			return "The bot mailbox reached its daily send limit. Hint: tell the owner the limit can be raised in the bot's E-mail settings, or try tomorrow.";
		case "disabled":
			return "The bot's mailbox is turned off. Hint: the owner can turn it on in the bot's E-mail settings.";
		case "bad_recipient":
			return "That recipient is not valid for the bot mailbox (it cannot write to its own address). Hint: check the address.";
		case "bad_content":
			return "The message content was refused (empty or too long). Hint: shorten the text and give a subject.";
		case "no_thread":
			return "That conversation was not found in the bot mailbox. Hint: use an id from email_list.";
		case "not_configured":
		case "vault_unavailable":
			return "The e-mail provider is not set up for this account. Hint: the owner must add the provider key in settings.";
		default:
			return `The mailbox provider failed${typeof message === "string" && message ? `: ${redact(message).slice(0, 200)}` : ""}.`;
	}
}

const norm = (address: string): string => address.trim().toLowerCase();

function openBotMailbox(scope: V4EmailScope, deps: V4EmailDeps, mailbox: BotMailboxRecord): EmailAccount {
	const info: EmailAccountInfo = { source: "bot", label: "Bot mailbox", address: mailbox.address };
	const guard = (userId: string): void => {
		if (userId !== scope.ownerId || mailbox.userId !== scope.ownerId) throw new Error("The bot mailbox is not connected.");
	};
	async function call<T>(run: (service: V4BotMailService) => Promise<T>): Promise<T> {
		try {
			return await run(await deps.botMail());
		} catch (error) {
			if (error instanceof Error && !("code" in error)) throw error;
			throw new Error(botMailErrorMessage(error));
		}
	}
	/** A caixa envia a UM destinatário; em resposta, é quem escreveu na conversa (nunca o que o modelo inventa). */
	async function prepare(service: V4BotMailService, draft: EmailDraftInput) {
		if (draft.to.length !== 1 || (draft.cc && draft.cc.length > 0)) throw new Error("The bot mailbox sends to one recipient at a time and has no Cc. Hint: write one message per recipient.");
		const request = draft.inReplyTo
			? { mailbox, threadId: draft.inReplyTo, body: draft.body }
			: { mailbox, to: draft.to[0]!, body: draft.body, ...(draft.subject && { subject: draft.subject }) };
		const prepared = await service.prepareSend(request);
		if (norm(prepared.to) !== norm(draft.to[0]!)) throw new Error(`In a reply the recipient is the person who wrote in the conversation (${prepared.to}). Hint: use that address as to.`);
		return prepared;
	}
	return {
		info,
		async list(userId, query) {
			guard(userId);
			return call(async (service) => {
				const wanted = await service.listFromProvider(mailbox, { limit: 100, direction: "in" });
				const from = query.from ? norm(query.from) : undefined;
				const subject = query.subject ? norm(query.subject) : undefined;
				const since = query.since ? Date.parse(`${query.since}T00:00:00Z`) : undefined;
				const until = query.until ? Date.parse(`${query.until}T00:00:00Z`) : undefined;
				const newestPerThread = new Map<string, (typeof wanted)[number]>();
				for (const m of wanted) {
					const at = Date.parse(m.createdAt);
					if ((from && !norm(m.from).includes(from)) || (subject && !norm(m.subject).includes(subject)) || (since !== undefined && at < since) || (until !== undefined && at >= until)) continue;
					const known = newestPerThread.get(m.threadId);
					if (!known || Date.parse(known.createdAt) < at) newestPerThread.set(m.threadId, m);
				}
				const messages: EmailMessageSummary[] = [...newestPerThread.values()]
					.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
					.slice(0, query.limit)
					.map((m) => ({ id: m.threadId, threadId: m.threadId, from: m.from, subject: m.subject || "(no subject)", snippet: m.body.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS), date: new Date(m.createdAt).toISOString() }));
				return { messages, ...(query.unread && { unsupported: ["unread"] }) };
			});
		},
		async read(userId, id) {
			guard(userId);
			return call(async (service) => {
				const thread = await service.readThread(mailbox, id);
				const ordered = [...thread.messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
				const last = ordered[ordered.length - 1];
				if (!last) throw new Error("That conversation has no messages.");
				const body = ordered.map((m) => `From: ${m.from} | ${m.createdAt}\n${m.body}`).join("\n\n---\n\n");
				return { id: thread.threadId, threadId: thread.threadId, from: last.from, to: last.to, cc: [], subject: thread.subject || "(no subject)", snippet: "", date: new Date(last.createdAt).toISOString(), body, attachments: [] };
			});
		},
		async createDraft(userId, draft) {
			guard(userId);
			return call(async (service) => {
				const prepared = await prepare(service, draft);
				// Não há pasta de rascunhos na caixa do bot: o rascunho é o cartão.
				return { saved: false, to: [prepared.to], subject: prepared.subject };
			});
		},
		async send(userId, message, _signal, options) {
			guard(userId);
			return call(async (service) => {
				const prepared = await prepare(service, message);
				// `deliver` confere o limite diário e registra a mensagem. A pergunta de "destinatário novo" é o próprio cartão de aprovação.
				// A chave da chamada vai ao provedor: repetir o mesmo pedido não manda o e-mail duas vezes.
				const sent = await service.deliver({ mailbox, prepared, ...(options?.idempotencyKey && { idempotencyKey: options.idempotencyKey }) });
				return { messageId: sent.messageId, threadId: sent.threadId, to: [sent.to], subject: sent.subject };
			});
		},
	};
}

// ---------------------------------------------------------------- portas

export function createV4Email(input: { scope: V4EmailScope; deps?: V4EmailDeps }): EmailPorts {
	const deps = input.deps ?? realV4EmailDeps;
	const { scope } = input;

	async function gmailRecord(userId: string): Promise<McpRecord | undefined> {
		if (userId !== scope.ownerId) return undefined;
		return (await deps.listConnected(userId)).find((record) => record.catalogId === "gmail");
	}
	async function botMailbox(userId: string): Promise<BotMailboxRecord | null> {
		if (userId !== scope.ownerId || !scope.botId) return null;
		const mailbox = await deps.getMailbox(scope.botId, userId);
		return mailbox?.enabled ? mailbox : null;
	}

	const accounts: EmailAccounts = {
		async list(userId) {
			const found: EmailAccountInfo[] = [];
			// Falha ao consultar uma fonte não esconde a outra: o log técnico registra (sem segredo).
			const [gmail, mailbox] = await Promise.all([gmailRecord(userId).catch(() => undefined), botMailbox(userId).catch(() => null)]);
			if (gmail) found.push({ source: "gmail", label: "Gmail", ...(gmail.accountLabel && { address: gmail.accountLabel }) });
			if (mailbox) found.push({ source: "bot", label: "Bot mailbox", address: mailbox.address });
			return found;
		},
		async open(userId, source: EmailSourceId) {
			if (source === "gmail") {
				const record = await gmailRecord(userId);
				return record ? openGmail(scope, deps, record) : null;
			}
			const mailbox = await botMailbox(userId);
			return mailbox ? openBotMailbox(scope, deps, mailbox) : null;
		},
	};

	// Cartão gravado e emitido uma vez por identidade dentro do run; a retomada cai no dedupe do db e do merge da conversa.
	const shown = new Set<string>();
	async function showCard(event: Extract<ComputerUseEvent, { type: "email_triage" | "email_draft" }>): Promise<void> {
		if (shown.has(event.cardId)) return;
		shown.add(event.cardId);
		if (scope.conversationId) {
			await deps.persistCard(scope.conversationId, event).catch((error: unknown) => {
				(scope.log ?? console.warn)(`[engine-v4] cartão "${event.type}" não gravado na conversa: ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
			});
		}
		await scope.emit(event);
	}
	const cards: EmailCards = {
		showTriage: (_userId, runId, card) => showCard({ type: "email_triage", ...card, runId }),
		showDraft: (_userId, runId, card) => showCard({ type: "email_draft", ...card, runId }),
	};

	return { accounts, cards };
}
