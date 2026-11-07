/**
 * Cartões salvos e mandato de compra (Motor v4, F6.2 e F6.4).
 * O db só guarda TEXTO SELADO (`secretsEnc`): quem sela e abre é a camada de cima, que tem a chave do cofre.
 * Não existe coluna, parâmetro nem tipo de CVV aqui (regra do dono, 05/11).
 * Toda função recebe o `userId` da SESSÃO ou do RUN e filtra por ele na própria consulta (40-seguranca): cartão de
 * outro dono é "não encontrado" (404 na API).
 */
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
	if ((await prisma.savedCard.count({ where: { userId } })) >= SAVED_CARDS_MAX_PER_OWNER) throw new SavedCardLimitError();
	const row = await prisma.savedCard.create({ data: { userId, label: input.label, brand: input.brand, last4: input.last4, secretsEnc: input.secretsEnc }, select: { id: true, label: true, brand: true, last4: true, createdAt: true } });
	return row;
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

export type PurchaseMandateRow = { id: string; maxAmount: number; currency: string; merchants: string[]; until: Date; usesLeft: number };
const MANDATE_SELECT = { id: true, maxAmount: true, currency: true, merchants: true, until: true, usesLeft: true } as const;

/** Um mandato por dono: criar um novo substitui o anterior. */
export async function upsertPurchaseMandate(userId: string, input: { maxAmount: number; currency: string; merchants: readonly string[]; until: Date; uses: number }): Promise<PurchaseMandateRow> {
	if (!owned(userId)) throw new RangeError("dono inválido");
	const data = { maxAmount: input.maxAmount, currency: input.currency.toUpperCase(), merchants: input.merchants.map((m) => m.trim().toLowerCase()), until: input.until, usesLeft: input.uses };
	return prisma.purchaseMandate.upsert({ where: { userId }, create: { userId, ...data }, update: data, select: MANDATE_SELECT });
}

export async function getPurchaseMandate(userId: string): Promise<PurchaseMandateRow | null> {
	if (!owned(userId)) return null;
	return prisma.purchaseMandate.findUnique({ where: { userId }, select: MANDATE_SELECT });
}

export async function deletePurchaseMandate(userId: string): Promise<boolean> {
	if (!owned(userId)) return false;
	const { count } = await prisma.purchaseMandate.deleteMany({ where: { userId } });
	return count === 1;
}

/**
 * Grava os usos que restam depois de um run (o kernel gasta em memória e leva ao checkpoint). Só diminui: nunca
 * "devolve" uso, nem com dois runs correndo.
 */
export async function lowerPurchaseMandateUses(userId: string, usesLeft: number): Promise<void> {
	if (!owned(userId) || !Number.isInteger(usesLeft) || usesLeft < 0) return;
	await prisma.purchaseMandate.updateMany({ where: { userId, usesLeft: { gt: usesLeft } }, data: { usesLeft } });
}
