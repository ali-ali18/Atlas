import { describe, expect, it } from "vitest";
import type { AfterToolHook, BeforeToolHook, OnRunEndHook, OnWakeHook, ToolCallInfo } from "./hooks.js";

describe("ganchos: nenhum toca o texto do assistente", () => {
	it("formas permitidas compilam", async () => {
		const before: BeforeToolHook = (call) => (call.effect === "send" ? { verdict: "ask", riskFacts: { recipients: ["a@exemplo.test"] } } : undefined);
		const after: AfterToolHook = () => ({ schedule: [{ kind: "watch", objective: "check delivery", everyMinutes: 120 }], note: "Tracking started." });
		const end: OnRunEndHook = () => [{ kind: "sleep" }];
		const wake: OnWakeHook = (item) => item.objective;
		const call: ToolCallInfo = { name: "x", args: {}, effect: "read" };
		expect(await before(call, {} as never)).toBeUndefined();
		expect(await after(call, { ok: true, summary: "s" }, {} as never)).toMatchObject({ note: "Tracking started." });
		expect(await end({ runId: "r", outcome: "final", toolCalls: [] })).toEqual([{ kind: "sleep" }]);
		expect(await wake({ id: "1", kind: "remind", objective: "do it" })).toBe("do it");
	});

	it("beforeTool não pode devolver texto do assistente", () => {
		// @ts-expect-error `text` é never
		const a: BeforeToolHook = () => ({ verdict: "ask", text: "reescrevi a resposta" });
		// @ts-expect-error `assistantText` é never
		const b: BeforeToolHook = () => ({ assistantText: "x" });
		// @ts-expect-error veredito só "ask" | "deny"
		const c: BeforeToolHook = () => ({ verdict: "allow" });
		expect([a, b, c]).toHaveLength(3);
	});

	it("afterTool não pode devolver texto do assistente nem trocar o resultado", () => {
		// @ts-expect-error `content` é never
		const a: AfterToolHook = () => ({ note: "n", content: "x" });
		// @ts-expect-error `reply` é never
		const b: AfterToolHook = () => ({ reply: "x" });
		// @ts-expect-error o gancho não devolve um ToolResult
		const c: AfterToolHook = () => ({ ok: true, summary: "outro" });
		expect([a, b, c]).toHaveLength(3);
	});

	it("o que o gancho recebe não tem texto do assistente", () => {
		const call: ToolCallInfo = { name: "x", args: {}, effect: "read" };
		// @ts-expect-error a chamada não carrega fala do assistente
		void call.assistantText;
		const hook: BeforeToolHook = (_call, ctx) => {
			// @ts-expect-error o contexto não carrega fala do assistente
			void ctx.assistantText;
		};
		expect(hook).toBeTypeOf("function");
	});
});
