import { EMAIL_ALLOWED_SENDERS_MAX, normalizeAllowedSender, type EmailMessageDto } from "@workspace/shared";

import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/** Textos padrão (pt-BR); a tela usa `botSettings.email.emptyAllowed` e `.noKey` no idioma dela. */
export const EMAIL_EMPTY_ALLOWED = defaultTranslator.t("botSettings.email.emptyAllowed");
export const EMAIL_NO_KEY_TEXT = defaultTranslator.t("botSettings.email.noKey");

/** Linha de texto da direção: quem escreveu (recebido) ou para quem foi (enviado). */
export function emailPeer(message: Pick<EmailMessageDto, "direction" | "from" | "to">, { t }: Translator = defaultTranslator): string {
	return message.direction === "in" ? t("botSettings.email.from", { from: message.from }) : t("botSettings.email.to", { to: message.to.join(", ") });
}

export function emailSubject(message: Pick<EmailMessageDto, "subject">, { t }: Translator = defaultTranslator): string {
	return message.subject.trim() || t("botSettings.email.noSubject");
}

export type EmailStatusBadge = { label: string; tone: "muted" | "danger" } | null;

/** Selo só quando algo merece atenção (bloqueado, falhou). */
export function emailStatusBadge(message: Pick<EmailMessageDto, "status">, { t }: Translator = defaultTranslator): EmailStatusBadge {
	if (message.status === "blocked") return { label: t("botSettings.email.blocked"), tone: "danger" };
	if (message.status === "failed") return { label: t("botSettings.email.failed"), tone: "danger" };
	return null;
}

/** Só e-mails que chegaram ao bot (ou que ele enviou) têm uma conversa para abrir. */
export function emailOpensConversation(message: Pick<EmailMessageDto, "conversationId" | "status">): boolean {
	return Boolean(message.conversationId) && message.status !== "blocked";
}

export type AddSenderResult = { ok: true; next: string[] } | { ok: false; error: string };

/** Valida o texto digitado e devolve a lista nova (sem duplicar). Aceita endereço ou domínio (@empresa.com). */
export function addAllowedSender(current: readonly string[], raw: string, { t }: Translator = defaultTranslator): AddSenderResult {
	const rule = normalizeAllowedSender(raw);
	if (!rule) return { ok: false, error: t("botSettings.email.errInvalid") };
	if (current.includes(rule)) return { ok: false, error: t("botSettings.email.errDuplicate") };
	if (current.length >= EMAIL_ALLOWED_SENDERS_MAX) return { ok: false, error: t("botSettings.email.errMax", { max: EMAIL_ALLOWED_SENDERS_MAX }) };
	return { ok: true, next: [...current, rule] };
}

export function parseDailyLimit(raw: string): number | null {
	if (!/^\d{1,3}$/.test(raw.trim())) return null;
	const value = Number(raw.trim());
	return value <= 200 ? value : null;
}

/** Quantos remetentes recentes aparecem ao expandir a lista na aba. */
export const EMAIL_RECENT_SENDERS = 4;

export type SenderPreview = { first: string | null; recent: string[]; more: number };

/**
 * Resumo da lista para a aba: o primeiro remetente fica sempre visível; "recentes" são os últimos
 * adicionados (a API não guarda data, então o fim da lista é o mais recente), sem repetir o primeiro.
 * `more` é quantos ficam atrás do "+N remetentes".
 */
export function previewAllowedSenders(list: readonly string[]): SenderPreview {
	if (list.length === 0) return { first: null, recent: [], more: 0 };
	const rest = list.slice(1);
	return { first: list[0] ?? null, recent: rest.slice(-EMAIL_RECENT_SENDERS).reverse(), more: rest.length };
}

export function moreSendersLabel(count: number, { tn }: Translator = defaultTranslator): string {
	return tn("botSettings.email.moreSenders", count);
}

/** "1 remetente" / "N remetentes". */
export function sendersCountLabel(count: number, { tn }: Translator = defaultTranslator): string {
	return tn("botSettings.email.senders", count);
}

/** Filtro da página de remetentes (sem acento e sem caixa). */
export function filterAllowedSenders(list: readonly string[], query: string): string[] {
	const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	const term = fold(query.trim());
	return term ? list.filter((rule) => fold(rule).includes(term)) : [...list];
}
