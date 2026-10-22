/**
 * Páginas vivas (relatório/painel desenhado inline no chat). Toda função recebe o `userId` da sessão/run e filtra
 * por ele na própria query (`where: { id, userId }`): página ou bot de outro dono é indistinguível de inexistente
 * (null / `not_found`). A atualização usa concorrência otimista por `revision` (updateMany condicionado).
 */
import { Prisma } from "@prisma/client";
import { parsePageSources, parsePageSpec, type PageSource, type PageSpec } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

/** Revisões guardadas por página (a atual inclusive). */
export const PAGE_REVISIONS_KEPT = 10;
export const PAGE_LIST_LIMIT = 50;

export type PageRecord = {
	id: string;
	botId: string;
	conversationId: string | null;
	title: string;
	spec: PageSpec;
	sources: PageSource[];
	revision: number;
	refreshedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type PageListItem = Pick<PageRecord, "id" | "botId" | "title" | "revision" | "updatedAt" | "refreshedAt"> & {
	summary?: string;
	sourceCount: number;
};

type PageRow = {
	id: string;
	botId: string;
	conversationId: string | null;
	title: string;
	specJson: Prisma.JsonValue;
	sourcesJson: Prisma.JsonValue;
	revision: number;
	refreshedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

function toRecord(row: PageRow): PageRecord | null {
	const spec = parsePageSpec(row.specJson);
	if (!spec.ok) return null;
	const sources = parsePageSources(row.sourcesJson);
	return {
		id: row.id,
		botId: row.botId,
		conversationId: row.conversationId,
		title: row.title,
		spec: spec.spec,
		sources: sources.ok ? sources.sources : [],
		revision: row.revision,
		refreshedAt: row.refreshedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

const toJson = (value: unknown) => value as Prisma.InputJsonValue;

export type CreatePageInput = {
	botId: string;
	conversationId?: string | null;
	spec: PageSpec;
	sources?: PageSource[];
};

/** Cria a página (revisão 1). `null` se o bot não é do usuário. */
export async function createPage(userId: string, input: CreatePageInput): Promise<PageRecord | null> {
	if (ownerIds(userId).length === 0) return null;
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: userId }, select: { id: true } });
	if (!bot) return null;
	const sources = input.sources ?? [];
	const row = await prisma.$transaction(async (tx) => {
		const created = await tx.page.create({
			data: {
				userId,
				botId: input.botId,
				conversationId: input.conversationId ?? null,
				title: input.spec.title,
				specJson: toJson(input.spec),
				sourcesJson: toJson(sources),
			},
		});
		await tx.pageRevision.create({
			data: { pageId: created.id, revision: created.revision, specJson: toJson(input.spec), sourcesJson: toJson(sources) },
		});
		return created;
	});
	return toRecord(row as PageRow);
}

export async function getPageForUser(id: string, userId: string): Promise<PageRecord | null> {
	if (ownerIds(userId).length === 0) return null;
	const row = await prisma.page.findFirst({ where: { id, userId, deletedAt: null } });
	return row ? toRecord(row as PageRow) : null;
}

/** Páginas do bot (mais recentes primeiro), só do dono. */
export async function listBotPagesForUser(userId: string, botId: string, limit = PAGE_LIST_LIMIT): Promise<PageListItem[]> {
	if (ownerIds(userId).length === 0) return [];
	const rows = await prisma.page.findMany({
		where: { userId, botId, deletedAt: null },
		orderBy: { updatedAt: "desc" },
		take: Math.max(1, Math.min(limit, 200)),
	});
	const items: PageListItem[] = [];
	for (const row of rows as PageRow[]) {
		const record = toRecord(row);
		if (!record) continue;
		items.push({
			id: record.id,
			botId: record.botId,
			title: record.title,
			revision: record.revision,
			updatedAt: record.updatedAt,
			refreshedAt: record.refreshedAt,
			...(record.spec.summary ? { summary: record.spec.summary } : {}),
			sourceCount: record.sources.length,
		});
	}
	return items;
}

export type UpdatePageInput = {
	spec: PageSpec;
	sources?: PageSource[];
	/** Revisão que o chamador leu; diferente da atual → `conflict` (ninguém sobrescreve sem querer). */
	expectedRevision?: number;
	/** Marca como atualizada com dados novos (rotina/refresh), não só edição de layout. */
	refreshed?: boolean;
};

export type UpdatePageResult = { ok: true; page: PageRecord } | { ok: false; error: "not_found" | "conflict" };

export async function updatePage(id: string, userId: string, input: UpdatePageInput): Promise<UpdatePageResult> {
	if (ownerIds(userId).length === 0) return { ok: false, error: "not_found" };
	return prisma.$transaction(async (tx): Promise<UpdatePageResult> => {
		const current = await tx.page.findFirst({ where: { id, userId, deletedAt: null } });
		if (!current) return { ok: false, error: "not_found" };
		if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) return { ok: false, error: "conflict" };
		const previous = parsePageSources(current.sourcesJson);
		const sources = input.sources ?? (previous.ok ? previous.sources : []);
		const next = current.revision + 1;
		const claimed = await tx.page.updateMany({
			where: { id, userId, deletedAt: null, revision: current.revision },
			data: {
				title: input.spec.title,
				specJson: toJson(input.spec),
				sourcesJson: toJson(sources),
				revision: { increment: 1 },
				...(input.refreshed ? { refreshedAt: new Date() } : {}),
			},
		});
		if (claimed.count === 0) return { ok: false, error: "conflict" };
		await tx.pageRevision.create({ data: { pageId: id, revision: next, specJson: toJson(input.spec), sourcesJson: toJson(sources) } });
		await tx.pageRevision.deleteMany({ where: { pageId: id, revision: { lt: next - PAGE_REVISIONS_KEPT + 1 } } });
		const row = await tx.page.findFirst({ where: { id, userId } });
		const page = row ? toRecord(row as PageRow) : null;
		return page ? { ok: true, page } : { ok: false, error: "not_found" };
	});
}

/** Apaga (soft delete). `false` se não existe ou é de outro dono. */
export async function deletePage(id: string, userId: string): Promise<boolean> {
	if (ownerIds(userId).length === 0) return false;
	const result = await prisma.page.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: new Date() } });
	return result.count > 0;
}

/** Revisões guardadas (mais nova primeiro), só se a página é do usuário. */
export async function listPageRevisionsForUser(id: string, userId: string): Promise<Array<{ revision: number; createdAt: string }>> {
	if (ownerIds(userId).length === 0) return [];
	const page = await prisma.page.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
	if (!page) return [];
	const rows = await prisma.pageRevision.findMany({ where: { pageId: id }, orderBy: { revision: "desc" }, take: PAGE_REVISIONS_KEPT });
	return rows.map((row) => ({ revision: row.revision, createdAt: row.createdAt.toISOString() }));
}
