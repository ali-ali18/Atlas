import { describe, expect, it } from "vitest";
import { classifyRunFailure, FAILURE_CLASSES, type RunFailureTrace } from "./run-failure-class.js";

const clean = (over: Partial<RunFailureTrace> = {}): RunFailureTrace => ({
	steps: [{ toolCalls: [{ name: "web_search", ok: true }] }],
	staleTaskInjected: false,
	declinedOffers: [],
	openTaskItemsAtEnd: 0,
	endedWithoutTool: false,
	repetitionBlocked: false,
	compactionHappened: false,
	reReadAfterCompactionEmpty: false,
	approvalCardForReadEffect: false,
	denyLaterAllowedByOwner: false,
	...over,
});

describe("classifyRunFailure", () => {
	it("run limpo = none", () => {
		expect(classifyRunFailure(clean())).toEqual({ primary: "none", all: [], evidence: [] });
	});

	it("uma classe por sinal", () => {
		const cases: Array<[string, Partial<RunFailureTrace>]> = [
			["harness.tool_not_exposed", { steps: [{ toolCalls: [{ name: "video_transcript", ok: false, notInCatalog: true }] }] }],
			["harness.tool_not_exposed", { steps: [{ toolCalls: [{ name: "x", ok: false, hidden: true }] }] }],
			["harness.context_lost", { compactionHappened: true, reReadAfterCompactionEmpty: true }],
			["harness.policy_misfire", { approvalCardForReadEffect: true }],
			["harness.policy_misfire", { denyLaterAllowedByOwner: true }],
			["harness.stale_task_injection", { staleTaskInjected: true, declinedOffers: ["resumo-video"], offeredTopics: ["resumo-video"] }],
			["model.bad_args", { steps: [{ toolCalls: [{ name: "create_file", ok: false, validationRejected: true, signatureVisible: true }] }] }],
			["model.announce_stop", { endedWithoutTool: true, openTaskItemsAtEnd: 2 }],
			["model.loop", { repetitionBlocked: true }],
			["model.nagging", { declinedOffers: ["resumo-video"], offeredTopics: ["resumo-video"] }],
			["env.connector", { transportErrors: [{ kind: "connector", code: "HTTP_502" }] }],
			["env.network", { transportErrors: [{ kind: "network", code: "ETIMEDOUT" }] }],
			["env.vm", { transportErrors: [{ kind: "vm", code: "vm_unreachable" }] }],
		];
		for (const [expected, over] of cases) {
			const result = classifyRunFailure(clean(over));
			expect(result.primary, expected).toBe(expected);
			expect(result.evidence.length).toBeGreaterThan(0);
		}
		expect(new Set(cases.map(([c]) => c))).toEqual(new Set(FAILURE_CLASSES));
	});

	it("validação recusada sem a assinatura visível não é erro do modelo", () => {
		const trace = clean({ steps: [{ toolCalls: [{ name: "t", ok: false, validationRejected: true, signatureVisible: false }] }] });
		expect(classifyRunFailure(trace).primary).toBe("none");
	});

	it("announce_stop exige fim sem tool E item aberto", () => {
		expect(classifyRunFailure(clean({ endedWithoutTool: true })).primary).toBe("none");
		expect(classifyRunFailure(clean({ openTaskItemsAtEnd: 3 })).primary).toBe("none");
	});

	it("prioridade env > harness > model, com todas listadas em ordem", () => {
		const result = classifyRunFailure(clean({ repetitionBlocked: true, approvalCardForReadEffect: true, transportErrors: [{ kind: "network" }] }));
		expect(result.primary).toBe("env.network");
		expect(result.all).toEqual(["env.network", "harness.policy_misfire", "model.loop"]);
		expect(classifyRunFailure(clean({ repetitionBlocked: true, compactionHappened: true, reReadAfterCompactionEmpty: true })).primary).toBe("harness.context_lost");
		expect(classifyRunFailure(clean({ endedWithoutTool: true, openTaskItemsAtEnd: 1, repetitionBlocked: true })).all).toEqual(["model.announce_stop", "model.loop"]);
	});

	it("insistência: mesma oferta repetida, causa depende do contexto", () => {
		const base = { declinedOffers: ["resumo-video"], offeredTopics: ["resumo-video"] };
		expect(classifyRunFailure(clean({ ...base, staleTaskInjected: true })).all).toEqual(["harness.stale_task_injection"]);
		expect(classifyRunFailure(clean({ ...base, staleTaskInjected: false })).all).toEqual(["model.nagging"]);
		// tópico largado pelo dono (não recusado) também conta
		expect(classifyRunFailure(clean({ abandonedTopics: ["resumo-video"], offeredTopics: ["resumo-video"] })).primary).toBe("model.nagging");
		// oferta de outra coisa não é insistência
		expect(classifyRunFailure(clean({ ...base, offeredTopics: ["clima"] })).primary).toBe("none");
		// tarefa velha injetada já é defeito do harness, mesmo sem reoferta (outro modelo insistiria)
		expect(classifyRunFailure(clean({ staleTaskInjected: true })).primary).toBe("harness.stale_task_injection");
	});

	it("não lê texto livre: nomes e detalhes com palavras de erro não classificam", () => {
		const trace = clean({
			steps: [{ toolCalls: [{ name: "connector network vm timeout loop", ok: false }] }],
			stop: { reason: "error", detail: "connector failed, network down, vm crashed, repetition blocked, hidden tool" },
		});
		expect(classifyRunFailure(trace).primary).toBe("none");
	});

	it("evidência sem segredo: código é higienizado e truncado", () => {
		const secret = `Bearer sk-${"a".repeat(80)}`;
		const [line] = classifyRunFailure(clean({ transportErrors: [{ kind: "connector", code: secret }] })).evidence;
		expect(line).not.toContain("Bearer ");
		expect(line!.length).toBeLessThan(80);
	});
});
