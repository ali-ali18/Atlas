import { describe, expect, it } from "vitest";
import { detectSecretsInText, domainMatches, findSecretRefs, nameMatchesSite, pickVaultLoginForPage, registrableDomain, replaceDetected, replaceSecretRefs, suggestSecretName } from "./vault.js";

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
	it("casa só o host exato; www e o domínio sem www são o mesmo site", () => {
		expect(domainMatches("https://painel.exemplo.com/login", "https://painel.exemplo.com")).toBe(true);
		expect(domainMatches("https://github.com/login", "github.com")).toBe(true);
		expect(domainMatches("https://www.github.com/login", "https://github.com")).toBe(true);
		expect(domainMatches("https://github.com/login", "https://www.github.com")).toBe(true);
		expect(domainMatches("https://exemplo.com.evil.io/login", "exemplo.com")).toBe(false);
	});
	it("outro subdomínio é outro site (google.com não vale para sites.google.com)", () => {
		expect(domainMatches("https://sites.google.com/view/x", "https://google.com")).toBe(false);
		expect(domainMatches("https://accounts.github.com/login", "https://github.com")).toBe(false);
		expect(domainMatches("https://app.exemplo.com.br/x", "exemplo.com.br")).toBe(false);
		expect(domainMatches("https://x.painel.exemplo.com/login", "https://painel.exemplo.com")).toBe(false);
		expect(domainMatches("https://painel.exemplo.com/login", "exemplo.com")).toBe(false);
	});
	it("localhost e IP comparam a porta; http só em localhost", () => {
		expect(domainMatches("http://localhost:3000/login", "http://localhost:3000")).toBe(true);
		expect(domainMatches("http://localhost:9999/login", "http://localhost:3000")).toBe(false);
		expect(domainMatches("http://localhost/login", "http://localhost:3000")).toBe(false);
		expect(domainMatches("https://203.0.113.5:8443/x", "https://203.0.113.5:8443")).toBe(true);
		expect(domainMatches("https://203.0.113.5:9443/x", "https://203.0.113.5:8443")).toBe(false);
		expect(domainMatches("http://203.0.113.5/x", "https://203.0.113.5")).toBe(false);
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
		expect(kinds("C:/Users/ana/Documents/projeto_final_versao_dois.pdf")).toEqual([]);
	});
	it("troca pelo marcador", () => {
		const text = "url ?secret=Zk3jQ9sLpW2mXv fim";
		const d = detectSecretsInText(text);
		expect(replaceDetected(text, d, ["hook"])).toBe("url ?secret={{secret:hook}} fim");
	});
});

describe("casamento nome ↔ domínio", () => {
	it("palavra do nome igual ao domínio registrável casa", () => {
		expect(nameMatchesSite(["Painel - Kodea"], "https://panel.kodea.com.br/login")).toBe(true);
		expect(nameMatchesSite(["Painel - Kodea"], "https://kodea.com.br")).toBe(true);
	});
	it("é conservador: outro domínio, subdomínio de terceiro, http e palavra genérica não casam", () => {
		expect(nameMatchesSite(["Painel - Kodea"], "https://kodea.evil.com/login")).toBe(false);
		expect(nameMatchesSite(["Painel - Kodea"], "https://panel.outra.com.br")).toBe(false);
		expect(nameMatchesSite(["Painel - Kodea"], "http://panel.kodea.com.br")).toBe(false);
		expect(nameMatchesSite(["Painel"], "https://painel.com.br")).toBe(true);
		expect(nameMatchesSite(["Painel - Kodea"], "https://painel.outra.com")).toBe(false);
	});
	it("pickVaultLoginForPage: URL salva primeiro, nome só para item sem URL, ambíguo não chuta", () => {
		const url = { kind: "login", name: "github", siteUrl: "https://github.com" };
		const noUrl = { kind: "login", name: "Painel - Kodea", label: "Painel - Kodea", siteUrl: null };
		const other = { kind: "login", name: "kodea-admin", siteUrl: null };
		expect(pickVaultLoginForPage([url, noUrl], "https://panel.kodea.com.br")).toMatchObject({ kind: "match", byName: true });
		expect(pickVaultLoginForPage([url, noUrl], "https://www.github.com")).toMatchObject({ kind: "match", byName: false });
		expect(pickVaultLoginForPage([url, noUrl], "https://gist.github.com").kind).toBe("none");
		expect(pickVaultLoginForPage([noUrl, other], "https://panel.kodea.com.br").kind).toBe("ambiguous");
		expect(pickVaultLoginForPage([url, noUrl], "https://example.org").kind).toBe("none");
	});
});

describe("Public Suffix List: sufixo de plataforma exige host exato", () => {
	it("atacante.vercel.app não casa com item de meuapp.vercel.app; x.github.io não casa com outro github.io", () => {
		expect(domainMatches("https://atacante.vercel.app/login", "https://meuapp.vercel.app")).toBe(false);
		expect(domainMatches("https://meuapp.vercel.app/login", "https://meuapp.vercel.app")).toBe(true);
		expect(domainMatches("https://x.github.io", "https://y.github.io")).toBe(false);
		expect(domainMatches("https://x.github.io", "https://github.io")).toBe(false);
		expect(domainMatches("https://x.netlify.app", "https://netlify.app")).toBe(false);
		expect(domainMatches("https://a.pages.dev", "https://b.pages.dev")).toBe(false);
		expect(domainMatches("https://a.web.app", "https://b.web.app")).toBe(false);
		expect(domainMatches("https://a.herokuapp.com", "https://b.herokuapp.com")).toBe(false);
		expect(domainMatches("https://a.blogspot.com", "https://b.blogspot.com")).toBe(false);
		expect(domainMatches("https://a.onrender.com", "https://b.onrender.com")).toBe(false);
		// subdomínio de um tenant de plataforma também é outro host: exato
		expect(domainMatches("https://sub.meuapp.vercel.app", "https://meuapp.vercel.app")).toBe(false);
	});
	it("registrableDomain usa a PSL (inclui sufixos privados)", () => {
		expect(registrableDomain("panel.kodea.com.br")).toBe("kodea.com.br");
		expect(registrableDomain("atacante.vercel.app")).toBe("atacante.vercel.app");
		expect(registrableDomain("a.b.github.io")).toBe("b.github.io");
		expect(registrableDomain("localhost")).toBe("localhost");
	});
	it("site salvo com subdomínio vale só para ele, nunca para filhos, irmãos nem para o domínio raiz", () => {
		expect(domainMatches("https://panel.kodea.com.br/login", "https://panel.kodea.com.br")).toBe(true);
		expect(domainMatches("https://x.panel.kodea.com.br/login", "https://panel.kodea.com.br")).toBe(false);
		expect(domainMatches("https://admin.kodea.com.br/login", "https://panel.kodea.com.br")).toBe(false);
		expect(domainMatches("https://kodea.com.br/login", "https://panel.kodea.com.br")).toBe(false);
		expect(domainMatches("https://kodea.xyz/login", "https://panel.kodea.com.br")).toBe(false);
		expect(domainMatches("https://github.xyz/login", "https://github.com")).toBe(false);
	});
});
