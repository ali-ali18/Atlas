/**
 * Compras registradas (Motor v4, F6.5). TODA função recebe o `userId` da SESSÃO/RUN e filtra por ele na própria consulta
 * (`where: { id, userId }`): compra de outro dono é indistinguível de inexistente (`null`; a rota responde 404).
 */
import { Prisma } from "@prisma/client";
import { purchaseDedupeKey, purchaseMergePatch, type PurchaseInput, type PurchaseItem, type PurchaseView } from "@workspace/shared";
import { prisma } from "./client.js";

type Row = {
	id: string;
	botId: string | null;
	merchant: string;
	itemsJson: Prisma.JsonValue;
	total: Prisma.Decimal;
	currency: string;
	purchasedAt: Date;
	orderNumber: string | null;
	trackingCode: string | null;
	trackingUrl: string | null;
	deliveryWatchId: string | null;
	createdAt: Date;
};

export type PurchaseRecord = PurchaseView & { deliveryWatchId: string | null };

export function toPurchase(row: Row): PurchaseRecord {
	return {
		id: row.id,
		botId: row.botId,
		merchant: row.merchant,
		items: (Array.isArray(row.itemsJson) ? row.itemsJson : []) as PurchaseItem[],
		total: Number(row.total.toString()),
		currency: row.currency,
		purchasedAt: row.purchasedAt.toISOString(),
		...(row.orderNumber && { orderNumber: row.orderNumber }),
		...(row.trackingCode && { trackingCode: row.trackingCode }),
		...(row.trackingUrl && { trackingUrl: row.trackingUrl }),
		deliveryWatchId: row.deliveryWatchId,
		createdAt: row.createdAt.toISOString(),
	};
}

/** Grava a compra (já validada por `normalizePurchaseInput`). O mesmo pedido duas vezes devolve o existente. */
export async function recordPurchase(input: { userId: string; botId?: string | null; conversationId?: string | null; sourceRunId?: string | null; purchase: PurchaseInput; /** Fuso do dono: o "dia" da chave. */ timeZone?: string }): Promise<{ purchase: PurchaseRecord; duplicate: boolean }> {
	const { purchase } = input;
	const dedupeKey = purchaseDedupeKey(purchase, input.timeZone);
	const existing = await prisma.purchase.findFirst({ where: { userId: input.userId, dedupeKey } });
	if (existing) return { purchase: await mergeIntoExisting(input.userId, existing, purchase), duplicate: true };
	try {
		const row = await prisma.purchase.create({
			data: {
				userId: input.userId,
				botId: input.botId ?? null,
				conversationId: input.conversationId ?? null,
				sourceRunId: input.sourceRunId ?? null,
				merchant: purchase.merchant,
				itemsJson: purchase.items as unknown as Prisma.InputJsonValue,
				total: purchase.total.toFixed(2),
				currency: purchase.currency,
				purchasedAt: new Date(purchase.purchasedAt),
				orderNumber: purchase.orderNumber ?? null,
				trackingCode: purchase.trackingCode ?? null,
				trackingUrl: purchase.trackingUrl ?? null,
				dedupeKey,
			},
		});
		return { purchase: toPurchase(row), duplicate: false };
	} catch (error) {
		// Corrida: outro run gravou o mesmo pedido entre a consulta e o insert.
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
			const row = await prisma.purchase.findFirst({ where: { userId: input.userId, dedupeKey } });
			if (row) return { purchase: await mergeIntoExisting(input.userId, row, purchase), duplicate: true };
		}
		throw error;
	}
}

/** O mesmo pedido de novo traz o que faltava (rastreio, link, número do pedido): acrescenta sem trocar o que já há. */
async function mergeIntoExisting(userId: string, existing: Row, incoming: PurchaseInput): Promise<PurchaseRecord> {
	const patch = purchaseMergePatch({ orderNumber: existing.orderNumber ?? undefined, trackingCode: existing.trackingCode ?? undefined, trackingUrl: existing.trackingUrl ?? undefined }, incoming);
	if (Object.keys(patch).length === 0) return toPurchase(existing);
	const { count } = await prisma.purchase.updateMany({ where: { id: existing.id, userId }, data: patch });
	return count > 0 ? toPurchase({ ...existing, ...patch }) : toPurchase(existing);
}

export async function getPurchase(userId: string, id: string): Promise<PurchaseRecord | null> {
	const row = await prisma.purchase.findFirst({ where: { id, userId } });
	return row ? toPurchase(row) : null;
}

export async function listPurchases(userId: string, options: { botId?: string; limit?: number } = {}): Promise<PurchaseRecord[]> {
	const rows = await prisma.purchase.findMany({
		where: { userId, ...(options.botId ? { botId: options.botId } : {}) },
		orderBy: [{ purchasedAt: "desc" }, { id: "asc" }],
		take: Math.max(1, Math.min(100, Math.floor(options.limit ?? 50))),
	});
	return rows.map(toPurchase);
}

/** Liga a compra ao vigia de entrega da agenda. Só a compra do dono. */
export async function attachDeliveryWatch(userId: string, id: string, watchId: string): Promise<boolean> {
	const result = await prisma.purchase.updateMany({ where: { id, userId }, data: { deliveryWatchId: watchId } });
	return result.count > 0;
}

/** Corrige a compra do dono (valor já validado por `normalizePurchaseInput`). `null` = não existe ou é de outro dono. */
export async function updatePurchase(userId: string, id: string, purchase: PurchaseInput, timeZone?: string): Promise<PurchaseRecord | null> {
	const current = await prisma.purchase.findFirst({ where: { id, userId }, select: { id: true } });
	if (!current) return null;
	const { count } = await prisma.purchase.updateMany({
		where: { id, userId },
		data: {
			merchant: purchase.merchant,
			itemsJson: purchase.items as unknown as Prisma.InputJsonValue,
			total: purchase.total.toFixed(2),
			currency: purchase.currency,
			purchasedAt: new Date(purchase.purchasedAt),
			orderNumber: purchase.orderNumber ?? null,
			trackingCode: purchase.trackingCode ?? null,
			trackingUrl: purchase.trackingUrl ?? null,
			dedupeKey: purchaseDedupeKey(purchase, timeZone),
		},
	});
	return count > 0 ? getPurchase(userId, id) : null;
}

/** Apaga a compra do dono e devolve o vigia que estava ligado a ela (para quem chamou encerrá-lo). `null` = não existe ou é de outro dono. */
export async function deletePurchase(userId: string, id: string): Promise<{ deliveryWatchId: string | null } | null> {
	const row = await prisma.purchase.findFirst({ where: { id, userId }, select: { deliveryWatchId: true } });
	if (!row) return null;
	const { count } = await prisma.purchase.deleteMany({ where: { id, userId } });
	return count > 0 ? { deliveryWatchId: row.deliveryWatchId } : null;
}
