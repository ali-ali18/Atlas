import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { memoryVaultStore } from "../secrets/memory-store.js";
import { VaultService } from "../secrets/vault-service.js";
import { findVaultLoginOffer, listVaultLoginDomains, vaultLoginsPromptLine, vaultTriedKey, withVaultOffer } from "./vault-login-offer.js";

let vault: VaultService;

beforeAll(async () => {
	process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
	vault = new VaultService(memoryVaultStore());
	await vault.create("u", { kind: "login", name: "chatgpt", label: "ChatGPT", siteUrl: "https://chatgpt.com", username: "ana@x.com", payload: { password: "p" } });
	await vault.create("u", { kind: "secret", name: "tok", payload: { value: "v" } });
});

describe("oferta do Cofre", () => {
	it("casa pelo domínio registrável (mesma regra do login_fill) e só em https", async () => {
		expect(await findVaultLoginOffer(vault, "u", "https://auth.chatgpt.com/login")).toMatchObject({ name: "chatgpt", domain: "chatgpt.com", username: "ana@x.com" });
		expect(await findVaultLoginOffer(vault, "u", "https://chatgpt.com.evil.example/login")).toBeNull();
		expect(await findVaultLoginOffer(vault, "u", "http://chatgpt.com/login")).toBeNull();
		expect(await findVaultLoginOffer(vault, "outro", "https://chatgpt.com/login")).toBeNull();
	});

	it("lista só domínios e escreve a linha curta do prompt", async () => {
		expect(await listVaultLoginDomains(vault, "u")).toEqual(["chatgpt.com"]);
		expect(vaultLoginsPromptLine(["chatgpt.com", "github.com"])).toContain("chatgpt.com, github.com");
		expect(vaultLoginsPromptLine([])).toBe("");
	});

	it("withVaultOffer: captcha, conector e rotina nunca recebem oferta; cofre indisponível cai no humano", async () => {
		const base = { url: "https://chatgpt.com/login" };
		const deps = { vault, userId: "u", loginAsked: new Set<string>() };
		expect((await withVaultOffer(base, deps)).vault?.name).toBe("chatgpt");
		expect((await withVaultOffer({ ...base, reason: "captcha" as const }, deps)).vault).toBeUndefined();
		expect((await withVaultOffer({ ...base, composioToolkit: "linear" }, deps)).vault).toBeUndefined();
		expect((await withVaultOffer(base, { ...deps, unattended: true })).vault).toBeUndefined();
		const broken = { listMeta: async () => { throw new Error("sem chave"); } };
		expect(await withVaultOffer(base, { ...deps, vault: broken })).toEqual(base);
	});

	it("Cofre já usado nesta URL: não oferece de novo e explica o passo extra", async () => {
		const asked = new Set([vaultTriedKey("https://chatgpt.com/login")]);
		const event = await withVaultOffer({ url: "https://chatgpt.com/login" }, { vault, userId: "u", loginAsked: asked });
		expect(event.vault).toBeUndefined();
		expect(event.vaultTried).toContain("mais um passo");
	});
});
