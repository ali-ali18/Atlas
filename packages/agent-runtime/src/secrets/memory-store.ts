/** Armazenamento do cofre em memória (testes de API e do runtime). */
import type { UserSecretAuditRow, UserSecretRow, UserRoutineWebhook } from "@workspace/db";
import type { VaultStore } from "./vault-service.js";

/** Armazenamento em memória que respeita o dono, como o Prisma faz. */
export function memoryVaultStore(routines: UserRoutineWebhook[] = []): VaultStore & { rows: UserSecretRow[]; keys: Map<string, string>; auditRows: Array<UserSecretAuditRow & { secretId: string; userId: string }> } {
	const rows: UserSecretRow[] = [];
	const keys = new Map<string, string>();
	const auditRows: Array<UserSecretAuditRow & { secretId: string; userId: string }> = [];
	return {
		rows,
		keys,
		auditRows,
		getKey: async (userId) => keys.get(userId) ?? null,
		createKey: async (userId, wrapped) => {
			if (!keys.has(userId)) keys.set(userId, wrapped);
			return keys.get(userId)!;
		},
		listRows: async (userId) => rows.filter((row) => row.userId === userId),
		getById: async (userId, id) => rows.find((row) => row.id === id && row.userId === userId) ?? null,
		getByName: async (userId, name) => rows.find((row) => row.name === name && row.userId === userId) ?? null,
		create: async (userId, input) => {
			const row: UserSecretRow = {
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
				createdAt: new Date(),
				updatedAt: new Date(),
				lastUsedAt: null,
				alwaysBots: [],
			};
			rows.push(row);
			return row;
		},
		update: async (userId, id, patch) => {
			const row = rows.find((item) => item.id === id && item.userId === userId);
			if (!row) return null;
			Object.assign(row, patch, { updatedAt: new Date() });
			return row;
		},
		remove: async (userId, id) => {
			const index = rows.findIndex((row) => row.id === id && row.userId === userId);
			if (index < 0) return false;
			rows.splice(index, 1);
			return true;
		},
		touch: async (userId, id) => {
			const row = rows.find((item) => item.id === id && item.userId === userId);
			if (row) row.lastUsedAt = new Date();
		},
		audit: async (userId, secretId, entry) => {
			if (!rows.some((row) => row.id === secretId && row.userId === userId)) return;
			auditRows.push({ id: `a${auditRows.length}`, secretId, userId, action: entry.action, actor: entry.actor ?? "user", botId: entry.botId ?? null, botName: entry.botName ?? null, conversationId: entry.conversationId ?? null, detail: entry.detail ?? null, createdAt: new Date() });
		},
		listAudit: async (userId, secretId) => auditRows.filter((row) => row.secretId === secretId && row.userId === userId).reverse(),
		routineWebhooks: async () => routines,
	};
}

