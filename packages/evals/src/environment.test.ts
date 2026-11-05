import { describe, expect, it } from "vitest";
import { buildEnvironment, UNMOCKED_SUMMARY } from "./environment.js";
import { parseScenario } from "./scenario.js";

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
