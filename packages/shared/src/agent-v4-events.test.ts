import { describe, expect, it } from "vitest";
import { AGENT_V4_EVENT_TYPES, AGENT_V4_TEXT_MAX, isAgentV4EventType, parseAgentV4Event } from "./agent-v4-events.js";
import { applyComputerUseEventsToTranscript, type TranscriptBubble } from "./run-transcript.js";
import type { ComputerUseEvent } from "./computer.js";

const approval = { type: "approval_request", requestId: "r1", callId: "c1", toolName: "send_email", effect: "send", args: { to: "a@b.test" }, riskFacts: { recipients: ["a@b.test"] }, runId: "run-1" };

describe("eventos do motor v4 no contrato SSE", () => {
	it("aceita cada tipo válido e descarta campo extra", () => {
		expect(parseAgentV4Event(approval)).toEqual(approval);
		expect(parseAgentV4Event({ ...approval, evil: 1 })).toEqual(approval);
		expect(parseAgentV4Event({ type: "handoff_request", callId: "c", message: "É com você." })).toEqual({ type: "handoff_request", callId: "c", message: "É com você." });
		expect(parseAgentV4Event({ type: "ask_owner", cardId: "k", question: "Quer?", offer: "Sim" })).toEqual({ type: "ask_owner", cardId: "k", question: "Quer?", offer: "Sim" });
		expect(parseAgentV4Event({ type: "receipt", id: "c", name: "create_event", what: "Evento criado", externalId: "ev-1" })).toEqual({ type: "receipt", id: "c", name: "create_event", what: "Evento criado", externalId: "ev-1" });
	});

	it("cartão de compra: ownerInput e inputOnly passam; valor desconhecido é descartado", () => {
		const buy = { ...approval, toolName: "checkout", effect: "money", ownerInput: "card_cvv", inputOnly: true };
		expect(parseAgentV4Event(buy)).toEqual(buy);
		expect(parseAgentV4Event({ ...buy, ownerInput: "outra", inputOnly: "sim" })).toEqual({ ...approval, toolName: "checkout", effect: "money" });
	});

	it("rejeita o inválido: tipo desconhecido, efeito fora do vocabulário, texto vazio ou gigante, não objeto", () => {
		expect(parseAgentV4Event(null)).toBeNull();
		expect(parseAgentV4Event("approval_request")).toBeNull();
		expect(parseAgentV4Event({ type: "assistant_delta", id: "x", delta: "y" })).toBeNull();
		expect(parseAgentV4Event({ ...approval, effect: "nuke" })).toBeNull();
		expect(parseAgentV4Event({ ...approval, riskFacts: [] })).toBeNull();
		expect(parseAgentV4Event({ ...approval, requestId: "" })).toBeNull();
		expect(parseAgentV4Event({ type: "receipt", id: "c", name: "n", what: "x".repeat(AGENT_V4_EVENT_TYPES.length + AGENT_V4_TEXT_MAX) })).toBeNull();
		expect(parseAgentV4Event({ type: "ask_owner", cardId: "k", question: 7 })).toBeNull();
	});

	it("pergunta ao dono: alternativas opcionais, validadas item a item", () => {
		const base = { type: "ask_owner", cardId: "k", question: "Qual?" };
		const choices = [{ value: "a", label: "A" }, { value: "b", description: "mais caro" }];
		expect(parseAgentV4Event({ ...base, choices })).toEqual({ ...base, choices });
		expect(parseAgentV4Event({ ...base, choices: [{ value: "a", evil: 1 }] })).toEqual({ ...base, choices: [{ value: "a" }] });
		expect(parseAgentV4Event(base)).toEqual(base);
		expect(parseAgentV4Event({ ...base, choices: "a" })).toBeNull();
		expect(parseAgentV4Event({ ...base, choices: [{ label: "A" }] })).toBeNull();
		expect(parseAgentV4Event({ ...base, choices: [{ value: "a", label: 3 }] })).toBeNull();
		expect(parseAgentV4Event({ ...base, choices: Array.from({ length: 13 }, (_, i) => ({ value: `v${i}` })) })).toBeNull();
		expect(parseAgentV4Event({ ...base, choices: Array.from({ length: 12 }, (_, i) => ({ value: `v${i}` })) })).not.toBeNull();
	});

	it("o guarda de tipo cobre exatamente a lista", () => {
		for (const t of AGENT_V4_EVENT_TYPES) expect(isAgentV4EventType(t)).toBe(true);
		expect(isAgentV4EventType("done")).toBe(false);
	});

	it("o reducer de transcript do cliente ignora os tipos novos (web e celular não mudam)", () => {
		const before: TranscriptBubble[] = [{ id: "cu-a", kind: "assistant", text: "oi" }];
		const events = [approval, { type: "handoff_request", callId: "c", message: "m" }, { type: "ask_owner", cardId: "k", question: "q" }, { type: "receipt", id: "c", name: "n", what: "w" }] as ComputerUseEvent[];
		expect(applyComputerUseEventsToTranscript(before, events)).toEqual(before);
	});
});
