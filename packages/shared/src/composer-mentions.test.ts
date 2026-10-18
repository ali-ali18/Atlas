import { describe, expect, it } from "vitest";
import { activeTriggerQuery, filterSkillCandidates, parseSlashSkills, SLASH_SKILL_MAX } from "./composer-mentions.js";

describe("activeTriggerQuery", () => {
	it("abre / no começo do texto e depois de espaço", () => {
		expect(activeTriggerQuery("/", 1, "/")).toEqual({ query: "", start: 0 });
		expect(activeTriggerQuery("faz /pes", 8, "/")).toEqual({ query: "pes", start: 4 });
		expect(activeTriggerQuery("oi\n/x", 5, "/")).toEqual({ query: "x", start: 3 });
	});
	it("não abre / no meio de palavra, em caminho ou com espaço na consulta", () => {
		expect(activeTriggerQuery("a/b", 3, "/")).toBeNull();
		expect(activeTriggerQuery("https://x", 9, "/")).toBeNull();
		expect(activeTriggerQuery("/pesquisar algo", 15, "/")).toBeNull();
	});
	it("abre @ no começo e depois de espaço, mas não em e-mail", () => {
		expect(activeTriggerQuery("@", 1, "@")).toEqual({ query: "", start: 0 });
		expect(activeTriggerQuery("fala com @bi", 12, "@")).toEqual({ query: "bi", start: 9 });
		expect(activeTriggerQuery("email@x", 7, "@")).toBeNull();
	});
	it("só considera o texto antes do cursor", () => {
		expect(activeTriggerQuery("/abc def", 3, "/")).toEqual({ query: "ab", start: 0 });
	});
});

describe("filterSkillCandidates", () => {
	const skills = [{ name: "pesquisar" }, { name: "criar-planilha" }, { name: "memoria" }];
	it("sem consulta devolve todas", () => expect(filterSkillCandidates(skills, "")).toHaveLength(3));
	it("casa prefixo do nome ou de uma palavra do slug, sem acento nem caixa", () => {
		expect(filterSkillCandidates(skills, "pe").map((s) => s.name)).toEqual(["pesquisar"]);
		expect(filterSkillCandidates(skills, "plan").map((s) => s.name)).toEqual(["criar-planilha"]);
		expect(filterSkillCandidates(skills, "MEMÓ").map((s) => s.name)).toEqual(["memoria"]);
		expect(filterSkillCandidates(skills, "zzz")).toEqual([]);
	});
});

describe("parseSlashSkills", () => {
	it("acha /skill no começo, no meio e com pontuação depois", () => {
		expect(parseSlashSkills("/pesquisar preços").map((t) => t.name)).toEqual(["pesquisar"]);
		expect(parseSlashSkills("usa a /criar-planilha, por favor").map((t) => t.name)).toEqual(["criar-planilha"]);
		const [token] = parseSlashSkills("oi /memoria");
		expect(token).toEqual({ name: "memoria", start: 3, end: 11 });
	});
	it("ignora caminho, URL, meio de palavra, maiúscula e bloco de código", () => {
		expect(parseSlashSkills("veja a/b e https://x.com/pesquisar e /Foo")).toEqual([]);
		expect(parseSlashSkills("abra /etc/hosts")).toEqual([]);
		expect(parseSlashSkills("arquivo /notas.txt")).toEqual([]);
		expect(parseSlashSkills("```\n/pesquisar\n```")).toEqual([]);
	});
	it("sem repetição e com teto", () => {
		expect(parseSlashSkills("/a /a /b").map((t) => t.name)).toEqual(["a", "b"]);
		expect(parseSlashSkills("/a /b /c /d /e")).toHaveLength(SLASH_SKILL_MAX);
	});
});
