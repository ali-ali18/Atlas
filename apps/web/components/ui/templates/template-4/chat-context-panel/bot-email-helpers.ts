import { EMAIL_ALLOWED_SENDERS_MAX, normalizeAllowedSender, type EmailMessageDto } from "@workspace/shared";

export const EMAIL_EMPTY_ALLOWED = "Nenhum remetente permitido: todo e-mail recebido fica bloqueado.";
export const EMAIL_NO_KEY_TEXT = "Falta a chave do OpenMail. Cadastre em Configurações › Avançado › Provedores e chaves.";

/** Linha de texto da direção: quem escreveu (recebido) ou para quem foi (enviado). */
export function emailPeer(message: Pick<EmailMessageDto, "direction" | "from" | "to">): string {
	return message.direction === "in" ? `De ${message.from}` : `Para ${message.to.join(", ")}`;
}

export function emailSubject(message: Pick<EmailMessageDto, "subject">): string {
	return message.subject.trim() || "(sem assunto)";
}

export type EmailStatusBadge = { label: string; tone: "muted" | "danger" } | null;

/** Selo só quando algo merece atenção (bloqueado, falhou). */
export function emailStatusBadge(message: Pick<EmailMessageDto, "status">): EmailStatusBadge {
	if (message.status === "blocked") return { label: "Bloqueado", tone: "danger" };
	if (message.status === "failed") return { label: "Falhou", tone: "danger" };
	return null;
}

/** Só e-mails que chegaram ao bot (ou que ele enviou) têm uma conversa para abrir. */
export function emailOpensConversation(message: Pick<EmailMessageDto, "conversationId" | "status">): boolean {
	return Boolean(message.conversationId) && message.status !== "blocked";
}

export type AddSenderResult = { ok: true; next: string[] } | { ok: false; error: string };

/** Valida o texto digitado e devolve a lista nova (sem duplicar). Aceita endereço ou domínio (@empresa.com). */
export function addAllowedSender(current: readonly string[], raw: string): AddSenderResult {
	const rule = normalizeAllowedSender(raw);
	if (!rule) return { ok: false, error: "Digite um e-mail (ana@empresa.com) ou um domínio (@empresa.com)." };
	if (current.includes(rule)) return { ok: false, error: "Esse remetente já está na lista." };
	if (current.length >= EMAIL_ALLOWED_SENDERS_MAX) return { ok: false, error: `Limite de ${EMAIL_ALLOWED_SENDERS_MAX} remetentes atingido.` };
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

export function moreSendersLabel(count: number): string {
	return `+${count} ${count === 1 ? "remetente" : "remetentes"}`;
}

/** Filtro da página de remetentes (sem acento e sem caixa). */
export function filterAllowedSenders(list: readonly string[], query: string): string[] {
	const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
	const term = fold(query.trim());
	return term ? list.filter((rule) => fold(rule).includes(term)) : [...list];
}
