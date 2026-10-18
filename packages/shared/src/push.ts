/**
 * Notificações push (Web Push/PWA): tipos, texto da notificação, coalescência e validação da
 * inscrição. Funções puras; o envio e o armazenamento vivem em @workspace/db e @workspace/mail.
 */
import { isCardConfirmToken } from "./conversation-task.js";

export type PushKind = "run-finished" | "needs-user" | "coding-failed" | "reminder" | "test";

/** Ícones do app (gerados em /icons). */
export const PUSH_ICON = "/icons/icon-192.png";
export const PUSH_BADGE = "/icons/badge-72.png";

/** Quem está olhando a conversa manda um sinal a cada 20s; vale 45s (um sinal perdido não derruba). */
export const VIEWING_HEARTBEAT_MS = 20_000;
export const VIEWING_TTL_MS = 45_000;
/** No máximo uma notificação por conversa nesta janela (as seguintes só passam se forem mais urgentes). */
export const COALESCE_WINDOW_MS = 30_000;

const BODY_MAX = 140;
const TITLE_MAX = 80;

export type PushPayload = {
	title: string;
	body: string;
	/** Igual para a mesma conversa: a notificação nova substitui a anterior. */
	tag: string;
	/** Para onde o toque leva (conversa e, se houver, o cartão pendente). */
	url: string;
	conversationId: string;
	botId: string | null;
	kind: PushKind;
	cardId: string | null;
	icon: string;
	badge: string;
	/** Instante do evento (ms). */
	ts: number;
};

/** Primeira linha não vazia, sem markdown simples, cortada com reticências. */
export function firstLine(text: string | null | undefined, max = BODY_MAX): string {
	for (const raw of (text ?? "").split("\n")) {
		const line = raw
			.trim()
			.replace(/^(#{1,6}|[-*>]+|\d+[.)])\s+/, "")
			.split("**")
			.join("")
			.split("`")
			.join("")
			.trim();
		if (line) return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
	}
	return "";
}

/** Mensagem do protocolo dos cartões ("confirmado: …", "cancela isso"): nunca vira notificação. */
export function isProtocolText(text: string | null | undefined): boolean {
	const trimmed = (text ?? "").trim();
	if (!trimmed) return false;
	return isCardConfirmToken(trimmed) || trimmed.split("\n")[0]!.trim().toLowerCase() === "cancela isso";
}

const KIND_PRIORITY: Record<PushKind, number> = { "run-finished": 1, reminder: 1, test: 1, "coding-failed": 2, "needs-user": 3 };

export function pushPriority(kind: PushKind): number {
	return KIND_PRIORITY[kind];
}

export type PushInput = {
	kind: PushKind;
	conversationId: string;
	botId?: string | null;
	botName?: string | null;
	/** Texto do evento: resposta do bot, título do cartão, motivo da falha, lembrete. */
	text?: string | null;
	cardId?: string | null;
	/** Ícone grande (avatar do bot); sem ele vale o ícone do app. */
	iconUrl?: string | null;
	now?: number;
};

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function pushUrl(botId: string | null | undefined, cardId?: string | null): string {
	if (!botId) return "/";
	const params = new URLSearchParams({ bot: botId });
	if (cardId) params.set("card", cardId);
	return `/?${params.toString()}`;
}

/** null = não notificar (texto de protocolo ou vazio onde o texto é a razão de ser). */
export function buildPushPayload(input: PushInput): PushPayload | null {
	const who = clip((input.botName ?? "").trim() || "Seu bot", TITLE_MAX);
	const line = firstLine(input.text);
	if ((input.kind === "run-finished" || input.kind === "needs-user" || input.kind === "reminder") && isProtocolText(input.text)) return null;
	let title: string;
	let body: string;
	switch (input.kind) {
		case "run-finished":
			title = who;
			body = line || "Tem uma resposta nova para você.";
			break;
		case "needs-user":
			title = `${who} precisa de você`;
			body = line || "Abra a conversa para decidir.";
			break;
		case "coding-failed":
			title = `${who}: a sessão de código falhou`;
			body = line || "Abra a conversa para ver o que aconteceu.";
			break;
		case "reminder":
			title = who;
			body = line || "Lembrete";
			break;
		case "test":
			title = "Notificações ativadas";
			body = "Está tudo certo: você vai receber avisos aqui.";
			break;
	}
	return {
		title,
		body,
		tag: input.conversationId,
		url: input.kind === "test" ? "/" : pushUrl(input.botId, input.cardId),
		conversationId: input.conversationId,
		botId: input.botId ?? null,
		kind: input.kind,
		cardId: input.cardId ?? null,
		icon: input.iconUrl || PUSH_ICON,
		badge: PUSH_BADGE,
		ts: input.now ?? Date.now(),
	};
}

export type CoalesceState = { at: number; kind: PushKind } | null;

/**
 * Uma notificação por conversa a cada 30s. Dentro da janela só passa uma mais urgente que a
 * última ("precisa de você" nunca fica escondida atrás de um "terminou"); a tag a substitui.
 */
export function decideCoalesce(input: { last: CoalesceState; kind: PushKind; now: number }): boolean {
	if (!input.last) return true;
	if (input.now - input.last.at >= COALESCE_WINDOW_MS) return true;
	return pushPriority(input.kind) > pushPriority(input.last.kind);
}

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string; userAgent: string | null };

const ENDPOINT_MAX = 2048;
const KEY_MAX = 256;

/** Corpo do `PushSubscription.toJSON()` do navegador; null se inválido (só https). */
export function parsePushSubscription(body: unknown, userAgent?: string | null): PushSubscriptionInput | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	const { endpoint } = raw;
	const p256dh = raw.keys?.p256dh;
	const auth = raw.keys?.auth;
	if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX) return null;
	if (typeof p256dh !== "string" || typeof auth !== "string") return null;
	if (!p256dh || !auth || p256dh.length > KEY_MAX || auth.length > KEY_MAX) return null;
	try {
		if (new URL(endpoint).protocol !== "https:") return null;
	} catch {
		return null;
	}
	return { endpoint, p256dh, auth, userAgent: userAgent ? userAgent.slice(0, 300) : null };
}

/** Nome curto do aparelho a partir do user agent ("Chrome · Android"). */
export function describeDevice(userAgent: string | null | undefined): string {
	const ua = userAgent ?? "";
	const os = ua.includes("Android")
		? "Android"
		: ua.includes("iPhone") || ua.includes("iPad")
			? "iOS"
			: ua.includes("Windows")
				? "Windows"
				: ua.includes("Mac OS")
					? "Mac"
					: ua.includes("Linux")
						? "Linux"
						: "";
	const browser = ua.includes("Edg/")
		? "Edge"
		: ua.includes("Firefox/")
			? "Firefox"
			: ua.includes("CriOS/") || ua.includes("Chrome/")
				? "Chrome"
				: ua.includes("Safari/")
					? "Safari"
					: "";
	return [browser, os].filter(Boolean).join(" · ") || "Aparelho";
}

/** O serviço de push respondeu que a inscrição não existe mais (apagar). */
export function isGonePushStatus(status: number | undefined): boolean {
	return status === 404 || status === 410;
}

/** Chaves VAPID prontas para uso? */
export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

export function readVapidConfig(env: Record<string, string | undefined>): VapidConfig | null {
	const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim();
	const privateKey = env.WEB_PUSH_PRIVATE_KEY?.trim();
	const subject = env.WEB_PUSH_SUBJECT?.trim();
	if (!publicKey || !privateKey || !subject) return null;
	if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) return null;
	return { publicKey, privateKey, subject };
}

/** Quais variáveis WEB_PUSH_* faltam ou estão inválidas (para o log de partida). Vazio = tudo certo. */
export function vapidProblems(env: Record<string, string | undefined>): string[] {
	const problems: string[] = [];
	for (const name of ["WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_SUBJECT"] as const) {
		if (!env[name]?.trim()) problems.push(`${name} ausente`);
	}
	const subject = env.WEB_PUSH_SUBJECT?.trim();
	if (subject && !subject.startsWith("mailto:") && !subject.startsWith("https://")) problems.push("WEB_PUSH_SUBJECT deve começar com mailto: ou https://");
	return problems;
}
