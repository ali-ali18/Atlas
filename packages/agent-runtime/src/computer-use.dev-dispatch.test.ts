import { describe, expect, it } from "vitest";
import { executeDevSessionTool } from "./computer-use.js";
import { DEV_SESSION_TOOL_NAMES, type DevSessionRuntime } from "./tools/dev-session.js";

// Regressão: a prévia (e o PR/CI) estavam no grupo de tools, mas fora da lista de `case` do despacho;
// em produção o bot respondia "Ferramenta desconhecida" e nunca mandava o link.
describe("despacho das tools da sessão de código", () => {
	it("toda tool de DEV_SESSION_TOOL_NAMES chega ao runtime da sessão", async () => {
		const calls: string[] = [];
		const devSession = {
			execute: async (name: string) => {
				calls.push(name);
				return { summary: `ok ${name}` };
			},
		} as Pick<DevSessionRuntime, "execute"> as DevSessionRuntime;
		for (const name of DEV_SESSION_TOOL_NAMES) {
			await expect(executeDevSessionTool(name, {}, { devSession, callId: "c1" })).resolves.toEqual({ summary: `ok ${name}` });
		}
		expect(calls).toEqual([...DEV_SESSION_TOOL_NAMES]);
		expect(calls).toContain("preview_start");
		expect(calls).toContain("dev_pr_create");
	});

	it("sem sessão de código habilitada, falha com erro claro (não 'desconhecida')", () => {
		expect(() => executeDevSessionTool("preview_start", {}, {})).toThrow(/não estão habilitadas/);
	});
});
