import { prisma } from "./client.js";

/**
 * Cofre do usuário (persistência). Toda função filtra por `userId`: item de
 * outro usuário é indistinguível de item inexistente (a rota devolve 404).
 * Cifragem fica na camada acima (envelope por usuário); aqui só texto selado.
 */

export type UserSecretKind = "secret" | "login";

export type UserSecretRow = {
	id: string;
	userId: string;
	kind: UserSecretKind;
	name: string;
	label: string;
	description: string;
	siteUrl: string | null;
	domain: string | null;
	username: string | null;
	valueEnc: string;
	createdAt: Date;
	updatedAt: Date;
	lastUsedAt: Date | null;
	alwaysBots: string[];
};

export type UserSecretMeta = Omit<UserSecretRow, "valueEnc" | "userId">;

export type UserSecretAuditAction = "created" | "updated" | "revealed" | "copied" | "used" | "rotated" | "approved";

export type UserSecretAuditRow = {
	id: string;
	action: string;
	actor: string;
	botId: string | null;
	botName: string | null;
	conversationId: string | null;
	detail: string | null;
	createdAt: Date;
};

function toRow(row: Record<string, unknown>): UserSecretRow {
	return { ...(row as UserSecretRow), kind: row.kind === "login" ? "login" : "secret" };
}

const META_SELECT = {
	id: true,
	kind: true,
	name: true,
	label: true,
	description: true,
	siteUrl: true,
	domain: true,
	username: true,
	createdAt: true,
	updatedAt: true,
	lastUsedAt: true,
	alwaysBots: true,
} as const;

export async function getUserVaultKey(userId: string): Promise<string | null> {
	const row = await prisma.userVaultKey.findUnique({ where: { userId }, select: { wrappedKey: true } });
	return row?.wrappedKey ?? null;
}

/** Cria a chave do usuário uma única vez (corrida: quem perde lê a vencedora). */
export async function createUserVaultKey(userId: string, wrappedKey: string): Promise<string> {
	try {
		await prisma.userVaultKey.create({ data: { userId, wrappedKey } });
		return wrappedKey;
	} catch {
		const existing = await getUserVaultKey(userId);
		if (existing) return existing;
		throw new Error("Não foi possível criar a chave do cofre");
	}
}

export async function rewrapUserVaultKey(userId: string, wrappedKey: string): Promise<void> {
	await prisma.userVaultKey.update({ where: { userId }, data: { wrappedKey, rotatedAt: new Date() } });
}

export async function listUserVaultKeys(): Promise<Array<{ userId: string; wrappedKey: string }>> {
	return prisma.userVaultKey.findMany({ select: { userId: true, wrappedKey: true } });
}

export async function listUserSecrets(userId: string): Promise<UserSecretMeta[]> {
	const rows = await prisma.userSecret.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, select: META_SELECT });
	return rows.map((row) => ({ ...row, kind: row.kind === "login" ? "login" : "secret" }) as UserSecretMeta);
}

export async function listUserSecretRows(userId: string): Promise<UserSecretRow[]> {
	const rows = await prisma.userSecret.findMany({ where: { userId } });
	return rows.map((row) => toRow(row));
}

export async function getUserSecretById(userId: string, id: string): Promise<UserSecretRow | null> {
	const row = await prisma.userSecret.findFirst({ where: { id, userId } });
	return row ? toRow(row) : null;
}

export async function getUserSecretByName(userId: string, name: string): Promise<UserSecretRow | null> {
	const row = await prisma.userSecret.findFirst({ where: { userId, name } });
	return row ? toRow(row) : null;
}

export type UserSecretWrite = {
	id: string;
	kind: UserSecretKind;
	name: string;
	label?: string;
	description?: string;
	siteUrl?: string | null;
	domain?: string | null;
	username?: string | null;
	valueEnc: string;
};

export async function createUserSecretRow(userId: string, input: UserSecretWrite): Promise<UserSecretRow> {
	const row = await prisma.userSecret.create({
		data: {
			id: input.id,
			userId,
			kind: input.kind,
			name: input.name,
			label: input.label ?? "",
			description: input.description ?? "",
			siteUrl: input.siteUrl ?? null,
			domain: input.domain ?? null,
			username: input.username ?? null,
			valueEnc: input.valueEnc,
		},
	});
	return toRow(row);
}

export async function updateUserSecretRow(
	userId: string,
	id: string,
	patch: Partial<Omit<UserSecretWrite, "id" | "kind">> & { alwaysBots?: string[] },
): Promise<UserSecretRow | null> {
	const result = await prisma.userSecret.updateMany({ where: { id, userId }, data: patch });
	if (result.count !== 1) return null;
	return getUserSecretById(userId, id);
}

export async function deleteUserSecretRow(userId: string, id: string): Promise<boolean> {
	const result = await prisma.userSecret.deleteMany({ where: { id, userId } });
	return result.count === 1;
}

export async function touchUserSecret(userId: string, id: string): Promise<void> {
	await prisma.userSecret.updateMany({ where: { id, userId }, data: { lastUsedAt: new Date() } });
}

export async function appendUserSecretAudit(
	userId: string,
	secretId: string,
	entry: { action: UserSecretAuditAction; actor?: "user" | "bot"; botId?: string; botName?: string; conversationId?: string; detail?: string },
): Promise<void> {
	// Só audita item do dono (FK + conferência explícita).
	const owned = await prisma.userSecret.findFirst({ where: { id: secretId, userId }, select: { id: true } });
	if (!owned) return;
	await prisma.userSecretAudit.create({
		data: {
			secretId,
			userId,
			action: entry.action,
			actor: entry.actor ?? "user",
			botId: entry.botId ?? null,
			botName: entry.botName?.slice(0, 80) ?? null,
			conversationId: entry.conversationId ?? null,
			detail: entry.detail?.slice(0, 300) ?? null,
		},
	});
}

export async function listUserSecretAudit(userId: string, secretId: string, take = 50): Promise<UserSecretAuditRow[]> {
	return prisma.userSecretAudit.findMany({
		where: { secretId, userId },
		orderBy: { createdAt: "desc" },
		take,
		select: { id: true, action: true, actor: true, botId: true, botName: true, conversationId: true, detail: true, createdAt: true },
	});
}

/** Apagar o usuário: some a chave de dados (tudo vira ilegível) e os itens/auditoria. */
export async function deleteUserVault(userId: string): Promise<void> {
	await prisma.$transaction([
		prisma.userSecret.deleteMany({ where: { userId } }),
		prisma.userVaultKey.deleteMany({ where: { userId } }),
	]);
}
