import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

/** Config do GitHub App da instância (linha única); segredos ainda cifrados em `secretsEnc`. */
export type GithubAppConfigRecord = {
	appId: string;
	slug: string;
	name: string;
	htmlUrl: string | null;
	clientId: string;
	ownerLogin: string | null;
	secretsEnc: string;
	createdAt: Date;
};

export type GithubInstallationRepo = { fullName: string; private: boolean };

export type GithubInstallationRecord = {
	id: string;
	userId: string;
	installationId: string;
	accountLogin: string;
	accountType: string;
	repositorySelection: string;
	/** `null` = ainda não lida (seleção "all"). */
	repositories: GithubInstallationRepo[] | null;
	suspendedAt: Date | null;
	createdAt: Date;
};

const CONFIG_ID = "default";

export async function getGithubAppConfigRecord(): Promise<GithubAppConfigRecord | null> {
	const row = await prisma.githubAppConfig.findUnique({ where: { id: CONFIG_ID } });
	if (!row) return null;
	return {
		appId: row.appId,
		slug: row.slug,
		name: row.name,
		htmlUrl: row.htmlUrl,
		clientId: row.clientId,
		ownerLogin: row.ownerLogin,
		secretsEnc: row.secretsEnc,
		createdAt: row.createdAt,
	};
}

export async function saveGithubAppConfigRecord(input: Omit<GithubAppConfigRecord, "createdAt">): Promise<void> {
	const data = {
		appId: input.appId,
		slug: input.slug,
		name: input.name,
		htmlUrl: input.htmlUrl,
		clientId: input.clientId,
		ownerLogin: input.ownerLogin,
		secretsEnc: input.secretsEnc,
	};
	await prisma.githubAppConfig.upsert({ where: { id: CONFIG_ID }, create: { id: CONFIG_ID, ...data }, update: data });
}

export async function deleteGithubAppConfigRecord(): Promise<void> {
	await prisma.githubAppConfig.deleteMany({ where: { id: CONFIG_ID } });
}

function parseRepos(raw: Prisma.JsonValue | null): GithubInstallationRepo[] | null {
	if (!Array.isArray(raw)) return null;
	const out: GithubInstallationRepo[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.fullName !== "string" || !rec.fullName) continue;
		out.push({ fullName: rec.fullName, private: rec.private === true });
	}
	return out;
}

function toInstallation(row: Prisma.GithubInstallationGetPayload<Record<string, never>>): GithubInstallationRecord {
	return {
		id: row.id,
		userId: row.userId,
		installationId: row.installationId,
		accountLogin: row.accountLogin,
		accountType: row.accountType,
		repositorySelection: row.repositorySelection,
		repositories: parseRepos(row.repositories),
		suspendedAt: row.suspendedAt,
		createdAt: row.createdAt,
	};
}

export type GithubInstallationInput = {
	userId: string;
	installationId: string;
	accountLogin: string;
	accountType: string;
	repositorySelection: string;
	repositories: GithubInstallationRepo[] | null;
	suspendedAt?: Date | null;
};

/**
 * Vincula (ou atualiza) uma instalação ao usuário. Uma instalação pertence a UM usuário:
 * se já existe vinculada a outro, recusa (devolve null) — nunca "rouba".
 */
export async function linkGithubInstallation(input: GithubInstallationInput): Promise<GithubInstallationRecord | null> {
	const existing = await prisma.githubInstallation.findUnique({ where: { installationId: input.installationId } });
	if (existing && existing.userId !== input.userId) return null;
	const data = {
		accountLogin: input.accountLogin,
		accountType: input.accountType,
		repositorySelection: input.repositorySelection,
		repositories: input.repositories ? (input.repositories as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
		suspendedAt: input.suspendedAt ?? null,
	};
	const row = await prisma.githubInstallation.upsert({
		where: { installationId: input.installationId },
		create: { userId: input.userId, installationId: input.installationId, ...data },
		update: data,
	});
	return toInstallation(row);
}

export async function listGithubInstallationsForUser(userId: string): Promise<GithubInstallationRecord[]> {
	const rows = await prisma.githubInstallation.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
	return rows.map(toInstallation);
}

/** Webhook: instalação pelo id do GitHub (o dono vem da linha, nunca do payload). */
export async function getGithubInstallationByInstallationId(installationId: string): Promise<GithubInstallationRecord | null> {
	const row = await prisma.githubInstallation.findUnique({ where: { installationId } });
	return row ? toInstallation(row) : null;
}

export type GithubInstallationPatch = {
	repositorySelection?: string;
	repositories?: GithubInstallationRepo[] | null;
	suspendedAt?: Date | null;
	accountLogin?: string;
};

export async function updateGithubInstallationByInstallationId(
	installationId: string,
	patch: GithubInstallationPatch,
): Promise<boolean> {
	const data: Prisma.GithubInstallationUpdateManyMutationInput = {};
	if (patch.repositorySelection !== undefined) data.repositorySelection = patch.repositorySelection;
	if (patch.repositories !== undefined) {
		data.repositories = patch.repositories ? (patch.repositories as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
	}
	if (patch.suspendedAt !== undefined) data.suspendedAt = patch.suspendedAt;
	if (patch.accountLogin !== undefined) data.accountLogin = patch.accountLogin;
	const res = await prisma.githubInstallation.updateMany({ where: { installationId }, data });
	return res.count > 0;
}

export async function deleteGithubInstallationByInstallationId(installationId: string): Promise<boolean> {
	const res = await prisma.githubInstallation.deleteMany({ where: { installationId } });
	return res.count > 0;
}

/** Remoção pelo dono (id interno): outro usuário recebe `null` (→ 404). */
export async function deleteGithubInstallationForUser(userId: string, id: string): Promise<GithubInstallationRecord | null> {
	const row = await prisma.githubInstallation.findFirst({ where: { id, userId } });
	if (!row) return null;
	await prisma.githubInstallation.deleteMany({ where: { id, userId } });
	return toInstallation(row);
}

/** A instalação (ativa) cobre `owner/repo`? */
export function installationCoversRepo(inst: GithubInstallationRecord, repo: string): boolean {
	if (inst.suspendedAt) return false;
	const key = repo.trim().toLowerCase();
	if (!key) return false;
	const owner = key.split("/")[0];
	if (inst.repositorySelection === "all") return inst.accountLogin.toLowerCase() === owner;
	return (inst.repositories ?? []).some((r) => r.fullName.toLowerCase() === key);
}

export async function findCoveringGithubInstallation(userId: string, repo: string): Promise<GithubInstallationRecord | null> {
	const all = await listGithubInstallationsForUser(userId);
	return all.find((inst) => installationCoversRepo(inst, repo)) ?? null;
}

/** Marca a entrega como vista; `false` = já processada (duplicada). */
export async function claimGithubAppDelivery(deliveryId: string): Promise<boolean> {
	try {
		await prisma.githubAppDelivery.create({ data: { deliveryId } });
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
		throw error;
	}
	if (Math.random() < 0.02) {
		await prisma.githubAppDelivery
			.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } })
			.catch(() => undefined);
	}
	return true;
}

/** Desfaz o `claim` (falha ao enfileirar): o retry do GitHub volta a ser processado. */
export async function releaseGithubAppDelivery(deliveryId: string): Promise<void> {
	await prisma.githubAppDelivery.deleteMany({ where: { deliveryId } });
}

/** Assinatura opcional no rodapé das escritas do bot no GitHub (as escritas sempre usam o app). */
export type GithubWriteSettings = { signature: boolean; signatureText: string | null };

const SIGNATURE_MAX = 120;

export function normalizeGithubSignatureText(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const text = Array.from(raw)
		.filter((ch) => ch.charCodeAt(0) >= 32)
		.join("")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, SIGNATURE_MAX);
	return text || null;
}

export async function getGithubWriteSettings(userId: string): Promise<GithubWriteSettings> {
	const row = await prisma.userSettings.findUnique({
		where: { userId },
		select: { githubSignature: true, githubSignatureText: true },
	});
	return {
		signature: row?.githubSignature === true,
		signatureText: normalizeGithubSignatureText(row?.githubSignatureText),
	};
}

export async function saveGithubWriteSettings(userId: string, patch: Partial<GithubWriteSettings>): Promise<GithubWriteSettings> {
	const data: { githubSignature?: boolean; githubSignatureText?: string | null } = {};
	if (patch.signature !== undefined) data.githubSignature = patch.signature;
	if (patch.signatureText !== undefined) data.githubSignatureText = normalizeGithubSignatureText(patch.signatureText);
	await prisma.userSettings.upsert({ where: { userId }, create: { userId, ...data }, update: data });
	return getGithubWriteSettings(userId);
}
