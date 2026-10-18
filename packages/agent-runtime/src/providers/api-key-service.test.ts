import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiKeyService, normalizeApiKey, type ApiKeyStore } from "./api-key-service.js";

const KEY = "sk-ant-api03-SEGREDO-ABCDEFGH";
beforeAll(() => {
	process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

function memoryStore() {
	const rows = new Map<string, Record<string, unknown>>();
	const id = (u: string, p: string) => `${u}:${p}`;
	const store: ApiKeyStore = {
		get: async (u, p) => (rows.get(id(u, p)) as never) ?? null,
		save: async (u, p, data) => void rows.set(id(u, p), { userId: u, provider: p, updatedAt: new Date(0), lastLimitAt: null, lastError: null, ...data }),
		update: async (u, p, data) => void (rows.has(id(u, p)) && rows.set(id(u, p), { ...rows.get(id(u, p)), ...data })),
		remove: async (u, p) => void rows.delete(id(u, p)),
	};
	return { store, rows };
}

describe("chaves de API no cofre", () => {
	it("guarda cifrada (nunca em claro), devolve status sem a chave e isola por usuário", async () => {
		const { store, rows } = memoryStore();
		const service = createApiKeyService({ store });
		await service.save("u1", "anthropic", `  ${KEY}  `, 7);
		const raw = JSON.stringify([...rows.values()]);
		expect(raw).not.toContain(KEY);
		expect(raw).toContain("v1:");
		const status = await service.status("u1", "anthropic");
		expect(status).toMatchObject({ provider: "anthropic", status: "connected", modelCount: 7 });
		expect(JSON.stringify(status)).not.toContain(KEY);
		expect(await service.getKey("u1", "anthropic")).toBe(KEY);
		expect(await service.getKey("u2", "anthropic")).toBeNull();
		expect(await service.getKey("u1", "opencode-go")).toBeNull();
		expect((await service.status("u2", "anthropic")).status).toBe("disconnected");
	});
	it("remove apaga a conexão", async () => {
		const { store } = memoryStore();
		const service = createApiKeyService({ store });
		await service.save("u1", "opencode-go", KEY);
		await service.remove("u1", "opencode-go");
		expect(await service.getKey("u1", "opencode-go")).toBeNull();
	});
	it("recusa chave malformada e cofre ausente", async () => {
		const service = createApiKeyService({ store: memoryStore().store });
		await expect(service.save("u1", "anthropic", "curta")).rejects.toMatchObject({ code: "invalid_key" });
		await expect(service.save("u1", "anthropic", "com espaço no meio 123")).rejects.toMatchObject({ code: "invalid_key" });
		const noVault = createApiKeyService({ store: memoryStore().store, vaultReady: () => false });
		await expect(noVault.save("u1", "anthropic", KEY)).rejects.toMatchObject({ code: "vault_unavailable", status: 503 });
		expect(normalizeApiKey(42)).toBeNull();
	});
});
