import { describe, expect, it } from "vitest";
import { githubIdentityCardText, parseConversationCard, parseGithubIdentityInfo } from "./index.js";

describe("cartão de identidade do GitHub", () => {
	it("aceita só links de instalação seguros", () => {
		const base = { reason: "not_installed", repo: "a/b", appName: null };
		expect(parseGithubIdentityInfo({ ...base, installUrl: "/v1/github-app/install" })?.installUrl).toBe("/v1/github-app/install");
		expect(parseGithubIdentityInfo({ ...base, installUrl: "https://github.com/settings/installations/1" })?.installUrl).toBe("https://github.com/settings/installations/1");
		expect(parseGithubIdentityInfo({ ...base, installUrl: "javascript:alert(1)" })?.installUrl).toBeNull();
		expect(parseGithubIdentityInfo({ ...base, installUrl: "https://evil.test/x" })?.installUrl).toBeNull();
		expect(parseGithubIdentityInfo({ reason: "x" })).toBeUndefined();
	});
	it("texto do cartão cita o bot e o repositório", () => {
		const t = githubIdentityCardText({ reason: "not_installed", repo: "a/b", installUrl: "/v1/github-app/install", appName: "meu-app" });
		expect(t.description).toContain("a/b");
		expect(t.description).toContain("meu-app[bot]");
		expect(t.installLabel).toBe("Instalar o app neste repositório");
		expect(t.confirmLabel).toBe("Pronto, já instalei");
		expect(`${t.title} ${t.description}`).not.toMatch(/sua conta|minha conta/i);
		const p = githubIdentityCardText({ reason: "no_permission", repo: "a/b", installUrl: "https://github.com/settings/installations/1", appName: null });
		expect(p.installLabel).toBe("Aceitar permissões no GitHub");
	});
	it("sobrevive à persistência do cartão de confirmação", () => {
		const card = { v: 1, kind: "confirm", confirmId: "c1", title: "t", status: "pending", githubIdentity: { reason: "no_permission", repo: "a/b", installUrl: null, appName: "x" } };
		expect(parseConversationCard(JSON.stringify(card))).toMatchObject({ githubIdentity: { reason: "no_permission", repo: "a/b" } });
	});
});
