import { describe, expect, it } from "vitest";
import { detectSecretsInText, domainMatches, findSecretRefs, registrableDomain, replaceDetected, replaceSecretRefs, suggestSecretName } from "./vault.js";

describe("refs", () => {
	it("acha secret, rotina e login", () => {
		const refs = findSecretRefs("a {{secret:meu-token}} b {{ secret:rotina:minha-rotina }} c {{login:github.password}} {{login:site}} {{secret:x:y:z}}");
		expect(refs.map((r) => r.kind)).toEqual(["secret", "routine", "login", "login"]);
		expect(refs[2]).toMatchObject({ name: "github", field: "password" });
		expect(refs[3]).toMatchObject({ field: "password" });
	});
	it("replaceSecretRefs", () => {
		expect(replaceSecretRefs("k={{secret:a}}", (r) => (r.kind === "secret" ? "V" : undefined))).toBe("k=V");
		expect(replaceSecretRefs("k={{secret:b}}", () => undefined)).toBe("k={{secret:b}}");
	});
	it("nome sugerido", () => expect(suggestSecretName("Minha Chave (X)")).toBe("minha-chave-x"));
});

describe("domínio", () => {
	it("casa subdomínios do mesmo site", () => {
		expect(domainMatches("https://accounts.github.com/login", "https://github.com")).toBe(true);
		expect(domainMatches("https://app.exemplo.com.br/x", "exemplo.com.br")).toBe(true);
		expect(domainMatches("https://painel.exemplo.com/login", "exemplo.com")).toBe(true);
		expect(domainMatches("https://painel.exemplo.com/login", "https://painel.exemplo.com")).toBe(true);
		expect(domainMatches("https://exemplo.com.evil.io/login", "exemplo.com")).toBe(false);
	});
	it("recusa phishing e http", () => {
		expect(domainMatches("https://github.com.evil.io/login", "https://github.com")).toBe(false);
		expect(domainMatches("https://githhub.com", "https://github.com")).toBe(false);
		expect(domainMatches("http://github.com", "https://github.com")).toBe(false);
		expect(domainMatches("https://evil.com/?u=github.com", "github.com")).toBe(false);
	});
	it("registrável", () => expect(registrableDomain("a.b.site.com.br")).toBe("site.com.br"));
});

describe("detector", () => {
	const kinds = (t: string) => detectSecretsInText(t).map((d) => d.kind);
	it("positivos", () => {
		expect(kinds("https://x.com/v1/hooks/abc?secret=Zk3jQ9sLpW2mXv")).toEqual(["query-secret"]);
		expect(kinds("Authorization: Bearer abcdefghij1234567890")).toEqual(["bearer"]);
		expect(kinds("minha chave sk-abcdefghijklmnopqrstuvwx1234")).toEqual(["api-key"]);
		expect(kinds("ghp_" + "a1B2c3D4e5".repeat(4))).toEqual(["api-key"]);
		expect(kinds("xoxb-1234567890-abcdefghij")).toEqual(["api-key"]);
		expect(kinds("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef123456")).toEqual(["jwt"]);
		expect(kinds("postgres://user:S3nh4Forte@db.host/app")).toEqual(["url-credentials"]);
		expect(kinds("token Zk3jQ9sLpW2mXvB7nR4tYc8HdF5gA1uE6oIx")).toEqual(["high-entropy"]);
	});
	it("negativos", () => {
		expect(kinds("oi, tudo bem? me ajuda com um relatório")).toEqual([]);
		expect(kinds("https://exemplo.com/artigos/como-fazer-bolo-de-cenoura-com-cobertura-de-chocolate")).toEqual([]);
		expect(kinds("commit 0123456789abcdef0123456789abcdef01234567")).toEqual([]);
		expect(kinds("use ?secret={{secret:rotina:x}} no n8n")).toEqual([]);
		expect(kinds("senha=xxxxxxxx")).toEqual([]);
		expect(kinds("C:/Users/alisson/Documents/projeto_final_versao_dois.pdf")).toEqual([]);
	});
	it("troca pelo marcador", () => {
		const text = "url ?secret=Zk3jQ9sLpW2mXv fim";
		const d = detectSecretsInText(text);
		expect(replaceDetected(text, d, ["hook"])).toBe("url ?secret={{secret:hook}} fim");
	});
});
