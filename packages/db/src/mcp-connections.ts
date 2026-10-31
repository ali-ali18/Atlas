import { Prisma } from "@prisma/client";
import type {
	McpAuthType,
	McpConnectionStatus,
	McpConnectionView,
	McpToolInfo,
} from "@workspace/shared";
import { buildStoredToolMarks, parseStoredToolMarks, resolveToolMarks, type ToolMarks } from "@workspace/shared";
import { prisma } from "./client.js";
import { ResourceOwnershipError } from "./conversations.js";
import { guideFromRow } from "./connector-guides.js";

type McpConnectionRow = Prisma.McpConnectionGetPayload<Record<string, never>>;

/** Registro interno (API/worker): view + segredos ainda cifrados. */
export type McpConnectionRecord = McpConnectionView & {
	secretsEnc: string | null;
	oauthStateHash: string | null;
};

export type CreateMcpConnectionInput = {
	userId?: string;
	catalogId: string | null;
	slug: string;
	name: string;
	url: string;
	authType: McpAuthType;
	status?: McpConnectionStatus;
	secretsEnc?: string | null;
	accountLabel?: string | null;
};

export type UpdateMcpConnectionInput = {
	name?: string;
	/** Migra conexões antigas para a URL atual do catálogo (ex.: Google → `builtin://...`). */
	url?: string;
	authType?: McpAuthType;
	status?: McpConnectionStatus;
	secretsEnc?: string | null;
	oauthStateHash?: string | null;
	tools?: McpToolInfo[];
	disabledTools?: string[];
	/** Substitui a marcação confirmada pelo dono (o caller mescla com `mergeToolMarks`). */
	toolMarks?: ToolMarks;
	confirmWrites?: boolean;
	lastError?: string | null;
	accountLabel?: string | null;
};

const AUTH_TYPES = new Set<McpAuthType>(["oauth", "api_key", "none"]);
const STATUSES = new Set<McpConnectionStatus>([
	"pending_auth",
	"connected",
	"error",
	"disabled",
]);

function parseTools(raw: Prisma.JsonValue | null): McpToolInfo[] {
	if (!Array.isArray(raw)) return [];
	const tools: McpToolInfo[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.name !== "string" || !record.name) continue;
		tools.push({
			name: record.name,
			title: typeof record.title === "string" ? record.title : undefined,
			description:
				typeof record.description === "string" ? record.description : undefined,
			inputSchema:
				record.inputSchema && typeof record.inputSchema === "object"
					? (record.inputSchema as Record<string, unknown>)
					: { type: "object", properties: {} },
			annotations:
				record.annotations && typeof record.annotations === "object"
					? (record.annotations as McpToolInfo["annotations"])
					: undefined,
		});
	}
	return tools;
}

function toRecord(row: McpConnectionRow): McpConnectionRecord {
	const tools = parseTools(row.toolsCacheJson);
	// Só vale a marca cuja definição (descrição + schema) é a que o dono confirmou; o resto volta a pedir confirmação.
	const resolved = resolveToolMarks(parseStoredToolMarks(row.toolMarksJson), tools);
	return {
		id: row.id,
		catalogId: row.catalogId,
		slug: row.slug,
		name: row.name,
		url: row.url,
		authType: AUTH_TYPES.has(row.authType as McpAuthType)
			? (row.authType as McpAuthType)
			: "none",
		status: STATUSES.has(row.status as McpConnectionStatus)
			? (row.status as McpConnectionStatus)
			: "error",
		tools,
		disabledTools: row.disabledTools,
		toolMarks: resolved.marks,
		staleToolMarks: resolved.stale,
		confirmWrites: row.confirmWrites,
		lastError: row.lastError,
		accountLabel: row.accountLabel,
		guide: guideFromRow(row),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		secretsEnc: row.secretsEnc,
		oauthStateHash: row.oauthStateHash,
	};
}

/** Remove os campos sensíveis antes de responder à UI. */
export function toMcpConnectionView(record: McpConnectionRecord): McpConnectionView {
	const { secretsEnc: _secrets, oauthStateHash: _state, ...view } = record;
	return view;
}

/** O claim validado migra o legado; nenhuma sessão recebe fallback global. */
export function ownerIds(userId?: string): string[] {
	return userId?.trim() && userId !== "default" ? [userId] : [];
}

/** Seleciona somente a conexão do dono explícito. */
export function resolveMcpConnection<T extends { userId: string }>(
	connections: T[],
	userId?: string,
): T | null {
	if (connections.length === 0) return null;
	if (ownerIds(userId).length === 0) return null;
	return connections.find((c) => c.userId === userId) ?? null;
}

export async function listMcpConnections(
	_userId?: string,
): Promise<McpConnectionRecord[]> {
	const rows = await prisma.mcpConnection.findMany({
		where: { userId: { in: ownerIds(_userId) } },
		orderBy: { createdAt: "asc" },
	});
	return rows.map(toRecord);
}

/**
 * Várias contas do mesmo conector são conexões distintas (slug único por conta):
 * nada é deduplicado por `catalogId`; só entram linhas do dono explícito.
 */
function onlyOwnerRows<T extends { userId: string }>(rows: T[], userId?: string): T[] {
	return rows.filter((row) => resolveMcpConnection([row], userId) !== null);
}

/** Conexões que entram nos runs (status "connected"), escopadas por dono (F1). */
export async function listConnectedMcpConnections(
	_userId?: string,
): Promise<McpConnectionRecord[]> {
	const rows = await prisma.mcpConnection.findMany({
		where: { status: "connected", userId: { in: ownerIds(_userId) } },
		orderBy: { createdAt: "asc" },
	});
	return onlyOwnerRows(rows, _userId).map(toRecord);
}

export async function getMcpConnection(
	id: string,
	userId?: string,
): Promise<McpConnectionRecord | null> {
	const row = await prisma.mcpConnection.findFirst({ where: { id, userId: { in: ownerIds(userId) } } });
	return row ? toRecord(row) : null;
}

/** Execução confirmada exige dono exato. */
export async function getStrictMcpConnection(id: string, userId: string): Promise<McpConnectionRecord | null> {
	if (ownerIds(userId).length === 0) return null;
	const row = await prisma.mcpConnection.findFirst({ where: { id, userId } });
	return row ? toRecord(row) : null;
}

export async function getMcpConnectionByStateHash(
	stateHash: string,
	userId?: string,
): Promise<McpConnectionRecord | null> {
	const row = await prisma.mcpConnection.findFirst({
		where: { oauthStateHash: stateHash, userId: { in: ownerIds(userId) } },
	});
	return row ? toRecord(row) : null;
}

/** State de uso único, consumido apenas pelo dono; não reivindica legado. */
export async function claimMcpConnectionByStateHash(
	stateHash: string,
	userId: string,
): Promise<McpConnectionRecord | null> {
	const row = await prisma.mcpConnection.findFirst({
		where: { oauthStateHash: stateHash, userId: { in: ownerIds(userId) } },
	});
	if (!row) return null;
	const claimed = await prisma.mcpConnection.updateMany({
		where: { id: row.id, oauthStateHash: stateHash, userId },
		data: { oauthStateHash: null },
	});
	if (claimed.count !== 1) return null;
	return getMcpConnection(row.id, userId);
}

export async function getMcpConnectionByCatalogId(
	catalogId: string,
	userId?: string,
): Promise<McpConnectionRecord | null> {
	// Com várias contas, devolve a mais antiga (determinístico); use a lista para todas.
	const row = await prisma.mcpConnection.findFirst({
		where: { catalogId, userId: { in: ownerIds(userId) } },
		orderBy: { createdAt: "asc" },
	});
	return row ? toRecord(row) : null;
}

/** Todas as contas do dono para um conector do catálogo. */
export async function listMcpConnectionsByCatalogId(
	catalogId: string,
	userId?: string,
): Promise<McpConnectionRecord[]> {
	const rows = await prisma.mcpConnection.findMany({
		where: { catalogId, userId: { in: ownerIds(userId) } },
		orderBy: { createdAt: "asc" },
	});
	return rows.map(toRecord);
}

/** Compatibilidade de callers; a reatribuição real ocorre no claim de boot. */
export async function claimMcpConnectionOwner(
	id: string,
	userId: string,
): Promise<McpConnectionRecord | null> {
	// Reatribuição de legado só no claim de boot, que valida owner e cardinalidade.
	return getMcpConnection(id, userId);
}

/** Limite do prefixo das tools (`mcpToolName` corta em 20): o sufixo tem que caber. */
const SLUG_MAX = 20;

/** Slug livre para o usuário: "notion", "notion-2", "notion-3"… (nunca reaproveita um existente). */
async function uniqueSlug(userId: string, rawBase: string): Promise<string> {
	const base = rawBase.slice(0, SLUG_MAX);
	const taken = new Set(
		(
			await prisma.mcpConnection.findMany({
				where: { userId, slug: { startsWith: base } },
				select: { slug: true },
			})
		).map((row) => row.slug),
	);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/[_-]+$/g, "")}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export async function createMcpConnection(
	input: CreateMcpConnectionInput,
): Promise<McpConnectionRecord> {
	const userId = input.userId;
	if (!userId || ownerIds(userId).length === 0) throw new ResourceOwnershipError();
	const row = await prisma.mcpConnection.create({
		data: {
			userId,
			catalogId: input.catalogId,
			slug: await uniqueSlug(userId, input.slug),
			name: input.name,
			url: input.url,
			authType: input.authType,
			status: input.status ?? "pending_auth",
			secretsEnc: input.secretsEnc ?? null,
			accountLabel: input.accountLabel ?? null,
		},
	});
	return toRecord(row);
}

export async function updateMcpConnection(
	id: string,
	patch: UpdateMcpConnectionInput,
	userId?: string,
): Promise<McpConnectionRecord | null> {
	// IDOR → 404, sem vazar existência de conexão de outro dono.
	if (userId !== undefined && ownerIds(userId).length === 0) return null;
	const data: Prisma.McpConnectionUpdateInput = {};
	if (patch.name !== undefined) data.name = patch.name;
	if (patch.url !== undefined) data.url = patch.url;
	if (patch.status !== undefined) data.status = patch.status;
	if (patch.authType !== undefined) data.authType = patch.authType;
	if (patch.secretsEnc !== undefined) data.secretsEnc = patch.secretsEnc;
	if (patch.oauthStateHash !== undefined) data.oauthStateHash = patch.oauthStateHash;
	if (patch.tools !== undefined) {
		data.toolsCacheJson = patch.tools as unknown as Prisma.InputJsonValue;
	}
	if (patch.disabledTools !== undefined) data.disabledTools = patch.disabledTools;
	if (patch.toolMarks !== undefined) {
		// A marca é gravada com o hash da definição atual. Relê pelo dono (escopo) para pegar tools e marcas guardadas.
		const current = await prisma.mcpConnection.findFirst({
			where: { id, ...(userId !== undefined ? { userId } : {}) },
			select: { toolsCacheJson: true, toolMarksJson: true },
		});
		if (!current) return null;
		const tools = patch.tools ?? parseTools(current.toolsCacheJson);
		// Sem lista de ferramentas não há o que validar: nada é gravado (e nada é apagado).
		if (tools.length > 0) {
			data.toolMarksJson = buildStoredToolMarks(patch.toolMarks, parseStoredToolMarks(current.toolMarksJson), tools) as unknown as Prisma.InputJsonValue;
		}
	}
	if (patch.confirmWrites !== undefined) data.confirmWrites = patch.confirmWrites;
	if (patch.lastError !== undefined) data.lastError = patch.lastError;
	if (patch.accountLabel !== undefined) data.accountLabel = patch.accountLabel;
	try {
		const row = await prisma.mcpConnection.update({ where: { id, ...(userId !== undefined ? { userId } : {}) }, data });
		return toRecord(row);
	} catch (error) {
		if ((error as { code?: string }).code === "P2025") return null;
		throw error;
	}
}

export async function deleteMcpConnection(id: string, userId?: string): Promise<boolean> {
	// IDOR → 404, sem vazar existência de conexão de outro dono.
	if (userId !== undefined && ownerIds(userId).length === 0) return false;
	try {
		await prisma.mcpConnection.delete({ where: { id, ...(userId !== undefined ? { userId } : {}) } });
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === "P2025") return false;
		throw error;
	}
}
