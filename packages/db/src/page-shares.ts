/**
 * Link público somente leitura do painel. O token (256 bits, `crypto`) aparece uma única vez, ao criar/girar o link;
 * no banco fica só o hash (sha256 com pepper, o mesmo dos segredos de webhook). Criar, girar, revogar e consultar
 * exigem o dono do painel (`where: { id, userId }`: painel de outro dono = inexistente). A leitura pública
 * (`getSharedPageByToken`) devolve SÓ o que desenha o painel: título, resumo, spec, datas e o nome do bot.
 */
import { randomBytes } from "node:crypto";
import { parsePageSpec, type PageSpec } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";
import { hashHookSecret } from "./routines.js";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function generatePageShareToken(): string {
	return randomBytes(32).toString("base64url");
}

export type PageShareStatus = { active: boolean; createdAt: string | null };

async function ownedPage(id: string, userId: string) {
	if (ownerIds(userId).length === 0) return null;
	return prisma.page.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
}

/** Cria o link do painel ou gira o token (o link antigo deixa de valer). `null` se o painel não é do usuário. */
export async function createOrRotatePageShare(id: string, userId: string): Promise<{ token: string; createdAt: string } | null> {
	if (!(await ownedPage(id, userId))) return null;
	const token = generatePageShareToken();
	const tokenHash = hashHookSecret(token);
	const now = new Date();
	const existing = await prisma.pageShare.findFirst({ where: { pageId: id, userId }, select: { id: true } });
	if (existing) {
		await prisma.pageShare.updateMany({ where: { id: existing.id, userId }, data: { tokenHash, createdAt: now, revokedAt: null } });
	} else {
		await prisma.pageShare.create({ data: { pageId: id, userId, tokenHash, createdAt: now } });
	}
	return { token, createdAt: now.toISOString() };
}

/** Desativa o link. `null` se o painel não é do usuário; `false` se não havia link ativo. */
export async function revokePageShare(id: string, userId: string): Promise<boolean | null> {
	if (!(await ownedPage(id, userId))) return null;
	const revoked = await prisma.pageShare.updateMany({ where: { pageId: id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
	return revoked.count > 0;
}

/** O link está ativo? `null` se o painel não é do usuário. O token nunca é devolvido (só existe o hash). */
export async function getPageShareStatus(id: string, userId: string): Promise<PageShareStatus | null> {
	if (!(await ownedPage(id, userId))) return null;
	const share = await prisma.pageShare.findFirst({ where: { pageId: id, userId } });
	return share && !share.revokedAt ? { active: true, createdAt: share.createdAt.toISOString() } : { active: false, createdAt: null };
}

export type SharedPageView = {
	title: string;
	summary?: string;
	spec: PageSpec;
	updatedAt: string;
	botName: string | null;
};

/** Painel pelo token público: o que desenha a página, sem dono, conversa nem fontes. Revogado, apagado ou desconhecido = `null`. */
export async function getSharedPageByToken(token: string): Promise<SharedPageView | null> {
	if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
	const share = await prisma.pageShare.findFirst({ where: { tokenHash: hashHookSecret(token), revokedAt: null }, select: { pageId: true, userId: true } });
	if (!share) return null;
	const page = await prisma.page.findFirst({ where: { id: share.pageId, userId: share.userId, deletedAt: null } });
	if (!page) return null;
	const spec = parsePageSpec(page.specJson);
	if (!spec.ok) return null;
	const bot = await prisma.bot.findFirst({ where: { id: page.botId, ownerId: page.userId }, select: { name: true } });
	return {
		title: page.title,
		...(spec.spec.summary ? { summary: spec.spec.summary } : {}),
		spec: spec.spec,
		updatedAt: (page.refreshedAt ?? page.updatedAt).toISOString(),
		botName: bot?.name ?? null,
	};
}
