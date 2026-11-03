import { describe, expect, it } from "vitest";
import { installedKey } from "./catalog-installed";
import { clearInstalled } from "./catalog-installed-store";
import type { CacheStorage } from "./home-cache";

function memory(initial: Record<string, string>, fail = false): CacheStorage & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: async (key) => data[key] ?? null,
		setItem: async (key, value) => void (data[key] = value),
		removeItem: async (key) => void delete data[key],
		getAllKeys: async () => {
			if (fail) throw new Error("disco");
			return Object.keys(data);
		},
	};
}

describe("limpar o instalado ao sair", () => {
	it("apaga a chave de todas as contas e deixa o resto", async () => {
		const storage = memory({ [installedKey("https://a.com", "a@x.com")]: "{}", [installedKey("https://b.com", "b@x.com")]: "{}", "atlas.home.v2:x": "keep" });
		expect(await clearInstalled(storage)).toBe(true);
		expect(Object.keys(storage.data)).toEqual(["atlas.home.v2:x"]);
	});
	it("falha de armazenamento devolve false, sem lançar", async () => {
		expect(await clearInstalled(memory({}, true))).toBe(false);
	});
});

describe("instalado por conta", () => {
	it("a chave muda com o servidor e a conta (e ignora maiúscula do e-mail)", () => {
		expect(installedKey("https://a.com", "Ana@x.com")).toBe(installedKey("https://a.com", "ana@x.com"));
		expect(installedKey("https://a.com", "ana@x.com")).not.toBe(installedKey("https://b.com", "ana@x.com"));
		expect(installedKey("https://a.com", "ana@x.com")).not.toBe(installedKey("https://a.com", "bia@x.com"));
	});
});
