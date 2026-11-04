import { OWNER_WAIT_CARD_DETAIL, type LoginWaitOutcome } from "@workspace/shared";
import type { ChatCardTone } from "@workspace/ui/components/chat-card";
import { formatDate, formatTime, type DateInput } from "@/lib/format";
import { getActiveTranslator } from "@/lib/i18n/active";
import type { MessageKey, Translator } from "@/lib/i18n/translator";

/**
 * Textos dos cartões que esperam o dono (motor v3, PR8d). Puro: recebe `now` e o tradutor (o fuso é o do navegador,
 * ou `timeZone` nos testes). Nunca mostra cron, minutos crus nem nomes internos: só a frase.
 */

type TimeOptions = { timeZone?: string };

function sameDay(a: Date, b: Date, translator: Translator, options: TimeOptions): boolean {
	const day = (value: Date) => formatDate(value, translator.locale, { day: "2-digit", month: "2-digit", year: "numeric", ...options });
	return day(a) === day(b);
}

function whenParts(at: Date, translator: Translator, options: TimeOptions) {
	return { time: formatTime(at, translator.locale, options), date: formatDate(at, translator.locale, { day: "2-digit", month: "2-digit", ...options }) };
}

const asDate = (value: DateInput): Date | null => {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

/** "Sigo sem isso às 14:30" (mesmo dia) ou "Sigo sem isso em 05/11 às 14:30". Prazo inválido = nada. */
export function ownerWaitDeadlineText(deadlineAt: DateInput, now: Date, translator: Translator = getActiveTranslator(), options: TimeOptions = {}): string | null {
	const at = asDate(deadlineAt);
	if (!at) return null;
	const parts = whenParts(at, translator, options);
	return sameDay(at, now, translator, options) ? translator.t("ownerWait.deadlineToday", parts) : translator.t("ownerWait.deadlineOther", parts);
}

/** "Volto às 14:30" ou "Volto em 05/11 às 14:30" (no idioma da tela, a partir do horário do retorno). */
export function returnMarkerText(at: DateInput, now: Date, translator: Translator = getActiveTranslator(), options: TimeOptions = {}): string {
	const when = asDate(at);
	if (!when) return "";
	const parts = whenParts(when, translator, options);
	return sameDay(when, now, translator, options) ? translator.t("ownerWait.return.today", parts) : translator.t("ownerWait.return.other", parts);
}

export function returnMarkerTime(at: DateInput, translator: Translator = getActiveTranslator(), options: TimeOptions = {}): string {
	const when = asDate(at);
	return when ? formatTime(when, translator.locale, options) : "";
}

const OUTCOME_TONE: Record<LoginWaitOutcome, ChatCardTone> = {
	done: "success",
	takeover: "info",
	skipped: "muted",
	skipped_timeout: "pending",
	ignored: "muted",
};

const OUTCOME_LABEL = {
	done: "ownerWait.outcome.done",
	takeover: "ownerWait.outcome.takeover",
	skipped: "ownerWait.outcome.skipped",
	skipped_timeout: "ownerWait.outcome.skipped_timeout",
	ignored: "ownerWait.outcome.ignored",
} as const satisfies Record<LoginWaitOutcome, MessageKey>;

const OUTCOME_BODY = {
	done: "ownerWait.outcomeBody.done",
	takeover: "ownerWait.outcomeBody.takeover",
	skipped: "ownerWait.outcomeBody.skipped",
	skipped_timeout: "ownerWait.outcomeBody.skipped_timeout",
	ignored: "ownerWait.outcomeBody.ignored",
} as const satisfies Record<LoginWaitOutcome, MessageKey>;

/** Selo do cartão de login/VM depois da resposta do dono. Sem saída gravada (v1/v2) = "Feito". */
export function loginOutcomeBadge(outcome: LoginWaitOutcome | undefined, translator: Translator = getActiveTranslator()): { tone: ChatCardTone; label: string; body: string } {
	const key = outcome ?? "done";
	return {
		tone: OUTCOME_TONE[key],
		label: translator.t(OUTCOME_LABEL[key]),
		body: translator.t(OUTCOME_BODY[key]),
	};
}

/** Detalhe gravado pelo servidor quando o rascunho é descartado (`PREPARED_DISMISSED_DETAIL` da API). */
export const DRAFT_DISCARDED_DETAIL = "Descartado";

/**
 * Como o cartão genérico do v3 fechou, pelo detalhe que o servidor gravou: prazo vencido, ignorado (o dono mandou outra
 * mensagem) ou rascunho descartado. `null` = decisão comum (Permitido / Agora não), que o marcador já sabe dizer.
 */
export function ownerConfirmClosedLabel(detail: string | undefined, translator: Translator = getActiveTranslator()): string | null {
	if (detail === OWNER_WAIT_CARD_DETAIL.skipped_timeout) return translator.t("ownerWait.status.timeout");
	if (detail === OWNER_WAIT_CARD_DETAIL.ignored) return translator.t("ownerWait.status.ignored");
	if (detail === DRAFT_DISCARDED_DETAIL) return translator.t("ownerWait.status.discarded");
	return null;
}

export type ApprovalField = { key: string; label: string; value: string };

type FieldLabelKey = Extract<MessageKey, `ownerWait.field.${string}`>;

const FIELD_LABELS: Readonly<Record<string, FieldLabelKey>> = {
	to: "ownerWait.field.to",
	cc: "ownerWait.field.cc",
	bcc: "ownerWait.field.bcc",
	subject: "ownerWait.field.subject",
	body: "ownerWait.field.body",
	text: "ownerWait.field.text",
	message: "ownerWait.field.message",
	title: "ownerWait.field.title",
	url: "ownerWait.field.url",
	link: "ownerWait.field.url",
	amount: "ownerWait.field.amount",
	name: "ownerWait.field.name",
	description: "ownerWait.field.description",
	date: "ownerWait.field.date",
};

/** `snake_case`/`camelCase` → "Snake case" (campo sem rótulo próprio). */
function humanize(key: string): string {
	const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

const FIELD_LINE = /^([A-Za-z][\w.-]{0,40}): ?(.*)$/;

/**
 * O servidor manda a ação como linhas "campo: valor" (tudo o que entra na aprovação, com o sensível mascarado); no
 * rascunho, a nota da rotina vem antes, separada por uma linha em branco. Aqui vira nota + lista legível (rótulo
 * traduzido para os campos comuns). Linha que não é "campo: valor" continua o valor anterior (texto com quebras).
 */
export function parseApprovalDetails(description: string | undefined, hasNote: boolean, translator: Translator = getActiveTranslator()): { note?: string; fields: ApprovalField[] } {
	const text = (description ?? "").trim();
	if (!text) return { fields: [] };
	let note: string | undefined;
	let body = text;
	if (hasNote) {
		const split = text.indexOf("\n\n");
		note = (split >= 0 ? text.slice(0, split) : text).trim() || undefined;
		body = split >= 0 ? text.slice(split + 2) : "";
	}
	const fields: ApprovalField[] = [];
	for (const line of body.split("\n")) {
		const match = FIELD_LINE.exec(line);
		if (match) {
			const key = match[1]!;
			const labelKey = FIELD_LABELS[key.toLowerCase()];
			fields.push({ key, label: labelKey ? translator.t(labelKey) : humanize(key), value: match[2] ?? "" });
			continue;
		}
		const last = fields.at(-1);
		if (last) last.value = `${last.value}\n${line}`;
		else if (line.trim() && line.trim() !== "(sem argumentos)") fields.push({ key: "", label: "", value: line });
	}
	return { ...(note ? { note } : {}), fields: fields.map((field) => ({ ...field, value: field.value.trim() })) };
}
