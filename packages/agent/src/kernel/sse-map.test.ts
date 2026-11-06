import { type ComputerUseEvent, type TranscriptBubble, applyComputerUseEventsToTranscript, parseAgentV4Event } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { grantApproval, type ApprovalRequest } from "../contract/index.js";
import { sendTool } from "../testing/contract-helpers.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { defineTool } from "../tools/define-tool.js";
import { KERNEL_EVENT_TYPES, createSseMapper, stopReasonOf } from "./sse-map.js";
import type { KernelEvent } from "./types.js";

const request: ApprovalRequest = { id: "req-1", toolName: "send_email", effect: "send", args: { to: "a@b.test" }, riskFacts: { recipients: ["a@b.test"] }, payloadHash: "h" };
const mapper = () => createSseMapper({ runId: "run-1", model: "m-1" });

/** Uma amostra de cada tipo de evento do kernel (o teste abaixo exige que a lista cubra todos). */
const SAMPLES: KernelEvent[] = [
	{ type: "step", data: { step: 0, final: false } },
	{ type: "text_delta", data: { text: "oi" } },
	{ type: "retract", data: { reason: "transport_retry" } },
	{ type: "tool_call", data: { callId: "c1", name: "lookup", args: { q: "a" } } },
	{ type: "tool_result", data: { callId: "c1", name: "lookup", status: "ok", content: "r" } },
	{ type: "receipt", data: { callId: "c1", name: "send_email", what: "E-mail enviado", where: "a@b.test" } },
	{ type: "card", data: { kind: "approval", callId: "c1", request } },
	{ type: "card", data: { kind: "handoff", callId: "c2", userMessage: "É com você." } },
	{ type: "card", data: { kind: "ask_owner", cardId: "k1", question: "Quer?", offer: "Sim" } },
	{ type: "status", data: { reason: "empty_reply", message: "m" } },
	{ type: "final", data: { text: "fim", status: "done", steps: 1, spentUsd: 0.02 } },
];

describe("kernel → contrato SSE", () => {
	it("toda classe de evento do kernel tem mapeamento e todo mapeado vira JSON", () => {
		expect(new Set(SAMPLES.map((e) => e.type))).toEqual(new Set(KERNEL_EVENT_TYPES));
		const m = mapper();
		for (const e of SAMPLES) {
			const out = m.map(e);
			if (e.type !== "step") expect(out.length, e.type).toBeGreaterThan(0);
			expect(JSON.parse(JSON.stringify(out))).toEqual(out);
		}
	});

	it("tipos existentes: delta, chamada, resultado, compactação, cancelamento", () => {
		const m = mapper();
		m.map({ type: "step", data: { step: 2, final: false } });
		expect(m.map({ type: "text_delta", data: { text: "oi" } })).toEqual([{ type: "assistant_delta", id: "run-1-step-2", delta: "oi" }]);
		expect(m.map(SAMPLES[3] as KernelEvent)).toEqual([{ type: "tool_call", id: "c1", name: "lookup", args: '{"q":"a"}', step: 2 }]);
		expect(m.map({ type: "tool_result", data: { callId: "c1", name: "lookup", status: "error", content: "Error: x" } })).toEqual([{ type: "tool_result", id: "c1", name: "lookup", ok: false, summary: "Error: x" }]);
		expect(m.map({ type: "tool_result", data: { callId: "c1", name: "t", status: "already_done", content: "c" } })[0]).toMatchObject({ ok: true });
		expect(m.map({ type: "status", data: { reason: "compacted", message: "x", before: 900, after: 100 } })).toEqual([{ type: "context_compacted", before: 900, after: 100 }]);
		expect(m.map({ type: "status", data: { reason: "cancelled", message: "x" } })).toEqual([{ type: "cancelled", reason: "cancelled", stopReason: "cancelled" }]);
		m.map({ type: "step", data: { step: 3, final: true } });
		expect(m.map({ type: "text_delta", data: { text: "z" } })[0]).toMatchObject({ id: "run-1-final" });
	});

	it("tipos novos saem válidos no parser de shared, com o runId", () => {
		const m = mapper();
		const out = [SAMPLES[5], SAMPLES[6], SAMPLES[7], SAMPLES[8]].flatMap((e) => m.map(e as KernelEvent));
		expect(out.map((e) => e.type)).toEqual(["receipt", "approval_request", "handoff_request", "ask_owner"]);
		for (const e of out) expect(parseAgentV4Event(e), e.type).toEqual(e);
		expect(out[1]).toMatchObject({ requestId: "req-1", callId: "c1", effect: "send", runId: "run-1" });
		// o cartão não leva o hash do payload (o grant nasce no servidor)
		expect(JSON.stringify(out[1])).not.toContain('"payloadHash"');
	});

	it("final: done com stopReason e uso; teto vira status budget_exhausted antes do done; falha vira erro amigável no idioma do bot", () => {
		const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
		const m = createSseMapper({ runId: "run-1", model: "m-1", language: "en-US", usage: () => usage });
		expect(m.map({ type: "final", data: { text: "ok", status: "done", steps: 1, spentUsd: 0 } })).toEqual([{ type: "done", message: { role: "assistant", content: "ok" }, model: "m-1", usage, stopReason: "answered" }]);
		const capped = m.map({ type: "final", data: { text: "parcial", status: "not_done", steps: 40, spentUsd: 1, stop: { kind: "steps_unattended", label: "x" } } });
		expect(capped.map((e) => e.type)).toEqual(["status", "done"]);
		expect(capped[0]).toMatchObject({ status: "budget_exhausted", stopReason: "budget_steps" });
		expect(m.map({ type: "final", data: { text: "", status: "failed", steps: 0, spentUsd: 0, reason: "model_error" } })).toEqual([{ type: "error", error: "I couldn't reach the model right now. Please try again in a moment.", stopReason: "error" }]);
		// falha do kernel: o detalhe técnico não vai ao dono
		const [err] = mapper().map({ type: "status", data: { reason: "kernel_error", message: "TypeError: x is undefined at /srv/app.js" } });
		expect(err).toMatchObject({ type: "error", stopReason: "error" });
		expect(JSON.stringify(err)).not.toContain("TypeError");
		expect(stopReasonOf({ text: "", status: "not_done", steps: 1, spentUsd: 0, stop: { kind: "repeated", label: "" } })).toBe("loop_repeat");
	});

	it("evento da porta de tipo desconhecido ou sem carga vira lista vazia, sem lançar", () => {
		const m = mapper();
		expect(m.mapRunEvent({ type: "algo_novo", runId: "r", userId: "u", data: { a: 1 } })).toEqual([]);
		expect(m.mapRunEvent({ type: "text_delta", runId: "r", userId: "u" })).toEqual([]);
		expect(m.mapRunEvent({ type: "text_delta", runId: "r", userId: "u", data: { text: "a" } })).toHaveLength(1);
	});
});

describe("kernel → transcript: execução gravada", () => {
	const lookup = defineTool({ name: "lookup", description: "Look something up.", inputSchema: z.object({ q: z.string() }), effect: "read", execute: ({ q }) => ({ ok: true, summary: `result for ${q}` }) });

	function transcriptOf(events: ComputerUseEvent[]): TranscriptBubble[] {
		// round-trip por JSON, como run_events grava e o stream devolve
		return applyComputerUseEventsToTranscript([], JSON.parse(JSON.stringify(events)) as ComputerUseEvent[]);
	}

	it("run com tool, recibo, aprovação e retomada converte sem lançar e o balão final é o texto do modelo", async () => {
		const { tool: send } = sendTool();
		const h = kernelHarness(
			[reply({ chunks: ["Vou ", "buscar."], calls: [call("c1", "lookup", { q: "a" }), call("c2", "send_email", { to: "a@b.test", body: "oi" })] }), reply({ text: "Feito." })],
			{ tools: [lookup, send] },
		);
		const first = await h.run();
		expect(first.status).toBe("parked");
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		await h.run({ input: { ...h.input, resume: { grants: [grantApproval(card.request, new Date())] } } });
		const m = createSseMapper({ runId: "run-1", model: "fake-1" });
		const mapped = h.log.events.flatMap((e) => m.mapRunEvent(e));
		const types = mapped.map((e) => e.type);
		expect(types).toEqual(expect.arrayContaining(["assistant_delta", "tool_call", "tool_result", "approval_request", "receipt", "done"]));
		expect(types.at(-1)).toBe("done");
		const bubbles = transcriptOf(mapped);
		expect(bubbles.map((b) => [b.kind, b.text])).toEqual([["assistant", "Vou buscar."], ["assistant", "Feito."]]);
	});

	it("retry de transporte depois de texto parcial: o balão é apagado e refeito, sem duplicar", async () => {
		const h = kernelHarness([reply({ chunks: ["Olá, ", "mun"], finish: "error" }), reply({ chunks: ["Olá, ", "mundo!"] })]);
		const out = await h.run();
		expect(out).toMatchObject({ status: "done", text: "Olá, mundo!" });
		// no kernel: delta, delta, retract, delta, delta
		expect(h.log.events.map((e) => e.type).filter((t) => t === "text_delta" || t === "retract")).toEqual(["text_delta", "text_delta", "retract", "text_delta", "text_delta"]);
		const m = createSseMapper({ runId: "run-1", model: "fake-1" });
		const mapped = h.log.events.flatMap((e) => m.mapRunEvent(e));
		expect(mapped.find((e) => e.type === "assistant_discard")).toEqual({ type: "assistant_discard", id: "run-1-step-0", reason: "duplicate" });
		expect(transcriptOf(mapped).map((b) => b.text)).toEqual(["Olá, mundo!"]);
	});

	it("retry sem texto parcial e continuação por limite de saída não retiram nada", async () => {
		const h1 = kernelHarness([reply({ finish: "error" }), reply({ text: "ok" })]);
		await h1.run();
		expect(h1.log.of("retract")).toHaveLength(0);
		const h2 = kernelHarness([reply({ text: "parte um ", finish: "length" }), reply({ text: "parte dois" })]);
		await h2.run();
		expect(h2.log.of("retract")).toHaveLength(0);
	});

	it("ask_owner encerra o turno: cartão, depois done", async () => {
		const h = kernelHarness([reply({ text: "Posso?", calls: [call("q1", "ask_owner", { question: "Quer que eu continue?", offer: "Continuar" })] })]);
		const out = await h.run();
		expect(out.awaiting).toBeDefined();
		const m = createSseMapper({ runId: "run-1", model: "fake-1" });
		const types = h.log.events.flatMap((e) => m.mapRunEvent(e)).map((e) => e.type);
		expect(types).toContain("ask_owner");
		expect(types.at(-1)).toBe("done");
	});

	it("args de tool_call saem sem os valores do cofre do run (S9)", () => {
		const m = createSseMapper({ runId: "run-1", model: "m-1", secrets: () => ["valor-do-cofre-123"] });
		const [ev] = m.map({ type: "tool_call", data: { callId: "c1", name: "http", args: { auth: "valor-do-cofre-123" } } });
		expect(JSON.stringify(ev)).not.toContain("valor-do-cofre-123");
	});
});
