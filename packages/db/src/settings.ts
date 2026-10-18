import { Prisma } from "@prisma/client";
import {
	ACCOUNT_CONFIG_MAX_BYTES,
	accountConfigByteSize,
	mergeAccountConfig,
	parseAccountConfig,
	type AccountConfigPatch,
	type AccountConfigV1,
	type UpdateUserSettingsInput,
	type UserSettings,
} from "@workspace/shared";
import { prisma } from "./client.js";

const LEGACY_SETTINGS_ID = "default";

/** `userId` é o dono validado (`ATLAS_OWNER_EMAIL`)? Só ele enxerga a linha legada. */
async function isValidatedOwner(userId: string): Promise<boolean> {
	const ownerEmail = process.env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
	if (!ownerEmail) return false;
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
	return user?.email.toLowerCase() === ownerEmail;
}

function toSettings(row: { sandboxAutoStart: boolean }) {
	return { sandboxAutoStart: row.sandboxAutoStart };
}

/**
 * Conta única: UserSettings é 1:1 com User.
 * - Com userId: lê a linha do usuário (`userId`); se não houver, faz
 *   fallback de LEITURA para a linha legada `id="default"` (pré-Fase 1) SÓ
 *   para o dono validado (`ATLAS_OWNER_EMAIL`): outro usuário nunca herda a
 *   configuração do legado. Novas linhas usam `id` cuid() — nunca `id=userId`.
 * - Sem userId (worker): lê a linha legada (comportamento antigo).
 */
export async function getUserSettings(userId?: string): Promise<UserSettings> {
	if (userId) {
		const own = await prisma.userSettings.findUnique({
			where: { userId },
		});
		if (own) return toSettings(own);
		if (await isValidatedOwner(userId)) {
			const legacy = await prisma.userSettings.findUnique({
				where: { id: LEGACY_SETTINGS_ID },
			});
			if (legacy) return toSettings(legacy);
		}
		const created = await prisma.userSettings.upsert({
			where: { userId },
			create: { userId, sandboxAutoStart: true },
			update: {},
		});
		return toSettings(created);
	}
	const row = await prisma.userSettings.upsert({
		where: { id: LEGACY_SETTINGS_ID },
		create: { id: LEGACY_SETTINGS_ID },
		update: {},
	});
	return toSettings(row);
}

/**
 * Conta única: grava pela sessão (`userId`). Sem userId (worker),
 * mantém o comportamento legado (`id="default"`). Retrocompatível.
 */
export async function updateUserSettings(
	patch: UpdateUserSettingsInput,
	userId?: string,
): Promise<UserSettings> {
	if (userId) {
		const row = await prisma.userSettings.upsert({
			where: { userId },
			create: {
				userId,
				sandboxAutoStart: patch.sandboxAutoStart ?? true,
			},
			update:
				patch.sandboxAutoStart === undefined
					? {}
					: { sandboxAutoStart: patch.sandboxAutoStart },
		});
		return toSettings(row);
	}
	const row = await prisma.userSettings.upsert({
		where: { id: LEGACY_SETTINGS_ID },
		create: {
			id: LEGACY_SETTINGS_ID,
			sandboxAutoStart: patch.sandboxAutoStart ?? true,
		},
		update:
			patch.sandboxAutoStart === undefined
				? {}
				: { sandboxAutoStart: patch.sandboxAutoStart },
	});
	return toSettings(row);
}

export class AccountConfigTooLargeError extends Error {
	constructor() {
		super(`A configuração passa de ${ACCOUNT_CONFIG_MAX_BYTES} bytes.`);
		this.name = "AccountConfigTooLargeError";
	}
}

/**
 * Configuração da conta (`UserSettings.configJson`). Lida SÓ pela linha do
 * próprio usuário: nunca cai na linha legada `id="default"` (como `autonomy.ts`).
 * Leitura tolerante: valor inválido ou de versão futura volta como config vazia.
 */
export async function getAccountConfig(userId: string): Promise<AccountConfigV1> {
	const row = await prisma.userSettings.findUnique({
		where: { userId },
		select: { configJson: true },
	});
	return parseAccountConfig(row?.configJson);
}

/**
 * Config do dono da conversa, para jobs de manutenção que só trazem o
 * `conversationId` (resumo). Caminho confiável do worker: o id vem da fila,
 * nunca de entrada do usuário. Conversa legada sem dono = config vazia.
 */
export async function getAccountConfigByConversation(conversationId: string): Promise<AccountConfigV1> {
	const conversation = await prisma.conversation.findUnique({
		where: { id: conversationId },
		select: { userId: true },
	});
	return conversation?.userId ? getAccountConfig(conversation.userId) : parseAccountConfig(null);
}

/**
 * Merge patch em transação com lock por usuário: duas abas gravando ao mesmo
 * tempo não perdem alteração. Devolve a config resultante.
 */
export async function patchAccountConfig(
	userId: string,
	patch: AccountConfigPatch,
): Promise<AccountConfigV1> {
	return prisma.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(88, hashtext(${`account-config:${userId}`}))`;
		const row = await tx.userSettings.findUnique({
			where: { userId },
			select: { configJson: true },
		});
		const next = mergeAccountConfig(row?.configJson, patch);
		if (accountConfigByteSize(next) > ACCOUNT_CONFIG_MAX_BYTES) throw new AccountConfigTooLargeError();
		const json = next as unknown as Prisma.InputJsonValue;
		await tx.userSettings.upsert({
			where: { userId },
			create: { userId, configJson: json },
			update: { configJson: json },
		});
		return next;
	});
}
