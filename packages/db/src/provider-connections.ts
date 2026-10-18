import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export type ProviderConnectionRecord = Prisma.ProviderConnectionGetPayload<
	Record<string, never>
>;
export type ProviderConnectionUpdate = Pick<
	Prisma.ProviderConnectionUpdateManyMutationInput,
	| "status"
	| "secretsEnc"
	| "oauthStateHash"
	| "accountEmail"
	| "scopes"
	| "accessExpiresAt"
	| "lastError"
	| "lastLimitAt"
>;
export type ProviderLockedStore = {
	get(): Promise<ProviderConnectionRecord | null>;
	update(data: ProviderConnectionUpdate): Promise<void>;
};

export async function getProviderConnection(
	userId: string,
	provider = "chatgpt",
) {
	return prisma.providerConnection.findFirst({ where: { userId, provider } });
}
export async function updateProviderConnection(
	userId: string,
	provider: string,
	data: ProviderConnectionUpdate,
) {
	const result = await prisma.providerConnection.updateMany({
		where: { userId, provider },
		data,
	});
	return result.count > 0;
}

/** State autentica o callback loopback; dono é derivado do registro, nunca da query. */
export async function findProviderLoginByState(stateHash: string) {
	return prisma.providerConnection.findFirst({
		where: { provider: "chatgpt", oauthStateHash: stateHash },
		include: { user: { select: { email: true } } },
	});
}

/** Lock de transação compartilhado API/worker, inclusive antes da criação da linha. */
export async function withProviderRefreshLock<T>(
	userId: string,
	provider: string,
	operation: (store: ProviderLockedStore) => Promise<T>,
): Promise<T> {
	return prisma.$transaction(
		async (tx) => {
			const lockKey = `provider-refresh:${userId}:${provider}`;
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
			// A leitura acontece somente depois do lock. Tokens rotativos nunca usam snapshot anterior.
			await tx.providerConnection.upsert({
				where: { userId_provider: { userId, provider } },
				create: { userId, provider },
				update: {},
			});
			return operation({
				get: () =>
					tx.providerConnection.findFirst({ where: { userId, provider } }),
				update: async (data) => {
					await tx.providerConnection.updateMany({
						where: { userId, provider },
						data,
					});
				},
			});
		},
		{ timeout: 25_000, maxWait: 15_000 },
	);
}

export async function getProviderUserEmail(
	userId: string,
): Promise<string | null> {
	return (
		(
			await prisma.user.findFirst({
				where: { id: userId },
				select: { email: true },
			})
		)?.email ?? null
	);
}

/** Cria ou atualiza a conexão do usuário (chaves de API); sempre escopada por `userId`. */
export async function saveProviderConnection(
	userId: string,
	provider: string,
	data: ProviderConnectionUpdate,
) {
	return prisma.providerConnection.upsert({
		where: { userId_provider: { userId, provider } },
		create: { userId, provider, ...data } as Prisma.ProviderConnectionUncheckedCreateInput,
		update: data,
	});
}

/** Apaga a linha (e o segredo cifrado) da conexão do usuário. */
export async function deleteProviderConnection(
	userId: string,
	provider: string,
): Promise<boolean> {
	const result = await prisma.providerConnection.deleteMany({
		where: { userId, provider },
	});
	return result.count > 0;
}
