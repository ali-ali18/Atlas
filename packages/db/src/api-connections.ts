import { Prisma } from "@prisma/client";
import {
	clampRateLimit,
	type ApiAuth,
	type ApiAuthKind,
	type ApiConnectionStatus,
	type ApiConnectionView,
	type ApiGroup,
	type ApiOperation,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { ResourceOwnershipError } from "./conversations.js";
import { ownerIds } from "./mcp-connections.js";

type ApiConnectionRow = Prisma.ApiConnectionGetPayload<Record<string, never>>;
type ApiConnectionLiteRow = Omit<ApiConnectionRow, "catalogJson">;

/** Registro interno (API/worker): view + segredos ainda cifrados e a spec de autenticação. */
export type ApiConnectionRecord = ApiConnectionView & {
	specUrl: string;
	auth: ApiAuth;
	secretsEnc: string | null;
	oauthStateHash: string | null;
};

/** Registro com o catálogo de operações (execução e busca). */
export type ApiConnectionWithCatalog = ApiConnectionRecord & { catalog: ApiOperation[] };

export type CreateApiConnectionInput = {
	userId?: string;
	slug: string;
	name: string;
	baseUrl: string;
	specUrl: string;
	auth: ApiAuth;
	catalog: ApiOperation[];
	groups: ApiGroup[];
	allowedTags: string[];
	status?: ApiConnectionStatus;
	secretsEnc?: string | null;
	rateLimitRps?: number;
	accountLabel?: string | null;
};

export type UpdateApiConnectionInput = {
	name?: string;
	status?: ApiConnectionStatus;
	secretsEnc?: string | null;
	oauthStateHash?: string | null;
	allowedTags?: string[];
	rateLimitRps?: number;
	lastError?: string | null;
	accountLabel?: string | null;
	/** Reconexão com a spec atualizada. */
	spec?: { specUrl: string; auth: ApiAuth; catalog: ApiOperation[]; groups: ApiGroup[] };
};

const STATUSES = new Set<ApiConnectionStatus>(["pending_auth", "connected", "error", "disabled"]);
const KINDS = new Set<ApiAuthKind>(["oauth2", "apiKey", "bearer", "none"]);

const LITE_SELECT = {
	id: true,
	userId: true,
	slug: true,
	name: true,
	baseUrl: true,
	specUrl: true,
	authKind: true,
	authJson: true,
	status: true,
	secretsEnc: true,
	oauthStateHash: true,
	groupsJson: true,
	allowedTags: true,
	operationCount: true,
	rateLimitRps: true,
	lastError: true,
	accountLabel: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.ApiConnectionSelect;

function asObject(raw: Prisma.JsonValue): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function parseGroups(raw: Prisma.JsonValue): ApiGroup[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		const row = asObject(item as Prisma.JsonValue);
		if (typeof row.tag !== "string") return [];
		const n = (value: unknown) => (typeof value === "number" ? value : 0);
		return [{ tag: row.tag, total: n(row.total), read: n(row.read), write: n(row.write) }];
	});
}

function parseCatalog(raw: Prisma.JsonValue): ApiOperation[] {
	return Array.isArray(raw) ? (raw as unknown as ApiOperation[]) : [];
}

function toRecord(row: ApiConnectionLiteRow): ApiConnectionRecord {
	const authKind = KINDS.has(row.authKind as ApiAuthKind) ? (row.authKind as ApiAuthKind) : "none";
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		domain: new URL(row.baseUrl).hostname,
		baseUrl: row.baseUrl,
		authKind,
		status: STATUSES.has(row.status as ApiConnectionStatus) ? (row.status as ApiConnectionStatus) : "error",
		lastError: row.lastError,
		groups: parseGroups(row.groupsJson),
		allowedTags: row.allowedTags,
		operationCount: row.operationCount,
		rateLimitRps: clampRateLimit(row.rateLimitRps),
		accountLabel: row.accountLabel,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		specUrl: row.specUrl,
		auth: { ...(asObject(row.authJson) as ApiAuth), kind: authKind },
		secretsEnc: row.secretsEnc,
		oauthStateHash: row.oauthStateHash,
	};
}

/** Remove os campos sensíveis antes de responder à UI. */
export function toApiConnectionView(record: ApiConnectionRecord): ApiConnectionView {
	const { secretsEnc: _secrets, oauthStateHash: _state, specUrl: _spec, auth: _auth, ...view } = record;
	return view;
}

export async function listApiConnections(userId?: string): Promise<ApiConnectionRecord[]> {
	const rows = await prisma.apiConnection.findMany({
		where: { userId: { in: ownerIds(userId) } },
		orderBy: { createdAt: "asc" },
		select: LITE_SELECT,
	});
	return rows.map(toRecord);
}

/** Conexões ativas do dono (entram nos runs). */
export async function listConnectedApiConnections(userId?: string): Promise<ApiConnectionRecord[]> {
	const rows = await prisma.apiConnection.findMany({
		where: { userId: { in: ownerIds(userId) }, status: "connected" },
		orderBy: { createdAt: "asc" },
		select: LITE_SELECT,
	});
	return rows.map(toRecord);
}

export async function getApiConnection(id: string, userId?: string): Promise<ApiConnectionRecord | null> {
	const row = await prisma.apiConnection.findFirst({ where: { id, userId: { in: ownerIds(userId) } }, select: LITE_SELECT });
	return row ? toRecord(row) : null;
}

/** Execução: dono exato, com catálogo. */
export async function getApiConnectionWithCatalog(id: string, userId: string): Promise<ApiConnectionWithCatalog | null> {
	if (ownerIds(userId).length === 0) return null;
	const row = await prisma.apiConnection.findFirst({ where: { id, userId } });
	return row ? { ...toRecord(row), catalog: parseCatalog(row.catalogJson) } : null;
}

export async function getApiConnectionByBaseUrl(baseUrl: string, userId?: string): Promise<ApiConnectionRecord | null> {
	// Com várias contas na mesma base, devolve a mais antiga (determinístico).
	const row = await prisma.apiConnection.findFirst({ where: { baseUrl, userId: { in: ownerIds(userId) } }, orderBy: { createdAt: "asc" }, select: LITE_SELECT });
	return row ? toRecord(row) : null;
}

/** Todas as contas do dono para uma mesma base. */
export async function listApiConnectionsByBaseUrl(baseUrl: string, userId?: string): Promise<ApiConnectionRecord[]> {
	const rows = await prisma.apiConnection.findMany({ where: { baseUrl, userId: { in: ownerIds(userId) } }, orderBy: { createdAt: "asc" }, select: LITE_SELECT });
	return rows.map(toRecord);
}

/** State de uso único, consumido apenas pelo dono. */
export async function claimApiConnectionByStateHash(stateHash: string, userId: string): Promise<ApiConnectionRecord | null> {
	if (ownerIds(userId).length === 0) return null;
	const row = await prisma.apiConnection.findFirst({ where: { oauthStateHash: stateHash, userId }, select: { id: true } });
	if (!row) return null;
	const claimed = await prisma.apiConnection.updateMany({ where: { id: row.id, oauthStateHash: stateHash, userId }, data: { oauthStateHash: null } });
	if (claimed.count !== 1) return null;
	return getApiConnection(row.id, userId);
}

const SLUG_MAX = 40;

/** Slug livre para o usuário: "bling", "bling-2"… (nunca reaproveita um existente). */
async function uniqueSlug(userId: string, rawBase: string): Promise<string> {
	const base = rawBase.slice(0, SLUG_MAX);
	const taken = new Set(
		(await prisma.apiConnection.findMany({ where: { userId, slug: { startsWith: base } }, select: { slug: true } })).map((row) => row.slug),
	);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/[_-]+$/g, "")}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export async function createApiConnection(input: CreateApiConnectionInput): Promise<ApiConnectionRecord> {
	const userId = input.userId;
	if (!userId || ownerIds(userId).length === 0) throw new ResourceOwnershipError();
	const row = await prisma.apiConnection.create({
		data: {
			userId,
			slug: await uniqueSlug(userId, input.slug),
			name: input.name,
			baseUrl: input.baseUrl,
			specUrl: input.specUrl,
			authKind: input.auth.kind,
			authJson: input.auth as unknown as Prisma.InputJsonValue,
			status: input.status ?? "pending_auth",
			secretsEnc: input.secretsEnc ?? null,
			catalogJson: input.catalog as unknown as Prisma.InputJsonValue,
			groupsJson: input.groups as unknown as Prisma.InputJsonValue,
			allowedTags: input.allowedTags,
			operationCount: input.catalog.length,
			rateLimitRps: clampRateLimit(input.rateLimitRps),
			accountLabel: input.accountLabel ?? null,
		},
		select: LITE_SELECT,
	});
	return toRecord(row);
}

export async function updateApiConnection(id: string, patch: UpdateApiConnectionInput, userId: string): Promise<ApiConnectionRecord | null> {
	// IDOR: 404 para conexão de outro dono, sem vazar existência.
	if (ownerIds(userId).length === 0) return null;
	const data: Prisma.ApiConnectionUpdateInput = {};
	if (patch.name !== undefined) data.name = patch.name;
	if (patch.status !== undefined) data.status = patch.status;
	if (patch.secretsEnc !== undefined) data.secretsEnc = patch.secretsEnc;
	if (patch.oauthStateHash !== undefined) data.oauthStateHash = patch.oauthStateHash;
	if (patch.allowedTags !== undefined) data.allowedTags = patch.allowedTags;
	if (patch.rateLimitRps !== undefined) data.rateLimitRps = clampRateLimit(patch.rateLimitRps);
	if (patch.lastError !== undefined) data.lastError = patch.lastError;
	if (patch.accountLabel !== undefined) data.accountLabel = patch.accountLabel;
	if (patch.spec) {
		data.specUrl = patch.spec.specUrl;
		data.authKind = patch.spec.auth.kind;
		data.authJson = patch.spec.auth as unknown as Prisma.InputJsonValue;
		data.catalogJson = patch.spec.catalog as unknown as Prisma.InputJsonValue;
		data.groupsJson = patch.spec.groups as unknown as Prisma.InputJsonValue;
		data.operationCount = patch.spec.catalog.length;
	}
	try {
		const row = await prisma.apiConnection.update({ where: { id, userId }, data, select: LITE_SELECT });
		return toRecord(row);
	} catch (error) {
		if ((error as { code?: string }).code === "P2025") return null;
		throw error;
	}
}

export async function deleteApiConnection(id: string, userId: string): Promise<boolean> {
	if (ownerIds(userId).length === 0) return false;
	try {
		await prisma.apiConnection.delete({ where: { id, userId } });
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === "P2025") return false;
		throw error;
	}
}
