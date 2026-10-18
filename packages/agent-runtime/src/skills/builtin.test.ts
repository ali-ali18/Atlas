import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executeDeleteSkill, executeProposeSkill, executeSkillRead, type SkillsStore } from "../tools/skills.js";
import { groupProcedureText } from "../context/prompt-blocks.js";
import {
	builtinGroupPointers,
	builtinSkillIndexText,
	builtinSkills,
	findBuiltinSkill,
	loadBuiltinSkills,
	parseBuiltinSkill,
} from "./builtin.js";
// @ts-expect-error módulo .mjs sem tipos
import { BUILTIN_DIR, renderGenerated } from "../../scripts/gen-builtin-skills.mjs";

const SOURCE = [
	"---",
	"name: Exemplo de teste",
	"description: Do the example thing.",
	"when: the example happens",
	"groups: [web, files]",
	"version: 2",
	"---",
	"",
	"Corpo do exemplo.",
	"",
].join("\n");

const FIXTURE = { exemplo: SOURCE, "sem-front": "texto solto" };

function skillDoc(name: string) {
	return { id: "d1", userId: "u", botId: null, name, description: "Mine", body: "meu corpo", tools: [], enabled: true, status: "active", revision: 1 };
}

function store(docs: ReturnType<typeof skillDoc>[] = []): SkillsStore {
	return {
		listAll: async () => docs as never,
		readActive: async (_user, name) => (docs.find((doc) => doc.name === name) ?? null) as never,
		apply: (async () => undefined) as never,
	};
}

const ctx = { userId: "u", botId: null, conversationId: "c1", persistCard: async () => undefined };

describe("loader de skills de fábrica", () => {
	it("lê o frontmatter e o corpo", () => {
		expect(parseBuiltinSkill("exemplo", SOURCE)).toEqual({
			slug: "exemplo",
			name: "Exemplo de teste",
			description: "Do the example thing.",
			when: "the example happens",
			groups: ["web", "files"],
			version: 2,
			body: "Corpo do exemplo.",
		});
	});

	it("ignora arquivo sem frontmatter válido e ordena por slug", () => {
		const loaded = loadBuiltinSkills({ ...FIXTURE, abc: SOURCE });
		expect(loaded.map((skill) => skill.slug)).toEqual(["abc", "exemplo"]);
	});

	it("os .md reais são válidos e o módulo gerado está em dia", () => {
		const files = readdirSync(BUILTIN_DIR as string).filter((file) => file.endsWith(".md"));
		expect(files.length).toBeGreaterThan(0);
		expect(builtinSkills().map((skill) => `${skill.slug}.md`)).toEqual(files.sort());
		const generated = readFileSync(`${BUILTIN_DIR as string}/generated.ts`, "utf8");
		expect(generated).toBe(renderGenerated() as string);
	});
});

describe("índice e ponteiros", () => {
	const skills = loadBuiltinSkills({ exemplo: SOURCE });

	it("índice determinístico com marcador e sem o nome do produto", () => {
		const text = builtinSkillIndexText(new Set(), skills);
		expect(text).toBe("- exemplo [built-in]: Do the example thing. (when: the example happens)");
		expect(builtinSkillIndexText(new Set(), skills)).toBe(text);
		expect(builtinSkillIndexText().toLowerCase()).not.toContain("atlas");
	});

	it("skill do dono com o mesmo slug tira a de fábrica do índice", () => {
		expect(builtinSkillIndexText(new Set(["exemplo"]), skills)).toBe("");
	});

	it("ponteiro por grupo, uma linha por skill", () => {
		expect(builtinGroupPointers(new Set(["web", "files"]), skills)).toBe(
			"For hard cases read the built-in skill `exemplo` (skill_read).",
		);
		expect(builtinGroupPointers(new Set(["shell"]), skills)).toBe("");
	});

	it("procedimento do grupo carrega o ponteiro das skills reais", () => {
		const text = groupProcedureText(new Set(["files"] as const));
		expect(text).toContain("the built-in skill `arquivos` (skill_read)");
		expect(text).not.toContain("`pesquisar`");
		expect(groupProcedureText(new Set())).toBe("");
	});
});

describe("skill_read e edição", () => {
	it("lê a skill de fábrica por slug ou nome de exibição", async () => {
		const bySlug = await executeSkillRead({ name: "arquivos" }, { ...ctx, store: store() });
		expect(bySlug.summary).toContain("(built-in)");
		expect(bySlug.summary).toContain("create_file");
		const byName = await executeSkillRead({ name: "Arquivos" }, { ...ctx, store: store() });
		expect(byName.summary).toContain('Skill "arquivos"');
		expect(findBuiltinSkill("Arquivos")?.slug).toBe("arquivos");
	});

	it("a skill do dono vence a de fábrica", async () => {
		const out = await executeSkillRead({ name: "arquivos" }, { ...ctx, store: store([skillDoc("arquivos")]) });
		expect(out.summary).toContain("meu corpo");
		expect(out.summary).not.toContain("(built-in)");
	});

	it("nome desconhecido lista as de fábrica", async () => {
		await expect(executeSkillRead({ name: "nada" }, { ...ctx, store: store() })).rejects.toThrow(/arquivos/);
	});

	it("recusa editar ou apagar skill de fábrica", async () => {
		await expect(
			executeProposeSkill({ action: "edit", name: "arquivos", body: "x" }, { ...ctx, store: store() }),
		).rejects.toThrow(/built-in skill.*read-only/);
		await expect(executeDeleteSkill({ name: "arquivos" }, { ...ctx, store: store() })).rejects.toThrow(/built-in/);
	});
});

describe("skill de fábrica 'login'", () => {
	it("existe, é lida pelo nome e é anunciada nos grupos browser e vault", async () => {
		const skill = findBuiltinSkill("login");
		expect(skill?.groups).toEqual(["browser", "vault"]);
		expect(skill?.when).toMatch(/login|sign in|entrar|2FA|código de verificação/i);
		expect(builtinGroupPointers(new Set(["browser"]))).toContain("login");
		expect(builtinGroupPointers(new Set(["vault"]))).toContain("login");
		expect(builtinSkillIndexText()).toContain("login");
		const read = await executeSkillRead({ name: "login" }, { ...ctx, store: store() });
		expect(read.summary).toContain("login_fill");
		expect(read.summary).toMatch(/never type a password|never ask for a password/i);
	});
});

describe("skill de fábrica 'memoria'", () => {
	it("existe, entra no índice e ensina list/merge por ref sem citar o nome do produto", async () => {
		const skill = findBuiltinSkill("memoria");
		expect(skill?.groups).toEqual([]);
		expect(skill?.when).toMatch(/organize|dedupe|duplicadas/i);
		expect(builtinSkillIndexText()).toContain("memoria");
		const read = await executeSkillRead({ name: "memoria" }, { ...ctx, store: store() });
		expect(read.summary).toContain('action: "list"');
		expect(read.summary).toContain("merge");
		expect(read.summary).toContain("propose_routine");
		expect(read.summary).not.toMatch(/atlas/i);
	});
});
