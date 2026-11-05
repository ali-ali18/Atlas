import { describe, expect, it } from "vitest";
import { buildEnvironment, UNMOCKED_SUMMARY } from "./environment.js";
import { runEvaluation } from "./runner.js";
import { parseScenario } from "./scenario.js";
import { strongMatcher } from "./verdict.js";

function envWith(fixtures: unknown[]) {
	const parsed = parseScenario({ version: 1, id: "t", title: "t", bot: { name: "Ada" }, user: "oi", tools: { fixtures }, expect: [{ type: "completed" }] });
	if (!parsed.ok) throw new Error(parsed.error);
	return buildEnvironment(parsed.scenario);
}

/** Simula o runtime: o evento tool_call chega, depois o gancho de replay pergunta pelo resultado. */
async function call(env: ReturnType<typeof buildEnvironment>, id: string, name: string, args: Record<string, unknown>) {
	env.observe({ type: "tool_call", id, name, args: JSON.stringify(args) });
	return env.params.findCompletedTool!(`run:0:${id}:${name}`);
}

describe("fixtures com `uses`", () => {
	const fixtures = [
		{ tool: "sandbox_shell", args: { command: { matches: "test" } }, uses: 1, result: { ok: false, summary: "1 failed" } },
		{ tool: "sandbox_shell", args: { command: { matches: "test" } }, result: { ok: true, summary: "4 passed" } },
	];

	it("a 1ª execução cai no fixture limitado e a seguinte no próximo que bate", async () => {
		const env = envWith(fixtures);
		expect(await call(env, "c1", "sandbox_shell", { command: "pnpm test" })).toEqual({ ok: false, summary: "1 failed" });
		expect(await call(env, "c2", "sandbox_shell", { command: "pnpm test" })).toEqual({ ok: true, summary: "4 passed" });
		expect(await call(env, "c3", "sandbox_shell", { command: "pnpm test" })).toEqual({ ok: true, summary: "4 passed" });
	});

	it("consultar a MESMA chamada duas vezes não gasta outro uso", async () => {
		const env = envWith(fixtures);
		expect(await call(env, "c1", "sandbox_shell", { command: "pnpm test" })).toEqual({ ok: false, summary: "1 failed" });
		expect(await env.params.findCompletedTool!("run:0:c1:sandbox_shell")).toEqual({ ok: false, summary: "1 failed" });
		expect(await call(env, "c2", "sandbox_shell", { command: "pnpm test" })).toEqual({ ok: true, summary: "4 passed" });
	});

	it("sem fixture que bata, a tool responde 'indisponível' e entra na lista de lacunas", async () => {
		const env = envWith(fixtures);
		expect(await call(env, "c1", "sandbox_read", { path: "x" })).toEqual({ ok: false, summary: UNMOCKED_SUMMARY });
		expect(env.unmocked).toEqual(["sandbox_read"]);
	});
});

describe("leitura em lote (`urls`, schema real do web_extract)", () => {
	const fixtures = [
		{ tool: "web_extract", args: { url: { contains: "a.test" } }, result: { ok: true, summary: "página A" } },
		{ tool: "web_extract", args: { url: { contains: "b.test" } }, result: { ok: true, summary: "página B" } },
	];

	it("uma URL em `urls` casa o fixture escrito com `url` (antes caía em 'indisponível')", async () => {
		const env = envWith(fixtures);
		expect(await call(env, "c1", "web_extract", { urls: ["https://a.test/x"] })).toEqual({ ok: true, summary: "página A" });
	});

	it("várias URLs respondem cada uma pelo seu fixture; a desconhecida vira erro só dela", async () => {
		const env = envWith(fixtures);
		const result = await call(env, "c1", "web_extract", { urls: ["https://a.test/x", "https://zz.test", "https://b.test/y"] });
		expect(result).toEqual({ ok: true, summary: "página A\n\nhttps://zz.test: error (not found)\n\npágina B" });
	});

	it("nenhuma URL conhecida continua 'indisponível'", async () => {
		const env = envWith(fixtures);
		expect(await call(env, "c1", "web_extract", { urls: ["https://zz.test", "https://yy.test"] })).toEqual({ ok: false, summary: UNMOCKED_SUMMARY });
	});
});

describe("respostas neutras de consulta", () => {
	it("memória, histórico e hora respondem neutro (não 'indisponível'); fixture do cenário vence", async () => {
		const env = envWith([{ tool: "memory_search", result: { ok: true, summary: "prefere Floratta" } }]);
		expect(await call(env, "c1", "memory_search", { query: "perfume" })).toEqual({ ok: true, summary: "prefere Floratta" });
		expect(await call(env, "c2", "session_search", { query: "x" })).toEqual({ ok: true, summary: "No results." });
		expect((await call(env, "c3", "current_time", {}))?.summary).toContain("2026-11-05T10:00");
		expect(await call(env, "c4", "memory", { action: "list" })).toEqual({ ok: true, summary: "No saved memories." });
		expect(await call(env, "c5", "memory", { action: "add", content: "x" })).toEqual({ ok: true, summary: "Saved." });
		expect(env.unmocked).toEqual([]);
	});
});

describe("skills de fábrica no eval (sem banco)", () => {
	it("skill_read, list_skills e show_skill não são interceptadas (rodam de verdade) e a loja é a em memória", async () => {
		const env = envWith([]);
		for (const name of ["skill_read", "list_skills", "show_skill"]) expect(await call(env, `c-${name}`, name, { name: "trabalhos-academicos" })).toBeNull();
		expect(env.unmocked).toEqual([]);
		const store = env.params.skillStore!;
		expect(await store.listAll("eval-user")).toEqual([]);
		expect(await store.readActive("eval-user", "trabalhos-academicos", null)).toBeNull();
	});

	it("num run completo (mock), skill_read devolve o markdown real da skill de fábrica", async () => {
		const parsed = parseScenario({
			version: 1,
			id: "t-skill",
			title: "t",
			bot: { name: "Ada" },
			user: "faz meu trabalho",
			tools: { fixtures: [] },
			expect: [{ type: "completed" }],
			mock: { turns: [{ calls: [{ name: "skill_read", args: { name: "trabalhos-academicos" } }] }, { say: "Li a habilidade." }] },
		});
		if (!parsed.ok) throw new Error(parsed.error);
		const result = await runEvaluation({ scenarios: [parsed.scenario], models: [], mode: "mock", isStrong: strongMatcher() });
		const read = result.records[0]!.trajectory.toolResults.find((item) => item.name === "skill_read")!;
		expect(read.ok).toBe(true);
		expect(read.summary).toContain("built-in");
		expect(read.summary.length).toBeGreaterThan(300);
		expect(result.records[0]!.trajectory.unmocked).toEqual([]);
	});
});
