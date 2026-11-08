/**
 * Cartões salvos e mandato de compra (Motor v4, F6.2 e F6.4).
 * O db só guarda TEXTO SELADO (`secretsEnc`): quem sela e abre é a camada de cima, que tem a chave do cofre.
 * Não existe coluna, parâmetro nem tipo de CVV aqui (regra do dono, 05/11).
 * Toda função recebe o `userId` da SESSÃO ou do RUN e filtra por ele na própria consulta (40-seguranca): cartão de
 * outro dono é "não encontrado" (404 na API).
 */
import { normalizeMerchant } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

const owned = (userId: string): boolean => ownerIds(userId).length > 0;

/** Teto técnico de cartões por dono. */
export const SAVED_CARDS_MAX_PER_OWNER = 20;

export type SavedCardRow = { id: string; label: string; brand: string; last4: string; createdAt: Date };

export type CreateSavedCardInput = { label: string; brand: string; last4: string; secretsEnc: string };

export class SavedCardLimitError extends Error {
	constructor() {
		super("limite de cartões salvos atingido");
		this.name = "SavedCardLimitError";
	}
}

export async function createSavedCard(userId: string, input: CreateSavedCardInput): Promise<SavedCardRow> {
	if (!owned(userId)) throw new RangeError("dono inválido");
	// Contar e criar na MESMA transação sob trava por dono: sem ela, criações paralelas leem a mesma contagem e passam do teto.
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saved-card-create:${userId}`}))`;
		if ((await tx.savedCard.count({ where: { userId } })) >= SAVED_CARDS_MAX_PER_OWNER) throw new SavedCardLimitError();
		return tx.savedCard.create({ data: { userId, label: input.label, brand: input.brand, last4: input.last4, secretsEnc: input.secretsEnc }, select: { id: true, label: true, brand: true, last4: true, createdAt: true } });
	});
}

/** Só metadado público (rótulo, bandeira, final). Nunca o texto selado. */
export async function listSavedCards(userId: string): Promise<SavedCardRow[]> {
	if (!owned(userId)) return [];
	return prisma.savedCard.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, label: true, brand: true, last4: true, createdAt: true } });
}

/** Metadado público de UM cartão do dono (para o cartão de aprovação: bandeira e final). */
export async function getSavedCardMeta(userId: string, id: string): Promise<SavedCardRow | null> {
	if (!owned(userId) || id.length === 0 || id.length > 100) return null;
	return prisma.savedCard.findFirst({ where: { id, userId }, select: { id: true, label: true, brand: true, last4: true, createdAt: true } });
}

/** O texto selado do cartão. SÓ a camada de execução (card_fill) chama; nenhuma rota devolve isto. */
export async function getSavedCardSealed(userId: string, id: string): Promise<{ id: string; brand: string; last4: string; secretsEnc: string } | null> {
	if (!owned(userId) || id.length === 0 || id.length > 100) return null;
	return prisma.savedCard.findFirst({ where: { id, userId }, select: { id: true, brand: true, last4: true, secretsEnc: true } });
}

export async function deleteSavedCard(userId: string, id: string): Promise<boolean> {
	if (!owned(userId) || id.length === 0 || id.length > 100) return false;
	const { count } = await prisma.savedCard.deleteMany({ where: { id, userId } });
	return count === 1;
}

// ------------------------------------------------------------------ mandato

export type PurchaseMandateRow = { id: string; maxAmount: number; currency: string; merchants: string[]; until: Date; usesLeft: number; /** Sobe a cada troca do mandato. */ rev: number };
const MANDATE_SELECT = { id: true, maxAmount: true, currency: true, merchants: true, until: true, usesLeft: true, rev: true } as const;

/** Qual mandato o run viu: gasto e devolução de uso só valem para ele (a troca do mandato no meio do run os invalida). */
export type MandateToken = { id: string; rev: number };

/** Um mandato por dono: criar um novo substitui o anterior. */
export async function upsertPurchaseMandate(userId: string, input: { maxAmount: number; currency: string; merchants: readonly string[]; until: Date; uses: number }): Promise<PurchaseMandateRow> {
	if (!owned(userId)) throw new RangeError("dono inválido");
	// Mesma forma canônica que o checkout compara (`merchantOf`): loja que não é domínio válido nunca é gravada.
	const merchants = [...new Set(input.merchants.map((m) => normalizeMerchant(m)))];
	if (merchants.length === 0 || merchants.some((m) => m === null)) throw new RangeError("loja inválida");
	const data = { maxAmount: input.maxAmount, currency: input.currency.toUpperCase(), merchants: merchants as string[], until: input.until, usesLeft: input.uses };
	const row = await prisma.purchaseMandate.upsert({ where: { userId }, create: { userId, ...data, usesTotal: input.uses }, update: { ...data, usesTotal: input.uses, rev: { increment: 1 } }, select: MANDATE_SELECT });
	return { ...row, merchants: normalizeStoredMerchants(row.merchants) };
}

export async function getPurchaseMandate(userId: string): Promise<PurchaseMandateRow | null> {
	if (!owned(userId)) return null;
	const row = await prisma.purchaseMandate.findUnique({ where: { userId }, select: MANDATE_SELECT });
	return row ? { ...row, merchants: normalizeStoredMerchants(row.merchants) } : null;
}

/**
 * Lojas lidas do banco na MESMA forma que o checkout compara. Mandato antigo (gravado só com trim e minúsculo) continua
 * casando; entrada que não normaliza é descartada (fail-closed: uma loja ilegível nunca autoriza nada).
 */
export function normalizeStoredMerchants(stored: readonly string[]): string[] {
	return [...new Set(stored.map((m) => normalizeMerchant(m)).filter((m): m is string => m !== null))];
}

export async function deletePurchaseMandate(userId: string): Promise<boolean> {
	if (!owned(userId)) return false;
	const { count } = await prisma.purchaseMandate.deleteMany({ where: { userId } });
	return count === 1;
}

/**
 * Gasta UM uso do mandato de forma atômica (UPDATE ... WHERE usesLeft > 0 e dentro do prazo): com dois runs correndo
 * e `usesLeft = 1`, só um recebe `true`. `false` = sem mandato, sem usos ou vencido: a compra não roda pelo mandato.
 */
export async function consumePurchaseMandateUse(userId: string, now: Date = new Date(), token?: MandateToken): Promise<boolean> {
	if (!owned(userId)) return false;
	const { count } = await prisma.purchaseMandate.updateMany({ where: { userId, usesLeft: { gt: 0 }, until: { gt: now }, ...(token && { id: token.id, rev: token.rev }) }, data: { usesLeft: { decrement: 1 } } });
	return count === 1;
}

/**
 * Devolve o uso gasto por `consumePurchaseMandateUse` quando a compra não chegou a acontecer (ex.: CVV não chegou). Nunca
 * passa do total original do mandato e, com `token`, só mexe no mesmo mandato que o run viu (se o dono o trocou, o novo fica
 * como está).
 */
export async function restorePurchaseMandateUse(userId: string, token?: MandateToken): Promise<void> {
	if (!owned(userId)) return;
	if (token) await prisma.$executeRaw`UPDATE "purchase_mandates" SET "usesLeft" = "usesLeft" + 1 WHERE "userId" = ${userId} AND "id" = ${token.id} AND "rev" = ${token.rev} AND "usesLeft" < "usesTotal"`;
	else await prisma.$executeRaw`UPDATE "purchase_mandates" SET "usesLeft" = "usesLeft" + 1 WHERE "userId" = ${userId} AND "usesLeft" < "usesTotal"`;
}

/**
 * Grava os usos que restam depois de um run (o kernel gasta em memória e leva ao checkpoint). Só diminui: nunca
 * "devolve" uso, nem com dois runs correndo.
 */
export async function lowerPurchaseMandateUses(userId: string, usesLeft: number): Promise<void> {
	if (!owned(userId) || !Number.isInteger(usesLeft) || usesLeft < 0) return;
	await prisma.purchaseMandate.updateMany({ where: { userId, usesLeft: { gt: usesLeft } }, data: { usesLeft } });
}
