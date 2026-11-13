import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Higiene de código aberto (03 §0.1): nada do dono no repositório.
// Este arquivo traz de propósito exemplos ruins e a denylist, então ele mesmo
// fica fora da varredura (único arquivo excluído).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/**
 * Nomes de instituições/marcas que vieram do uso real do dono e NÃO podem virar
 * regra, exemplo fixo ou fixture no motor (o motor é genérico no comportamento).
 * Conectores específicos moram no próprio conector, fora deste pacote.
 */
export const OWNER_DENYLIST = ["PUCPR", "CodeRabbit", "Bling"];

const ALLOWED_EMAIL_DOMAINS = ["example.com", "example.org"];

export type Finding = { rule: string; match: string };

const SECRET_PATTERNS: Array<{ rule: string; re: RegExp }> = [
	{ rule: "chave Anthropic", re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
	{ rule: "chave sk-", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
	{ rule: "token GitHub", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
	{ rule: "chave AWS", re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ rule: "chave privada", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
	{ rule: "bearer longo", re: /\bBearer\s+[A-Za-z0-9+/_=.-]{32,}/g },
];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

function emailAllowed(domain: string): boolean {
	const d = domain.toLowerCase();
	return d.endsWith(".test") || ALLOWED_EMAIL_DOMAINS.includes(d);
}

export function scanText(text: string): Finding[] {
	const findings: Finding[] = [];
	for (const { rule, re } of SECRET_PATTERNS) {
		for (const m of text.matchAll(re)) findings.push({ rule, match: m[0] });
	}
	for (const m of text.matchAll(EMAIL)) {
		if (!emailAllowed(m[1] as string)) findings.push({ rule: "e-mail real", match: m[0] });
	}
	const lower = text.toLowerCase();
	for (const name of OWNER_DENYLIST) {
		if (lower.includes(name.toLowerCase())) findings.push({ rule: "nome do dono", match: name });
	}
	return findings;
}

function listFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (SKIP_DIRS.has(name)) return [];
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return listFiles(full);
		return /\.(ts|md|json)$/.test(name) ? [full] : [];
	});
}

describe("higiene do pacote (sem segredo nem dado pessoal)", () => {
	const files = listFiles(ROOT).filter((f) => f !== SELF);

	it("varre src, README e package.json", () => {
		const rel = files.map((f) => relative(ROOT, f));
		expect(rel).toContain("README.md");
		expect(rel).toContain("package.json");
		expect(rel.some((f) => f.startsWith("src"))).toBe(true);
	});

	it("nenhum arquivo tem segredo, e-mail real ou nome da denylist", () => {
		const bad = files.flatMap((f) =>
			scanText(readFileSync(f, "utf8")).map((x) => `${relative(ROOT, f)}: ${x.rule} (${x.match})`),
		);
		expect(bad).toEqual([]);
	});

	describe("auto-teste dos detectores", () => {
		const rules = (s: string) => scanText(s).map((f) => f.rule);

		it("pega chaves de API", () => {
			expect(rules("k = sk-ant-api03-abcdefghijkl")).toContain("chave Anthropic");
			expect(rules("k = sk-abcdefghijklmnopqrstuvwx")).toContain("chave sk-");
			expect(rules(`t = ghp_${"a".repeat(30)}`)).toContain("token GitHub");
			expect(rules("id = AKIAABCDEFGHIJKLMNOP")).toContain("chave AWS");
			expect(rules("-----BEGIN RSA PRIVATE KEY-----")).toContain("chave privada");
			expect(rules(`Authorization: Bearer ${"Ab1".repeat(14)}`)).toContain("bearer longo");
		});

		it("pega e-mail real e aceita .test, example.com e example.org", () => {
			expect(rules("fulano@gmail.com")).toContain("e-mail real");
			expect(rules("a@empresa.com.br")).toContain("e-mail real");
			expect(rules("a@teste.test b@example.com c@example.org d@sub.example.test")).toEqual([]);
		});

		it("pega nomes da denylist sem diferenciar maiúsculas", () => {
			for (const name of OWNER_DENYLIST) {
				expect(rules(`integração com ${name.toLowerCase()}`)).toContain("nome do dono");
			}
		});

		it("deixa passar texto limpo", () => {
			expect(scanText("const x = 'Bearer token'; // skill: ask-user, sk-curto")).toEqual([]);
			expect(scanText("Authorization: Bearer <token>")).toEqual([]);
		});
	});
});
