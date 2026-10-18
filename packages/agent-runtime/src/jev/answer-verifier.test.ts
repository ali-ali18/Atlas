import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import type { ToolResultStatus } from "@workspace/shared";
import { collectEvidence } from "./answer-verifier.js";

const call = (id: string, name: string): LlmMessage => ({
	role: "assistant",
	content: null,
	tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});
const result = (id: string, content: string): LlmMessage => ({ role: "tool", tool_call_id: id, content });
const status = (s: ToolResultStatus["status"]): ToolResultStatus => ({ status: s, effect: "none" });

describe("collectEvidence: ok vem do status estruturado, não do texto", () => {
	it("tool bloqueada ou não executada (status de erro) entra como ok:false, em qualquer idioma", () => {
		const conversation = [
			call("a", "web_search"), result("a", "Herramienta bloqueada en esta ejecución."),
			call("b", "navigate"), result("b", "Résultat normal"),
		];
		const statuses: Record<string, ToolResultStatus> = { a: status("error"), b: status("ok") };
		const evidence = collectEvidence(conversation, (id) => statuses[id]);
		expect(evidence.map((item) => [item.tool, item.ok])).toEqual([["web_search", false], ["navigate", true]]);
	});

	it("texto que parece mensagem de limite, mas veio de tool que deu certo, continua ok", () => {
		const conversation = [call("a", "web_extract"), result("a", "Limite de 5 chamadas de x atingido neste run")];
		const evidence = collectEvidence(conversation, () => status("ok"));
		expect(evidence[0]?.ok).toBe(true);
	});

	it("sem status (checkpoint antigo) vale como ok", () => {
		const conversation = [call("a", "web_extract"), result("a", "Not executed: the run was stopped before this call.")];
		expect(collectEvidence(conversation)[0]?.ok).toBe(true);
	});
});
