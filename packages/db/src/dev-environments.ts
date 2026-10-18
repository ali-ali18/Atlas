import { DEFAULT_DEV_VERIFIER_ENABLED, isDevApprovalMode, type DevApprovalMode } from "@workspace/shared";
import { prisma } from "./client.js";
import { getAccountConfig, patchAccountConfig } from "./settings.js";

export type DevEnvironmentRecord = {
	id: string;
	userId: string;
	repo: string;
	installCommand: string | null;
	startCommand: string | null;
	/** Comando de teste rápido (opcional). */
	testCommand: string | null;
	tier: "small" | "medium" | "large";
	network: "allowlist" | "full" | "off";
	allowlist: string[];
	/** `null` = padrão da conta. */
	approvalMode: DevApprovalMode | null;
	/** Prefixos liberados no modo "Lista liberada". */
	commandAllowlist: string[];
	/** JSON selado { NOME: valor }; só o servidor abre. */
	sealedSecrets: string | null;
	/** `auto` = detectado/aprendido pelo agente; `manual` = criado pelo usuário. */
	source: "manual" | "auto";
	/** Campos que o usuário editou; o agente não os sobrescreve. */
	userEditedFields: string[];
	createdAt: Date;
	updatedAt: Date;
};

type Row = NonNullable<Awaited<ReturnType<typeof prisma.devEnvironment.findFirst>>>;

function toRecord(row: Row): DevEnvironmentRecord {
	return {
		id: row.id,
		userId: row.userId,
		repo: row.repo,
		installCommand: row.installCommand,
		startCommand: row.startCommand,
		testCommand: row.testCommand,
		tier: row.tier === "medium" || row.tier === "large" ? row.tier : "small",
		network: row.network === "full" || row.network === "off" ? row.network : "allowlist",
		allowlist: row.allowlist,
		approvalMode: isDevApprovalMode(row.approvalMode) ? row.approvalMode : null,
		commandAllowlist: row.commandAllowlist,
		sealedSecrets: row.secrets,
		source: row.source === "auto" ? "auto" : "manual",
		userEditedFields: row.userEditedFields,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export type DevEnvironmentFields = {
	repo: string;
	installCommand: string | null;
	startCommand: string | null;
	testCommand?: string | null;
	tier: DevEnvironmentRecord["tier"];
	network: DevEnvironmentRecord["network"];
	allowlist: string[];
	approvalMode?: DevApprovalMode | null;
	commandAllowlist?: string[];
	source?: "manual" | "auto";
	userEditedFields?: string[];
};

export async function listDevEnvironments(userId: string): Promise<DevEnvironmentRecord[]> {
	const rows = await prisma.devEnvironment.findMany({ where: { userId }, orderBy: { repo: "asc" }, take: 200 });
	return rows.map(toRecord);
}

export async function getDevEnvironment(id: string, userId: string): Promise<DevEnvironmentRecord | null> {
	const row = await prisma.devEnvironment.findFirst({ where: { id, userId } });
	return row ? toRecord(row) : null;
}

export async function getDevEnvironmentByRepo(userId: string, repo: string): Promise<DevEnvironmentRecord | null> {
	const row = await prisma.devEnvironment.findUnique({ where: { userId_repo: { userId, repo: repo.toLowerCase() } } });
	return row ? toRecord(row) : null;
}

export async function countDevEnvironments(userId: string): Promise<number> {
	return prisma.devEnvironment.count({ where: { userId } });
}

export async function createDevEnvironment(userId: string, fields: DevEnvironmentFields): Promise<DevEnvironmentRecord> {
	return toRecord(await prisma.devEnvironment.create({ data: { userId, ...fields } }));
}

/** Atualiza só se for do usuário; devolve `null` se não existe. */
export async function updateDevEnvironment(
	id: string,
	userId: string,
	patch: Partial<DevEnvironmentFields> & { sealedSecrets?: string | null },
): Promise<DevEnvironmentRecord | null> {
	const { sealedSecrets, ...rest } = patch;
	const result = await prisma.devEnvironment.updateMany({
		where: { id, userId },
		data: { ...rest, ...(sealedSecrets !== undefined ? { secrets: sealedSecrets } : {}) },
	});
	return result.count ? getDevEnvironment(id, userId) : null;
}

export async function deleteDevEnvironment(id: string, userId: string): Promise<boolean> {
	const result = await prisma.devEnvironment.deleteMany({ where: { id, userId } });
	return result.count > 0;
}

/** Padrão da conta para aprovação de comandos (`null` = Lista liberada). */
export async function getDevApprovalDefault(userId: string): Promise<DevApprovalMode | null> {
	const row = await prisma.userSettings.findUnique({ where: { userId }, select: { devApprovalMode: true } });
	return isDevApprovalMode(row?.devApprovalMode) ? row.devApprovalMode : null;
}

export async function setDevApprovalDefault(userId: string, mode: DevApprovalMode | null): Promise<void> {
	await prisma.userSettings.upsert({ where: { userId }, create: { userId, devApprovalMode: mode }, update: { devApprovalMode: mode } });
}

/** Verificador inteligente da conta (`coding.verifier` na config da conta; ausente = ligado). */
export async function getDevVerifierEnabled(userId: string): Promise<boolean> {
	const config = await getAccountConfig(userId);
	return config.coding?.verifier ?? DEFAULT_DEV_VERIFIER_ENABLED;
}

export async function setDevVerifierEnabled(userId: string, enabled: boolean): Promise<void> {
	await patchAccountConfig(userId, { coding: { verifier: enabled } });
}

/** Acrescenta prefixos à lista do ambiente do repositório (cria o ambiente com os padrões se não existir). */
export async function addCommandPrefixesToRepo(userId: string, repo: string, prefixes: readonly string[], defaults: readonly string[]): Promise<string[]> {
	const existing = await getDevEnvironmentByRepo(userId, repo);
	const base = existing ? existing.commandAllowlist : [...defaults];
	const next = [...base];
	for (const prefix of prefixes) if (!next.includes(prefix)) next.push(prefix);
	if (existing) {
		await prisma.devEnvironment.updateMany({ where: { id: existing.id, userId }, data: { commandAllowlist: next } });
	} else {
		await prisma.devEnvironment.create({ data: { userId, repo: repo.toLowerCase(), commandAllowlist: next } });
	}
	return next;
}
