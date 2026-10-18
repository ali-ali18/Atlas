import {
	buildPushPayload,
	pushAvatarLook,
	pushAvatarUrl,
	pushPublicOrigin,
	decideCoalesce,
	isGonePushStatus,
	type CoalesceState,
	type PushKind,
	type PushPayload,
	type PushSubscriptionInput,
} from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Notificações push: inscrições por usuário/aparelho e o `notify()` único usado pelo worker e pela API.
 * O envio (web-push), a presença ("está olhando a conversa") e a coalescência (Redis) entram por
 * injeção, assim o fluxo inteiro roda em teste sem rede.
 */

/** Falhas seguidas (não 404/410) antes de desistir de um aparelho. */
export const PUSH_MAX_FAILURES = 8;

export type PushSubscriptionRow = {
	id: string;
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent: string | null;
	createdAt: Date;
	lastUsedAt: Date;
	failureCount: number;
};

/** Cria ou atualiza a inscrição do aparelho. O endpoint é único: reinscrever em outra conta move a linha. */
export async function savePushSubscription(userId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRow> {
	const now = new Date();
	const row = await prisma.pushSubscription.upsert({
		where: { endpoint: input.endpoint },
		create: { userId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent, lastUsedAt: now },
		update: { userId, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent, lastUsedAt: now, failureCount: 0, lastFailureAt: null, lastError: null },
	});
	return row as PushSubscriptionRow;
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
	return (await prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })) as PushSubscriptionRow[];
}

/** Remove uma inscrição do usuário (por id ou por endpoint). Devolve quantas apagou. */
export async function removePushSubscription(userId: string, ref: { id?: string; endpoint?: string }): Promise<number> {
	if (!ref.id && !ref.endpoint) return 0;
	const result = await prisma.pushSubscription.deleteMany({
		where: { userId, ...(ref.id ? { id: ref.id } : {}), ...(ref.endpoint ? { endpoint: ref.endpoint } : {}) },
	});
	return result.count;
}

export type PushSendResult = { ok: true } | { ok: false; status?: number; error: string };

export type PushSender = {
	send(subscription: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<PushSendResult>;
};

/** Registra o resultado do envio: 404/410 apaga a inscrição; outras falhas contam e, no limite, apagam. */
export async function settlePushResult(subscriptionId: string, result: PushSendResult, now: Date = new Date()): Promise<"sent" | "deleted" | "failed"> {
	if (result.ok) {
		await prisma.pushSubscription.updateMany({ where: { id: subscriptionId }, data: { lastUsedAt: now, failureCount: 0, lastFailureAt: null, lastError: null } });
		return "sent";
	}
	if (isGonePushStatus(result.status)) {
		await prisma.pushSubscription.deleteMany({ where: { id: subscriptionId } });
		return "deleted";
	}
	const row = (await prisma.pushSubscription.findUnique({ where: { id: subscriptionId } })) as { failureCount: number } | null;
	if (!row) return "deleted";
	const failures = row.failureCount + 1;
	if (failures >= PUSH_MAX_FAILURES) {
		await prisma.pushSubscription.deleteMany({ where: { id: subscriptionId } });
		return "deleted";
	}
	await prisma.pushSubscription.updateMany({
		where: { id: subscriptionId },
		data: { failureCount: failures, lastFailureAt: now, lastError: result.error.slice(0, 300) },
	});
	return "failed";
}

/** Quem está olhando a conversa agora (sinal de vida dos clientes visíveis, com validade curta). */
export type Presence = {
	touch(userId: string, conversationId: string, clientId: string, now: number): Promise<void>;
	clear(userId: string, conversationId: string, clientId: string): Promise<void>;
	isViewed(userId: string, conversationId: string, now: number): Promise<boolean>;
};

/** Última notificação por conversa (para a coalescência). */
export type CoalesceStore = {
	get(userId: string, conversationId: string): Promise<CoalesceState>;
	set(userId: string, conversationId: string, state: NonNullable<CoalesceState>): Promise<void>;
};

/**
 * Ícone grande da notificação: o avatar do bot (forma e cor como a web decide) servido pela API em
 * `/v1/avatars/<forma>-<cor>-v1.png`. null (cai no ícone do app) se não houver URL pública ou algo falhar.
 */
export function botAvatarIconUrl(bot: { id: string; shape?: string | null; color?: string | null }, env: Record<string, string | undefined> = process.env): string | null {
	try {
		return pushAvatarUrl(pushPublicOrigin(env), pushAvatarLook(bot));
	} catch {
		return null;
	}
}

export type NotifyDeps = {
	sender: PushSender;
	presence: Presence;
	coalesce: CoalesceStore;
	now?: () => number;
};

export type NotifyResult =
	| { status: "sent"; sent: number; deleted: number; failed: number }
	| { status: "skipped"; reason: "protocol" | "no-subscriptions" | "bot-disabled" | "viewing" | "coalesced" | "no-conversation" | "error" };

export type NotifyOptions = { cardId?: string | null };

/**
 * Notifica o usuário no celular. Um único ponto de entrada:
 * respeita o switch do bot, não incomoda quem está olhando a conversa, ignora protocolo,
 * agrupa por conversa (tag) e limpa inscrições mortas. Nunca lança.
 */
export function createNotifier(deps: NotifyDeps) {
	const clock = deps.now ?? (() => Date.now());
	return async function notify(
		userId: string,
		conversationId: string,
		kind: PushKind,
		text: string | null | undefined,
		options: NotifyOptions = {},
	): Promise<NotifyResult> {
		const result = await notifyInner(userId, conversationId, kind, text, options);
		// Uma linha por tentativa: em produção mostra por que um aviso não saiu (sem texto nem ids de aparelho).
		console.info(`[push] ${kind} conversa=${conversationId} -> ${result.status === "sent" ? `enviado ${result.sent} (removidos ${result.deleted}, falhas ${result.failed})` : `ignorado (${result.reason})`}`);
		return result;
	};
	async function notifyInner(
		userId: string,
		conversationId: string,
		kind: PushKind,
		text: string | null | undefined,
		options: NotifyOptions = {},
	): Promise<NotifyResult> {
		try {
			const bot = (await prisma.bot.findFirst({ where: { conversationId, ownerId: userId }, select: { id: true, name: true, notify: true, shape: true, color: true } })) as
				| { id: string; name: string; notify: boolean; shape?: string | null; color?: string | null }
				| null;
			if (!bot) return { status: "skipped", reason: "no-conversation" };
			if (!bot.notify) return { status: "skipped", reason: "bot-disabled" };
			const now = clock();
			const payload: PushPayload | null = buildPushPayload({ kind, conversationId, botId: bot.id, botName: bot.name, text, cardId: options.cardId, iconUrl: botAvatarIconUrl(bot), now });
			if (!payload) return { status: "skipped", reason: "protocol" };
			const subscriptions = await listPushSubscriptions(userId);
			if (subscriptions.length === 0) return { status: "skipped", reason: "no-subscriptions" };
			if (await deps.presence.isViewed(userId, conversationId, now)) return { status: "skipped", reason: "viewing" };
			const last = await deps.coalesce.get(userId, conversationId);
			if (!decideCoalesce({ last, kind, now })) return { status: "skipped", reason: "coalesced" };
			await deps.coalesce.set(userId, conversationId, { at: now, kind });
			return { status: "sent", ...(await deliverToAll(deps.sender, subscriptions, payload)) };
		} catch (error) {
			console.error("[push] notify falhou", error instanceof Error ? error.message : "erro");
			return { status: "skipped", reason: "error" };
		}
	};
}

async function deliverToAll(sender: PushSender, subscriptions: PushSubscriptionRow[], payload: PushPayload) {
	const body = JSON.stringify(payload);
	const counts = { sent: 0, deleted: 0, failed: 0 };
	await Promise.all(
		subscriptions.map(async (subscription) => {
			const result = await sender.send(subscription, body).catch((error): PushSendResult => ({ ok: false, error: error instanceof Error ? error.message : "erro" }));
			const outcome = await settlePushResult(subscription.id, result);
			if (outcome === "sent") counts.sent += 1;
			else if (outcome === "deleted") counts.deleted += 1;
			else counts.failed += 1;
		}),
	);
	return counts;
}

/** Notificação de teste para todos os aparelhos do usuário (ignora switch do bot, presença e coalescência). */
export async function sendTestPush(userId: string, sender: PushSender, now: number = Date.now()) {
	const subscriptions = await listPushSubscriptions(userId);
	// O teste usa o avatar do bot principal (se não houver, o ícone do app).
	const primary = (await prisma.bot.findFirst({ where: { ownerId: userId, isPrimary: true }, select: { id: true, shape: true, color: true } }).catch(() => null)) as { id: string; shape?: string | null; color?: string | null } | null;
	const payload = buildPushPayload({ kind: "test", conversationId: "test", iconUrl: primary ? botAvatarIconUrl(primary) : null, now });
	if (!payload || subscriptions.length === 0) return { sent: 0, deleted: 0, failed: 0, devices: subscriptions.length };
	return { ...(await deliverToAll(sender, subscriptions, payload)), devices: subscriptions.length };
}

/** Redis mínimo que a presença e a coalescência precisam (satisfeito por ioredis). */
export type RedisLike = {
	zadd(key: string, score: number, member: string): Promise<unknown>;
	zrem(key: string, member: string): Promise<unknown>;
	zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
	zcount(key: string, min: number | string, max: number | string): Promise<number>;
	pexpire(key: string, ms: number): Promise<unknown>;
	get(key: string): Promise<string | null>;
	set(key: string, value: string, mode: "PX", ms: number): Promise<unknown>;
};

const VIEWING_TTL_MS = 45_000;
const COALESCE_KEY_TTL_MS = 120_000;

export function createRedisPresence(redis: RedisLike, ttlMs: number = VIEWING_TTL_MS): Presence {
	const key = (userId: string, conversationId: string) => `atlas:viewing:${userId}:${conversationId}`;
	return {
		async touch(userId, conversationId, clientId, now) {
			const k = key(userId, conversationId);
			await redis.zremrangebyscore(k, "-inf", now);
			await redis.zadd(k, now + ttlMs, clientId);
			await redis.pexpire(k, ttlMs * 2);
		},
		async clear(userId, conversationId, clientId) {
			await redis.zrem(key(userId, conversationId), clientId);
		},
		async isViewed(userId, conversationId, now) {
			return (await redis.zcount(key(userId, conversationId), `(${now}`, "+inf")) > 0;
		},
	};
}

export function createRedisCoalesce(redis: RedisLike): CoalesceStore {
	const key = (userId: string, conversationId: string) => `atlas:push-last:${userId}:${conversationId}`;
	return {
		async get(userId, conversationId) {
			const raw = await redis.get(key(userId, conversationId));
			if (!raw) return null;
			try {
				const parsed = JSON.parse(raw) as { at?: unknown; kind?: unknown };
				return typeof parsed.at === "number" && typeof parsed.kind === "string" ? { at: parsed.at, kind: parsed.kind as PushKind } : null;
			} catch {
				return null;
			}
		},
		async set(userId, conversationId, state) {
			await redis.set(key(userId, conversationId), JSON.stringify(state), "PX", COALESCE_KEY_TTL_MS);
		},
	};
}

export type Notify = ReturnType<typeof createNotifier>;
