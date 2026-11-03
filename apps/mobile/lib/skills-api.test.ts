import { describe, expect, it } from "vitest";
import { fetchSkills, parseSkills } from "./skills-api";

const mine = {
	skills: [
		{ id: "u1", name: "resumo", description: "Meu resumo", enabled: true, status: "active" },
		{ id: "u2", name: "rascunho", description: "x", enabled: true, status: "draft" },
		{ id: "u3", name: "desligada", description: "x", enabled: false, status: "active" },
		{ id: "u4", name: "Nome Inválido", description: "x", enabled: true, status: "active" },
	],
};
const builtin = { skills: [{ slug: "resumo", description: "De fábrica" }, { slug: "agenda", description: "Agenda" }] };

describe("parseSkills", () => {
	it("só ativas e ligadas do usuário, depois as de fábrica, sem repetir slug", () => {
		expect(parseSkills(mine, builtin)).toEqual([
			{ id: "u1", name: "resumo", description: "Meu resumo" },
			{ id: "builtin:agenda", name: "agenda", description: "Agenda" },
		]);
	});
	it("corpo estranho vira lista vazia", () => {
		expect(parseSkills(null, undefined)).toEqual([]);
		expect(parseSkills({ skills: "x" }, [])).toEqual([]);
	});
});

describe("fetchSkills", () => {
	const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) as Response;
	it("uma lista que falha não derruba a outra", async () => {
		const out = await fetchSkills(async (path) => (path === "/v1/skills" ? reply(null, false) : reply(builtin)));
		expect(out.map((s) => s.name)).toEqual(["resumo", "agenda"]);
	});
	it("as duas falhando lança", async () => {
		await expect(fetchSkills(async () => reply(null, false))).rejects.toThrow();
	});
});
