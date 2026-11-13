import { describe, expect, it } from "vitest";
import { resolveAgentCardState, sanitizeAgentV4EventForStorage } from "./agent-v4-card-state.js";

const now = new Date("2026-11-12T12:00:00Z");
const later = new Date("2026-11-13T12:00:00Z");
const earlier = new Date("2026-11-11T12:00:00Z");

describe("estado do card v4 restaurado", () => {
	it("aprovação: pendente enquanto há prazo e o run espera; decidida mostra a decisão", () => {
		const base = { type: "approval_request" as const, now, runStatus: "paused" };
		expect(resolveAgentCardState({ ...base, request: { state: "pending", expiresAt: later } })).toBe("pending");
		expect(resolveAgentCardState({ ...base, request: { state: "approved", expiresAt: later } })).toBe("approved");
		expect(resolveAgentCardState({ ...base, request: { state: "denied", expiresAt: later } })).toBe("denied");
		expect(resolveAgentCardState({ ...base, request: { state: "expired", expiresAt: later } })).toBe("expired");
	});

	it("aprovação vencida (24 h) ou com o run encerrado nunca fica pendente", () => {
		expect(resolveAgentCardState({ type: "approval_request", now, runStatus: "paused", request: { state: "pending", expiresAt: earlier } })).toBe("expired");
		expect(resolveAgentCardState({ type: "approval_request", now, runStatus: "cancelled", request: { state: "pending", expiresAt: later } })).toBe("expired");
		expect(resolveAgentCardState({ type: "approval_request", now, runStatus: "completed", request: null })).toBe("expired");
	});

	it("card emitido e o run ainda não estacionou (sem linha do pedido): pendente", () => {
		expect(resolveAgentCardState({ type: "handoff_request", now, runStatus: "running", request: null })).toBe("pending");
	});

	it("handoff feito", () => {
		expect(resolveAgentCardState({ type: "handoff_request", now, runStatus: "running", request: { state: "done", expiresAt: later } })).toBe("done");
	});

	it("pergunta do bot: resposta registrada vence; oferta ignorada vence; aberta segue pendente mesmo com o run encerrado", () => {
		const base = { type: "ask_owner" as const, now, runStatus: "completed" };
		expect(resolveAgentCardState({ ...base, response: "dismissed", offer: "open" })).toBe("dismissed");
		expect(resolveAgentCardState({ ...base, response: null, offer: "answered" })).toBe("answered");
		expect(resolveAgentCardState({ ...base, response: null, offer: "ignored" })).toBe("expired");
		expect(resolveAgentCardState({ ...base, response: null, offer: "open" })).toBe("pending");
		expect(resolveAgentCardState({ ...base, response: null, offer: null })).toBe("expired");
		expect(resolveAgentCardState({ ...base, runStatus: "running", response: null, offer: null })).toBe("pending");
	});
});

describe("card v4 gravado sem segredo", () => {
	const buy = { type: "approval_request", requestId: "r1", callId: "c1", toolName: "checkout", effect: "money", args: { url: "https://loja.test/pay", cvv: "123", card: { number: "4111111111111111", cardNumber: "4111111111111111" } }, riskFacts: { amount: 10, currency: "BRL", merchant: "loja.test", card: "Visa final 1111", cvc: "999" }, ownerInput: "card_cvv", runId: "run-1" };

	it("tira campos de segredo e número de cartão, mantém o resto e o aviso do campo", () => {
		const stored = sanitizeAgentV4EventForStorage(buy);
		const json = JSON.stringify(stored);
		expect(json).not.toContain("123");
		expect(json).not.toContain("4111111111111111");
		expect(json).not.toContain("999");
		expect(stored).toMatchObject({ type: "approval_request", ownerInput: "card_cvv", riskFacts: { amount: 10, card: "Visa final 1111" } });
	});

	it("redige segredo dentro de texto livre e rejeita o que não é evento v4", () => {
		const stored = sanitizeAgentV4EventForStorage({ type: "handoff_request", callId: "c", message: "Use ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA para entrar" });
		expect(JSON.stringify(stored)).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA");
		expect(sanitizeAgentV4EventForStorage({ type: "assistant_delta", id: "x", delta: "y" })).toBeNull();
	});

	it("não mutila ids de identidade: 2000 sha256 hex determinísticos passam intactos em requestId, callId, cardId e runId", () => {
		let seed = 20261113;
		const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed);
		const hex = (): string => Array.from({ length: 8 }, () => next().toString(16).padStart(8, "0")).join("");
		for (let i = 0; i < 2000; i++) {
			const [requestId, callId, cardId, runId] = [hex(), hex(), hex(), hex()];
			const approval = sanitizeAgentV4EventForStorage({ type: "approval_request", requestId, callId, toolName: "send_email", effect: "send", args: {}, riskFacts: {}, runId });
			expect(approval).toMatchObject({ requestId, callId, runId });
			expect(sanitizeAgentV4EventForStorage({ type: "ask_owner", cardId, question: "Quer?", runId })).toMatchObject({ cardId, runId });
			expect(sanitizeAgentV4EventForStorage({ type: "receipt", id: callId, name: "x", what: "Feito" })).toMatchObject({ id: callId });
		}
	});

	it("o resto do evento continua redigido mesmo com ids intactos", () => {
		const stored = sanitizeAgentV4EventForStorage({ type: "handoff_request", callId: "a".repeat(64), message: "Use ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA para entrar", runId: "run-1" });
		expect(stored).toMatchObject({ callId: "a".repeat(64) });
		expect(JSON.stringify(stored)).not.toContain("ghp_AAAA");
	});
});
