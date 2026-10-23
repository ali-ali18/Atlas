import { describe, expect, it } from "vitest";
import { scenarioFromRun } from "./from-run.js";
import { parseScenario } from "./scenario.js";

/** Formato real de `GET /v1/runs/:id/inspect` com o inspetor completo e de `GET /v1/runs/:id/events` (dados inventados). */
const request = {
	tools: ["propose_routine", "mcp__crm__find_contact"],
	messages: [
		{ role: "system", content: "You are Ada..." },
		{ role: "user", content: "acha o contato da Joana" },
		{ role: "assistant", content: "Joana Silva: joana@empresa.com.br" },
		{ role: "user", content: "me lembra de ligar pra ela amanhã às 9h no (41) 99876-5432" },
	],
};
const inspect = {
	inspection: {
		v: 1,
		runId: "cmrun123abc",
		status: "completed",
		model: "deepseek/deepseek-chat-v3.1",
		origin: "chat",
		fullRequestEnabled: true,
		steps: [{ decisionIndex: 0, actions: [], hasRequest: true, request: { text: JSON.stringify(request) } }],
		toolCalls: [{ id: "c1", name: "propose_routine", args: "{\"action\":\"create\"}", status: "ok", decisionIndex: 0, summary: "truncado" }],
		approvals: [],
		errors: [],
		totals: { steps: 2, toolCalls: 2, failedToolCalls: 0, promptTokens: 1, completionTokens: 1 },
	},
};
const events = {
	events: [
		{ seq: 1, type: "tool_call", payload: { type: "tool_call", id: "c0", name: "mcp__crm__find_contact", args: "{\"name\":\"Joana\"}" } },
		{ seq: 2, type: "tool_result", payload: { type: "tool_result", id: "c0", name: "mcp__crm__find_contact", ok: true, summary: "{\"name\":\"Joana Silva\",\"email\":\"joana@empresa.com.br\",\"cnpj\":\"11.222.333/0001-81\"}" } },
		{ seq: 3, type: "tool_call", payload: { type: "tool_call", id: "c1", name: "propose_routine", args: "{\"action\":\"create\",\"trigger_type\":\"once\"}" } },
		{ seq: 4, type: "tool_result", payload: { type: "tool_result", id: "c1", name: "propose_routine", ok: true, summary: "Routine created for Joana (joana@empresa.com.br)" } },
	],
	run: { id: "cmrun123abc", status: "completed", resultText: "Combinado, te lembro amanhã às 9h de ligar pra Joana no (41) 99876-5432." },
};

describe("cenário a partir de um run de produção", () => {
	it("congela os resultados como fixtures/conector, redige PII e gera um cenário válido", () => {
		const { scenario, redactions } = scenarioFromRun({ inspect, events });
		expect(parseScenario(scenario).ok).toBe(true);
		expect(scenario.source).toMatchObject({ kind: "production", runId: "cmrun123abc" });
		expect(scenario.user).toBe("me lembra de ligar pra ela amanhã às 9h no (11) 90000-0001");
		expect(scenario.history).toEqual([
			{ role: "user", content: "acha o contato da Joana" },
			{ role: "assistant", content: "Joana Silva: contato1@exemplo.com" },
		]);
		expect(scenario.tools?.fixtures).toEqual([{ tool: "propose_routine", result: { ok: true, summary: "Routine created for Joana (contato1@exemplo.com)" } }]);
		const crm = scenario.tools?.connectors?.[0];
		expect(crm).toMatchObject({ slug: "crm", preload: true, tools: [{ name: "find_contact", readOnly: true, inputSchema: { type: "object", properties: { name: { type: "string" } } } }] });
		expect(crm?.tools[0]?.responses?.[0]?.text).toBe('{"name":"Joana Silva","email":"contato1@exemplo.com","cnpj":"00.000.001/0001-00"}');
		expect(scenario.description).toContain("(11) 90000-0001");
		expect(JSON.stringify(scenario)).not.toMatch(/joana@empresa|99876|24\.224/);
		expect(scenario.expect).toEqual([{ type: "completed" }]);
		expect(redactions).toMatchObject({ email: 1, phone: 1, cnpj: 1 });
	});

	it("sem inspetor completo usa os resumos do inspetor e exige --user", () => {
		const bare = { inspection: { ...inspect.inspection, steps: [{ decisionIndex: 0, actions: [], hasRequest: false }] } };
		expect(() => scenarioFromRun({ inspect: bare })).toThrow(/ATLAS_RUN_INSPECTOR_FULL/);
		const { scenario } = scenarioFromRun({ inspect: bare, user: "me lembra amanhã", id: "lembrete-prod" });
		expect(scenario.id).toBe("lembrete-prod");
		expect(scenario.tools?.fixtures).toEqual([{ tool: "propose_routine", result: { ok: true, summary: "truncado" } }]);
	});

	it("mesma tool com argumentos diferentes ganha predicados por chamada", () => {
		const twice = {
			events: [
				{ type: "tool_call", id: "a", name: "web_search", args: "{\"query\":\"lítio\"}" },
				{ type: "tool_result", id: "a", name: "web_search", ok: true, summary: "r1" },
				{ type: "tool_call", id: "b", name: "web_search", args: "{\"query\":\"lítio 2025\"}" },
				{ type: "tool_result", id: "b", name: "web_search", ok: false, summary: "r2" },
			],
		};
		const { scenario } = scenarioFromRun({ inspect, events: twice });
		expect(scenario.tools?.fixtures).toEqual([
			{ tool: "web_search", args: { query: { equals: "lítio" } }, result: { ok: true, summary: "r1" } },
			{ tool: "web_search", args: { query: { equals: "lítio 2025" } }, result: { ok: false, summary: "r2" } },
		]);
	});

	it("JSON que não é do inspetor é recusado", () => {
		expect(() => scenarioFromRun({ inspect: { foo: 1 } })).toThrow(/inspetor inválido/);
	});
});
