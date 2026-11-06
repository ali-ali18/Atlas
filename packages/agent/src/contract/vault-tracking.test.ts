import { describe, expect, it } from "vitest";
import type { Vault } from "../ports/vault.js";
import { trackVault } from "./vault-tracking.js";

const inner: Vault = {
	listHandles: async () => [{ id: "h1", label: "Conta" }],
	resolve: async (user, id) => (user === "dono" && id === "h1" ? { reveal: () => "senha-comum-123" } : id === "vazio" ? { reveal: () => "" } : null),
};

describe("trackVault", () => {
	it("registra o valor ao resolver, sem alterar o que a tool recebe", async () => {
		const { vault, secrets } = trackVault(inner);
		expect(secrets()).toEqual([]);
		const value = await vault.resolve("dono", "h1");
		expect(value?.reveal()).toBe("senha-comum-123");
		expect(secrets()).toEqual(["senha-comum-123"]);
		expect(await vault.listHandles("dono")).toEqual([{ id: "h1", label: "Conta" }]);
	});

	it("handle de outro dono ou vazio não registra nada", async () => {
		const { vault, secrets } = trackVault(inner);
		expect(await vault.resolve("outro", "h1")).toBeNull();
		await vault.resolve("dono", "vazio");
		expect(secrets()).toEqual([]);
	});
});
