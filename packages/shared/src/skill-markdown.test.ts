import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets.js";
import {
	SKILL_BODY_MAX_BYTES,
	SKILL_INDEX_OVERFLOW_LINE,
	buildSkillIndex,
	mergeSkillScopes,
	parseSkillMarkdown,
	renderSkillMarkdown,
	slugifySkillName,
	validateSkillFields,
} from "./skill-markdown.js";

const doc = (head: string, body = "1. Passo um\n2. Passo dois") => `---\n${head}\n---\n${body}`;
const errorsOf = (text: string) => {
	const result = parseSkillMarkdown(text);
	if (result.ok) throw new Error("esperava erro");
	return result.errors.join(" | ");
};

describe("parseSkillMarkdown", () => {
	it("lê frontmatter e corpo com bloco de código", () => {
		const body = "Use:\n\n```bash\ngh pr list\n```";
		const result = parseSkillMarkdown(doc("name: weekly-report\ndescription: Resume a semana\ntools: [github, calendar]", body));
		expect(result).toEqual({
			ok: true,
			skill: { name: "weekly-report", description: "Resume a semana", tools: ["github", "calendar"], body },
		});
	});

	it("aceita CRLF, BOM e tools ausente", () => {
		const text = "﻿" + doc("name: a\r\ndescription: d").replace(/\n/g, "\r\n");
		const result = parseSkillMarkdown(text);
		expect(result.ok && result.skill.tools).toEqual([]);
	});

	it("rejeita documento vazio, sem frontmatter e frontmatter aberto", () => {
		expect(errorsOf("")).toContain("vazio");
		expect(errorsOf("# so corpo")).toContain("frontmatter");
		expect(errorsOf("---\nname: a\ndescription: d\ncorpo")).toContain("não foi fechado");
	});

	it("rejeita chave desconhecida, repetida e linha inválida", () => {
		expect(errorsOf(doc("name: a\ndescription: d\ntriggers: [x]"))).toContain("Chave desconhecida");
		expect(errorsOf(doc("name: a\nname: b\ndescription: d"))).toContain("repetida");
		expect(errorsOf(doc("name: a\ndescription: d\nlixo"))).toContain("Linha inválida");
	});

	it("valida slug do nome", () => {
		for (const name of ["Weekly", "a b", "-a", "a--b", "a_b", "a".repeat(65)]) {
			expect(errorsOf(doc(`name: ${name}\ndescription: d`))).toContain("slug");
		}
		expect(parseSkillMarkdown(doc(`name: ${"a".repeat(64)}\ndescription: d`)).ok).toBe(true);
	});

	it("descrição: 300 passa, 301 falha, ausente falha", () => {
		expect(parseSkillMarkdown(doc(`name: a\ndescription: ${"x".repeat(300)}`)).ok).toBe(true);
		expect(errorsOf(doc(`name: a\ndescription: ${"x".repeat(301)}`))).toContain("300");
		expect(errorsOf(doc("name: a"))).toContain("descrição é obrigatória");
	});

	it("corpo: no teto passa, acima falha, vazio falha", () => {
		const full = "x".repeat(SKILL_BODY_MAX_BYTES);
		expect(parseSkillMarkdown(doc("name: a\ndescription: d", full)).ok).toBe(true);
		expect(errorsOf(doc("name: a\ndescription: d", full + "x"))).toContain("16 KB");
		expect(errorsOf(doc("name: a\ndescription: d", "  \n"))).toContain("vazio");
	});

	it("conta bytes UTF-8 no teto do corpo", () => {
		const body = "é".repeat(SKILL_BODY_MAX_BYTES / 2 + 1);
		expect(errorsOf(doc("name: a\ndescription: d", body))).toContain("16 KB");
	});

	it("tools é só lista de dicas válidas; item inválido falha", () => {
		expect(errorsOf(doc("name: a\ndescription: d\ntools: github"))).toContain("lista");
		expect(errorsOf(doc("name: a\ndescription: d\ntools: [Bad Tool]"))).toContain("tools");
		const dup = parseSkillMarkdown(doc("name: a\ndescription: d\ntools: [github, github]"));
		expect(dup.ok && dup.skill.tools).toEqual(["github"]);
		// nomes de tool de conector MCP têm maiúsculas e `__`
		const mcp = parseSkillMarkdown(doc(["name: a", "description: d", "tools: [mcp__github__ListIssues]"].join("\n")));
		expect(mcp.ok && mcp.skill.tools).toEqual(["mcp__github__ListIssues"]);
	});
});

describe("renderSkillMarkdown", () => {
	it("faz round-trip, inclusive com descrição que exige aspas", () => {
		for (const description of ["Simples", "Use quando: houver # no texto", 'Diz "oi"', "[lista]"]) {
			const skill = { name: "round-trip", description, tools: ["github"], body: "Corpo\n\n```js\nx\n```" };
			const parsed = parseSkillMarkdown(renderSkillMarkdown(skill));
			expect(parsed).toEqual({ ok: true, skill });
		}
	});

	it("omite tools quando vazio e é determinístico", () => {
		const skill = { name: "a", description: "d", tools: [], body: "b" };
		expect(renderSkillMarkdown(skill)).toBe("---\nname: a\ndescription: d\n---\n\nb\n");
		expect(renderSkillMarkdown(skill)).toBe(renderSkillMarkdown(skill));
	});
});

describe("validateSkillFields e slugify", () => {
	it("valida campos vindos de JSON", () => {
		expect(validateSkillFields({ name: 1, description: null, body: undefined }).ok).toBe(false);
		expect(validateSkillFields({ name: "a", description: "d\nx", body: "b" }).ok).toBe(false);
	});
	it("slugifySkillName normaliza acentos e símbolos", () => {
		expect(slugifySkillName("Relatório Semanal (v2)!")).toBe("relatorio-semanal-v2");
		expect(slugifySkillName("???")).toBe("");
		expect(slugifySkillName("a".repeat(100)).length).toBe(64);
	});
});

describe("buildSkillIndex", () => {
	const s = (name: string, extra: object = {}) => ({ name, description: `desc ${name}`, ...extra });

	it("ordena por nome e é estável independente da entrada", () => {
		const a = buildSkillIndex([s("zeta"), s("alfa"), s("beta")]);
		expect(a).toBe("- alfa: desc alfa\n- beta: desc beta\n- zeta: desc zeta");
		expect(buildSkillIndex([s("beta"), s("zeta"), s("alfa")])).toBe(a);
	});

	it("só entram skills ativas e habilitadas; vazio dá string vazia", () => {
		const out = buildSkillIndex([s("a"), s("b", { enabled: false }), s("c", { status: "draft" })]);
		expect(out).toBe("- a: desc a");
		expect(buildSkillIndex([s("b", { enabled: false })])).toBe("");
	});

	it("estourando itens ou caracteres, termina com a linha fixa", () => {
		const many = Array.from({ length: 5 }, (_, i) => s(`s${i}`));
		const byItems = buildSkillIndex(many, { maxItems: 2 }).split("\n");
		expect(byItems).toHaveLength(3);
		expect(byItems.at(-1)).toBe(SKILL_INDEX_OVERFLOW_LINE);
		const byChars = buildSkillIndex(many, { maxChars: 140 });
		expect(byChars.length).toBeLessThanOrEqual(140);
		expect(byChars.endsWith(SKILL_INDEX_OVERFLOW_LINE)).toBe(true);
	});

	it("a linha de estouro aponta para skill_read e não cita tool inexistente", () => {
		expect(SKILL_INDEX_OVERFLOW_LINE).toContain("skill_read");
		expect(SKILL_INDEX_OVERFLOW_LINE).not.toContain("skill_search");
	});

	it("respeita o teto padrão de 64 itens e ~6000 caracteres", () => {
		const big = Array.from({ length: 100 }, (_, i) => ({ name: `skill-${String(i).padStart(3, "0")}`, description: "d".repeat(100) }));
		const out = buildSkillIndex(big);
		expect(out.length).toBeLessThanOrEqual(6000);
		expect(out.split("\n").length).toBeLessThanOrEqual(65);
		expect(out).toContain(SKILL_INDEX_OVERFLOW_LINE);
	});
});

describe("mergeSkillScopes", () => {
	it("a skill do bot vence a da conta na colisão", () => {
		const merged = mergeSkillScopes(
			[{ name: "a", from: "conta" }, { name: "b", from: "conta" }],
			[{ name: "a", from: "bot" }],
		);
		expect(merged.find((x) => x.name === "a")?.from).toBe("bot");
		expect(merged).toHaveLength(2);
	});
});

describe("redactSecrets", () => {
	it("redige tokens comuns", () => {
		expect(redactSecrets("use ghp_" + "a".repeat(30) + " ok")).toBe("use [redacted] ok");
	});
});
