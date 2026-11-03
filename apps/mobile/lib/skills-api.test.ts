import { describe, expect, it } from "vitest";
import { isUnauthorized } from "./chat-api";
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
	const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body }) as Response;
	it("uma lista que falha não derruba a outra, mas o resultado vem incompleto", async () => {
		const out = await fetchSkills(async (path) => (path === "/v1/skills" ? reply(null, 500) : reply(builtin)));
		expect(out.skills.map((s) => s.name)).toEqual(["resumo", "agenda"]);
		expect(out.complete).toBe(false);
	});
	it("as duas boas: completo", async () => {
		const out = await fetchSkills(async (path) => (path === "/v1/skills" ? reply(mine) : reply(builtin)));
		expect(out.complete).toBe(true);
	});
	it("as duas falhando lança", async () => {
		await expect(fetchSkills(async () => reply(null, 500))).rejects.toThrow();
	});
	it("401 em qualquer uma sobe como sessão recusada, mesmo com a outra boa", async () => {
		const error = await fetchSkills(async (path) => (path === "/v1/skills" ? reply(null, 401) : reply(builtin))).catch((e) => e);
		expect(isUnauthorized(error)).toBe(true);
	});
});
