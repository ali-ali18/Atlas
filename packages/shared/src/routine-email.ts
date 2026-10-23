/**
 * Gatilho "chegou e-mail" de uma rotina: dispara quando um e-mail permitido chega na caixa do próprio bot
 * (ver `email.ts`). Os filtros são opcionais, "contém" e sem diferenciar maiúsculas. O conteúdo do e-mail
 * vai para a execução como dado externo não confiável (`buildEmailEventEnvelope` + `formatEventBlock`).
 */
import type { EventEnvelope } from "./events/triggers.js";
import { INBOUND_EMAIL_CLOSE, INBOUND_EMAIL_OPEN, oneLineHeader, stripQuotedReply } from "./email.js";

export const EMAIL_TRIGGER_FILTER_MAX = 120;
/** Texto do e-mail que entra no evento da rotina (o resto fica no provedor). */
export const EMAIL_EVENT_BODY_MAX_CHARS = 6_000;
export const EMAIL_EVENT_PROVIDER = "email";
export const EMAIL_EVENT_TYPE = "email.received";

export type EmailTriggerJson = {
	kind: "email";
	/** Trecho do remetente (endereço ou domínio). Ausente = qualquer remetente permitido. */
	fromContains?: string;
	/** Trecho do assunto. Ausente = qualquer assunto. */
	subjectContains?: string;
};

export type RoutineEmailTriggerView = { fromContains?: string; subjectContains?: string };

export type EmailTriggerInput = { fromContains?: string; subjectContains?: string };

function cleanFilter(raw: unknown, label: string): { value?: string } | { error: string } {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "string") return { error: `${label} deve ser texto` };
	// eslint-disable-next-line no-control-regex
	const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	if (!text) return {};
	if (text.length > EMAIL_TRIGGER_FILTER_MAX) return { error: `${label} muito longo (máx. ${EMAIL_TRIGGER_FILTER_MAX} caracteres)` };
	return { value: text };
}

/** Valida os filtros vindos da tool/API. Os dois são opcionais; vazio vira "sem filtro". */
export function parseEmailTriggerInput(raw: unknown): { value: EmailTriggerInput } | { error: string } {
	const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const from = cleanFilter(row.fromContains ?? row.from_contains, "from_contains");
	if ("error" in from) return from;
	const subject = cleanFilter(row.subjectContains ?? row.subject_contains, "subject_contains");
	if ("error" in subject) return subject;
	return { value: { ...(from.value ? { fromContains: from.value } : {}), ...(subject.value ? { subjectContains: subject.value } : {}) } };
}

export function isEmailTrigger(value: unknown): value is EmailTriggerJson {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	if (row.kind !== "email") return false;
	return "value" in parseEmailTriggerInput(row);
}

export function normalizeEmailTrigger(value: unknown): EmailTriggerJson | null {
	if (!isEmailTrigger(value)) return null;
	const parsed = parseEmailTriggerInput(value);
	return "value" in parsed ? { kind: "email", ...parsed.value } : null;
}

export function emailTriggerToView(trigger: EmailTriggerJson): RoutineEmailTriggerView {
	return {
		...(trigger.fromContains ? { fromContains: trigger.fromContains } : {}),
		...(trigger.subjectContains ? { subjectContains: trigger.subjectContains } : {}),
	};
}

/** Decisão pura: o e-mail passa nos filtros do gatilho? */
export function emailTriggerMatches(trigger: EmailTriggerInput, email: { from: string; subject: string }): boolean {
	const from = trigger.fromContains?.toLowerCase();
	if (from && !email.from.toLowerCase().includes(from)) return false;
	const subject = trigger.subjectContains?.toLowerCase();
	if (subject && !email.subject.toLowerCase().includes(subject)) return false;
	return true;
}

/** "Quando chegar e-mail de fornecedor@… com 'NF' no assunto". */
export function describeEmailTrigger(trigger: EmailTriggerInput): string {
	const parts = ["Quando chegar e-mail"];
	if (trigger.fromContains) parts.push(`de ${trigger.fromContains}`);
	if (trigger.subjectContains) parts.push(`com '${trigger.subjectContains}' no assunto`);
	return parts.join(" ");
}

export type EmailEventPayload = {
	from: string;
	subject: string;
	threadId: string;
	body: string;
	attachments: string[];
};

/** Troca os delimitadores para o conteúdo externo não fechar sozinho o bloco que o cerca. */
function neutralize(text: string): string {
	return text.replaceAll("EMAIL_EXTERNO", "EMAIL EXTERNO");
}

/** Evento da rotina para um e-mail recebido: texto limpo (sem citação), com teto de tamanho. */
export function buildEmailEventEnvelope(input: {
	mailboxId: string;
	providerMessageId: string;
	from: string;
	subject: string;
	threadId: string;
	body: string;
	attachmentNames?: string[];
	occurredAt: string;
}): EventEnvelope {
	const payload: EmailEventPayload = {
		from: oneLineHeader(input.from, 254),
		subject: oneLineHeader(input.subject),
		threadId: oneLineHeader(input.threadId, 200),
		body: neutralize(stripQuotedReply(input.body).trim()).slice(0, EMAIL_EVENT_BODY_MAX_CHARS),
		attachments: (input.attachmentNames ?? []).slice(0, 5).map((name) => oneLineHeader(name, 120)),
	};
	return {
		provider: EMAIL_EVENT_PROVIDER,
		type: EMAIL_EVENT_TYPE,
		occurredAt: input.occurredAt,
		idempotencyKey: `email:${input.mailboxId}:${input.providerMessageId}`.slice(0, 300),
		refs: { mailboxId: input.mailboxId, threadId: payload.threadId },
		payload,
	};
}

export function isEmailEventPayload(value: unknown): value is EmailEventPayload {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return typeof row.from === "string" && typeof row.subject === "string" && typeof row.body === "string" && typeof row.threadId === "string";
}

/** Linhas `chave=valor` + corpo entre delimitadores — deixa óbvio que é dado do remetente, não instrução. */
export function formatEmailEventFields(event: EmailEventPayload): string {
	const lines = [`from=${event.from}`, `subject=${event.subject || "(no subject)"}`, `thread=${event.threadId}`];
	if (event.attachments?.length) lines.push(`attachments=${event.attachments.join(", ")}`);
	lines.push(INBOUND_EMAIL_OPEN, event.body || "(no text)", INBOUND_EMAIL_CLOSE);
	return lines.join("\n");
}
