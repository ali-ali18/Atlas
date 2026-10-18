import { describe, expect, it } from "vitest";
import {
	buildEgressAllowlist,
	hostMatchesAllowlist,
	normalizeDomainPattern,
	normalizeEnvRepo,
	parseDevEnvBody,
	redactableValues,
	resolveSessionTier,
	validateSecretName,
	validateSecretValue,
} from "./dev-environment.js";
import { redactSecrets } from "./redact-secrets.js";

describe("resolveSessionTier", () => {
	const base = { defaultTier: "small", globalMax: "large" } as const;
	it("usa o tier do ambiente sem pedido", () => {
		expect(resolveSessionTier({ ...base, envTier: "medium" })).toEqual({ tier: "medium", clamped: false });
	});
	it("o pedido pode reduzir mas não passar do ambiente", () => {
		expect(resolveSessionTier({ ...base, envTier: "medium", requested: "small" }).tier).toBe("small");
		expect(resolveSessionTier({ ...base, envTier: "medium", requested: "large" })).toEqual({ tier: "medium", clamped: true });
	});
	it("o teto global limita o ambiente e o pedido", () => {
		expect(resolveSessionTier({ ...base, globalMax: "medium", envTier: "large" }).tier).toBe("medium");
		expect(resolveSessionTier({ ...base, globalMax: "small", requested: "large" })).toEqual({ tier: "small", clamped: true });
	});
	it("sem ambiente, o teto é o global", () => {
		expect(resolveSessionTier({ ...base, requested: "large" }).tier).toBe("large");
		expect(resolveSessionTier({ ...base }).tier).toBe("small");
	});
});

describe("domínios", () => {
	it("normaliza e rejeita", () => {
		expect(normalizeDomainPattern("HTTPS://Pypi.org/simple")).toBe("pypi.org");
		expect(normalizeDomainPattern("*.npmjs.org")).toBe("*.npmjs.org");
		expect(normalizeDomainPattern("*.com")).toBeNull();
		expect(normalizeDomainPattern("localhost")).toBeNull();
		expect(normalizeDomainPattern("")).toBeNull();
	});
	it("casa exato e curinga (só subdomínios)", () => {
		const list = buildEgressAllowlist(["meu-registro.empresa.com"]);
		expect(list).toContain("github.com");
		expect(hostMatchesAllowlist("github.com", list)).toBe(true);
		expect(hostMatchesAllowlist("raw.githubusercontent.com", list)).toBe(true);
		expect(hostMatchesAllowlist("githubusercontent.com", list)).toBe(false);
		expect(hostMatchesAllowlist("registry.npmjs.org", list)).toBe(true);
		expect(hostMatchesAllowlist("meu-registro.empresa.com", list)).toBe(true);
		expect(hostMatchesAllowlist("empresa.com", list)).toBe(false);
		expect(hostMatchesAllowlist("example.com", list)).toBe(false);
		expect(hostMatchesAllowlist("1.2.3.4", list)).toBe(false);
	});
	it("o preset não repete domínios do usuário", () => {
		const list = buildEgressAllowlist(["GitHub.com"]);
		expect(list.filter((item) => item === "github.com")).toHaveLength(1);
	});
});

describe("segredos", () => {
	it("valida nomes e valores", () => {
		expect(validateSecretName("DATABASE_URL")).toEqual({ name: "DATABASE_URL" });
		expect("error" in validateSecretName("1ABC")).toBe(true);
		expect("error" in validateSecretName("GH_TOKEN")).toBe(true);
		expect("error" in validateSecretName("http_proxy")).toBe(true);
		expect("error" in validateSecretValue("")).toBe(true);
		expect(validateSecretValue("abc")).toEqual({ value: "abc" });
	});
	it("valores injetados são redigidos da saída", () => {
		const secrets = { API_KEY: "s3cr3t-valor-xyz", CURTO: "ab" };
		const values = redactableValues(secrets);
		expect(values).toEqual(["s3cr3t-valor-xyz"]);
		expect(redactSecrets("key=s3cr3t-valor-xyz ok ab", values)).toBe("key=[redacted] ok ab");
	});
});

describe("parseDevEnvBody", () => {
	it("cria com repo normalizado", () => {
		const parsed = parseDevEnvBody(
			{ repo: "https://github.com/Acme/Web.git", installCommand: "  pnpm i \n", tier: "medium", network: "off", allowlist: ["Pypi.org"] },
			{ partial: false },
		);
		expect(parsed.value).toEqual({ repo: "acme/web", installCommand: "pnpm i", tier: "medium", network: "off", allowlist: ["pypi.org"] });
	});
	it("rejeita entradas inválidas", () => {
		expect(parseDevEnvBody({ repo: "x" }, { partial: false }).error).toMatch(/Repositório/);
		expect(parseDevEnvBody({ repo: "a/b", tier: "huge" }, { partial: false }).error).toMatch(/Recursos/);
		expect(parseDevEnvBody({ repo: "a/b", network: "x" }, { partial: false }).error).toMatch(/Internet/);
		expect(parseDevEnvBody({ repo: "a/b", allowlist: ["not a domain"] }, { partial: false }).error).toMatch(/Domínio inválido/);
		expect(parseDevEnvBody({ repo: "a/b", installCommand: "x".repeat(9000) }, { partial: false }).error).toMatch(/grande demais/);
		expect(parseDevEnvBody([], { partial: false }).error).toBe("Corpo inválido");
	});
	it("edição parcial só traz o que veio", () => {
		expect(parseDevEnvBody({ startCommand: "" }, { partial: true }).value).toEqual({ startCommand: null });
		expect(normalizeEnvRepo("Acme/Web")).toBe("acme/web");
	});
});
