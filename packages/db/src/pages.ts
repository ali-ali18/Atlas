/**
 * Páginas vivas (relatório/painel desenhado inline no chat). Toda função recebe o `userId` da sessão/run e filtra
 * por ele na própria query (`where: { id, userId }`): página ou bot de outro dono é indistinguível de inexistente
 * (null / `not_found`). A atualização usa concorrência otimista por `revision` (updateMany condicionado).
 */
import { Prisma } from "@prisma/client";
import { effectivePageGroupIds, pageSummaryText, parsePageSources, parsePageSpec, type PageSource, type PageSpec } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";
import { assertGroupUsable, findOrCreateRoutineGroup } from "./routine-groups.js";

/** Revisões guardadas por página (a atual inclusive). */
export const PAGE_REVISIONS_KEPT = 10;
export const PAGE_LIST_LIMIT = 50;

export type PageRecord = {
	id: string;
	botId: string;
	conversationId: string | null;
	/** Grupo explícito (o mesmo das rotinas); o efetivo, que considera a rotina ligada, vem na listagem. */
	groupId: string | null;
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
	/** Grupo efetivo: o explícito ou, na falta, o da rotina ligada ao painel. */
	groupId: string | null;
	/** Grupo explícito (o que "Sem grupo" desfaz); null quando o grupo só vem da rotina. */
	explicitGroupId: string | null;
	/** Nome do grupo efetivo (para o agente e a UI), null sem grupo. */
	groupName: string | null;
};

type PageRow = {
	id: string;
	botId: string;
	conversationId: string | null;
	groupId?: string | null;
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
		groupId: row.groupId ?? null,
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

/** Colunas da listagem: tudo menos o `specJson` (o grande). `sourcesJson` é curto (até 20 fontes). */
const PAGE_LIST_SELECT = {
	id: true,
	botId: true,
	groupId: true,
	title: true,
	sourcesJson: true,
	revision: true,
	refreshedAt: true,
	updatedAt: true,
} as const satisfies Prisma.PageSelect;

/** Só o campo `summary` de cada spec (operador JSON no banco), escopado pelo dono. */
async function pageSummaries(userId: string, ids: string[]): Promise<Map<string, unknown>> {
	if (ids.length === 0) return new Map();
	const rows = await prisma.$queryRaw<Array<{ id: string; summary: unknown }>>`
		SELECT "id", "specJson"->'summary' AS "summary"
		FROM "pages"
		WHERE "userId" = ${userId} AND "id" = ANY(${ids}::text[])
	`;
	return new Map(rows.map((row) => [row.id, row.summary]));
}

export type CreatePageInput = {
	botId: string;
	conversationId?: string | null;
	/** Grupo já resolvido (ver `resolvePageGroup`); deve ser do mesmo dono e bot, senão lança "Grupo não encontrado". */
	groupId?: string | null;
	spec: PageSpec;
	sources?: PageSource[];
};

/** Cria a página (revisão 1). `null` se o bot não é do usuário. */
export async function createPage(userId: string, input: CreatePageInput): Promise<PageRecord | null> {
	if (ownerIds(userId).length === 0) return null;
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: userId }, select: { id: true } });
	if (!bot) return null;
	if (input.groupId) await assertGroupUsable(userId, input.botId, input.groupId);
	const sources = input.sources ?? [];
	const row = await prisma.$transaction(async (tx) => {
		const created = await tx.page.create({
			data: {
				userId,
				botId: input.botId,
				conversationId: input.conversationId ?? null,
				groupId: input.groupId ?? null,
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

/** Páginas do bot (mais recentes primeiro), só do dono. `null` se o bot não é do usuário (a rota responde 404). */
export async function listBotPagesForUser(userId: string, botId: string, limit = PAGE_LIST_LIMIT): Promise<PageListItem[] | null> {
	if (ownerIds(userId).length === 0) return null;
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } });
	if (!bot) return null;
	// Sem o `specJson` (até 200 mil caracteres por painel): a lista só precisa do resumo, lido à parte no SQL.
	const rows = await prisma.page.findMany({
		where: { userId, botId, deletedAt: null },
		orderBy: { updatedAt: "desc" },
		take: Math.max(1, Math.min(limit, 200)),
		select: PAGE_LIST_SELECT,
	});
	const ids = rows.map((row) => row.id);
	const summaries = await pageSummaries(userId, ids);
	const linked = await prisma.routine.findMany({
		where: { userId, botId, pageId: { in: ids }, groupId: { not: null } },
		select: { pageId: true, groupId: true },
	});
	const effective = effectivePageGroupIds(rows, linked);
	const groupRows = await prisma.routineGroup.findMany({ where: { botId, userId }, select: { id: true, name: true } });
	const groupNames = new Map(groupRows.map((group) => [group.id, group.name]));
	return rows.map((row) => {
		const sources = parsePageSources(row.sourcesJson);
		const summary = pageSummaryText(summaries.get(row.id));
		return {
			id: row.id,
			botId: row.botId,
			title: row.title,
			revision: row.revision,
			updatedAt: row.updatedAt.toISOString(),
			refreshedAt: row.refreshedAt?.toISOString() ?? null,
			...(summary ? { summary } : {}),
			sourceCount: sources.ok ? sources.sources.length : 0,
			groupId: effective.get(row.id) ?? null,
			explicitGroupId: row.groupId ?? null,
			groupName: groupNames.get(effective.get(row.id) ?? "") ?? null,
		};
	});
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

export type SetPageGroupResult = { ok: true; page: PageRecord } | { ok: false; error: "not_found" | "group_not_found" };

/**
 * Move o painel para um grupo (ou tira dele, `null`). O grupo precisa ser do mesmo usuário E do mesmo bot do painel;
 * página ou grupo de outro dono é indistinguível de inexistente. Não conta como edição (não muda `updatedAt` nem a revisão).
 */
export async function setPageGroup(id: string, userId: string, groupId: string | null): Promise<SetPageGroupResult> {
	if (ownerIds(userId).length === 0) return { ok: false, error: "not_found" };
	const current = await prisma.page.findFirst({ where: { id, userId, deletedAt: null } });
	if (!current) return { ok: false, error: "not_found" };
	if (groupId) {
		const group = await prisma.routineGroup.findFirst({ where: { id: groupId, botId: current.botId, userId }, select: { id: true } });
		if (!group) return { ok: false, error: "group_not_found" };
	}
	const moved = await prisma.page.updateMany({ where: { id, userId, deletedAt: null }, data: { groupId, updatedAt: current.updatedAt } });
	if (moved.count === 0) return { ok: false, error: "not_found" };
	const row = await prisma.page.findFirst({ where: { id, userId, deletedAt: null } });
	const page = row ? toRecord(row as PageRow) : null;
	return page ? { ok: true, page } : { ok: false, error: "not_found" };
}

/** `c` + ≥20 caracteres minúsculos/dígitos: cara de id (cuid), não de nome de grupo. */
const GROUP_ID_SHAPE = /^c[a-z0-9]{20,}$/;

/**
 * Resolve o grupo que o agente citou: id existente, nome existente (sem caixa) ou nome novo (cria o grupo no bot).
 * Algo com cara de id que não é um grupo deste dono e bot é recusado ("Grupo não encontrado"), nunca vira nome novo.
 */
export async function resolvePageGroup(userId: string, botId: string, ref: string): Promise<{ id: string; name: string; created: boolean }> {
	const clean = ref.trim();
	if (!clean || ownerIds(userId).length === 0) throw new Error("Grupo não encontrado");
	const byId = await prisma.routineGroup.findFirst({ where: { id: clean, botId, userId }, select: { id: true, name: true } });
	if (byId) return { id: byId.id, name: byId.name, created: false };
	if (GROUP_ID_SHAPE.test(clean)) throw new Error("Grupo não encontrado");
	const { group, created } = await findOrCreateRoutineGroup(userId, botId, clean);
	return { id: group.id, name: group.name, created };
}

/** Apaga (soft delete). `false` se não existe ou é de outro dono. */
export async function deletePage(id: string, userId: string): Promise<boolean> {
	if (ownerIds(userId).length === 0) return false;
	const result = await prisma.page.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: new Date() } });
	return result.count > 0;
}

/** Garante que a página é do mesmo usuário e bot e não foi apagada. Lança "Página não encontrada" caso contrário (outro dono é indistinguível de inexistente). */
export async function assertPageUsable(userId: string | undefined, botId: string, pageId: string): Promise<string> {
	if (ownerIds(userId).length === 0) throw new Error("Página não encontrada");
	const found = await prisma.page.findFirst({ where: { id: pageId, botId, userId, deletedAt: null }, select: { id: true } });
	if (!found) throw new Error("Página não encontrada");
	return found.id;
}

/** Revisões guardadas (mais nova primeiro), só se a página é do usuário. */
export async function listPageRevisionsForUser(id: string, userId: string): Promise<Array<{ revision: number; createdAt: string }>> {
	if (ownerIds(userId).length === 0) return [];
	const page = await prisma.page.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
	if (!page) return [];
	const rows = await prisma.pageRevision.findMany({ where: { pageId: id }, orderBy: { revision: "desc" }, take: PAGE_REVISIONS_KEPT });
	return rows.map((row) => ({ revision: row.revision, createdAt: row.createdAt.toISOString() }));
}
