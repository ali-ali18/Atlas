/**
 * Entrega offline (F5): decisões puras do completion backlog. O usuário avisa que
 * vai sair ("volto amanhã", "me avisa às 7h"); quando o run termina, o resultado
 * entra no backlog e vira UMA notificação por usuário, sem repetir o que ele já viu.
 */
import { parseOnceRunAt } from "./routine-once.js";

/** Conclusões dentro desta janela viram a mesma notificação. */
export const DELIVERY_COALESCE_WINDOW_MS = 2 * 60 * 1000;
/** Teto de quão longe uma entrega agendada pode ficar (o backlog não é lembrete de longo prazo). */
export const DELIVERY_MAX_DEFER_MS = 7 * 24 * 60 * 60 * 1000;
export const DELIVERY_DEFAULT_TIMEZONE = "America/Sao_Paulo";
export const DELIVERY_SUMMARY_MAX_CHARS = 280;
/** Depois de tantas falhas de envio a entrega é abandonada (o resultado segue na conversa). */
export const DELIVERY_MAX_ATTEMPTS = 5;

export type DeliveryOutcome = "completed" | "budget_exhausted" | "failed";
export type DeliveryStatus = "waiting" | "ready" | "sending" | "sent" | "failed" | "cancelled";

/** Horário "de parede" `YYYY-MM-DDTHH:mm` no fuso (o formato que a triagem devolve em `deliverAt`). */
export function wallClockNow(now: Date, timeZone: string = DELIVERY_DEFAULT_TIMEZONE): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(now);
	const map: Record<string, string> = {};
	for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
	const hour = map.hour === "24" ? "00" : map.hour;
	return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`;
}

/**
 * `deliverAt` vindo da triagem → instante válido. `null` = sem horário utilizável
 * (vazio, inválido, passado ou além do teto): a entrega segue o fim do run.
 */
export function parseDeliverAt(
	raw: unknown,
	now: Date,
	timezone: string = DELIVERY_DEFAULT_TIMEZONE,
): Date | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const parsed = parseOnceRunAt({ runAt: raw, timezone }, now);
	if (!parsed.ok) return null;
	const at = new Date(parsed.runAtIso);
	if (at.getTime() - now.getTime() > DELIVERY_MAX_DEFER_MS) return null;
	return at;
}

/** Quando a notificação pode sair: depois da janela de coalescência e do horário combinado. */
export function planDeliveryDue(input: { completedAt: Date; deliverAfter?: Date | null }): Date {
	const afterWindow = input.completedAt.getTime() + DELIVERY_COALESCE_WINDOW_MS;
	return new Date(Math.max(afterWindow, input.deliverAfter?.getTime() ?? 0));
}

export function summarizeDeliveryText(text: string | null | undefined): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > DELIVERY_SUMMARY_MAX_CHARS ? `${flat.slice(0, DELIVERY_SUMMARY_MAX_CHARS - 1)}…` : flat;
}

export type DueDelivery = {
	id: string;
	userId: string;
	conversationId: string;
	botName: string | null;
	outcome: DeliveryOutcome;
	summary: string;
};

export type DeliveryBatch = { userId: string; items: DueDelivery[] };

/** Várias conclusões do mesmo usuário viram um único lote (uma notificação). */
export function coalesceDeliveries(items: DueDelivery[]): DeliveryBatch[] {
	const byUser = new Map<string, DueDelivery[]>();
	for (const item of items) {
		const list = byUser.get(item.userId) ?? [];
		list.push(item);
		byUser.set(item.userId, list);
	}
	return [...byUser.entries()].map(([userId, list]) => ({ userId, items: list }));
}
