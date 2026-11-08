import type { AgentV4Event, ApprovalRequestEvent } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { addAgentCard, agentCardFromStored, agentCardItem, agentCardPending, approvalDetails, approvalMessageBody, approvalPaysWithoutForm, approvalSummaryLines, askOwnerAnswerText, askOwnerQuestionnaireItem, asAgentCardEvent, cvvComplete, cvvDigits, describeApproval, formatMoney, handoffSteps, safeReceiptUrl, settleAgentCardsForCall } from "./agent-cards";
import type { ChatItem } from "./chat-types";

const approval: ApprovalRequestEvent = { type: "approval_request", requestId: "req-1", callId: "call-1", toolName: "send_email", effect: "send", args: { to: "ana@exemplo.com", subject: "Orçamento de novembro" }, riskFacts: { recipients: ["ana@exemplo.com"], externalRecipients: ["ana@exemplo.com"], irreversible: true }, runId: "run-1" };

describe("card do fio", () => {
	it("o gravado (role = tipo, content = JSON) vira o mesmo card e a mesma chave do ao vivo", () => {
		const stored = agentCardFromStored("db-1", "approval_request", JSON.stringify(approval), { createdAt: "2026-11-08T10:00:00.000Z" });
		expect(stored).toMatchObject({ id: "db-1", kind: "agent-card", card: approval });
		const live = agentCardItem(approval);
		expect(live.id).toBe("agent-card-approval_request|run-1|req-1");
	});
	it("JSON inválido, tipo que não bate ou campo fora do contrato = sem card", () => {
		expect(agentCardFromStored("x", "approval_request", "{não é json")).toBeNull();
		expect(agentCardFromStored("x", "ask_owner", JSON.stringify(approval))).toBeNull();
		expect(agentCardFromStored("x", "approval_request", JSON.stringify({ ...approval, effect: "inventado" }))).toBeNull();
		expect(agentCardFromStored("x", "assistant", JSON.stringify(approval))).toBeNull();
	});
	it("o run da linha gravada é a reserva da chave", () => {
		const { runId: _drop, ...semRun } = approval;
		expect(agentCardFromStored("db-2", "approval_request", JSON.stringify(semRun), { runId: "run-9" })?.card.runId).toBe("run-9");
	});
	it("evento do stream: só tipo v4 válido vira card", () => {
		expect(asAgentCardEvent(approval as never)).toEqual(approval);
		expect(asAgentCardEvent({ type: "done" } as never)).toBeNull();
		expect(asAgentCardEvent({ ...approval, requestId: "" } as never)).toBeNull();
	});
	it("a reconexão reentrega o evento: o card não entra duas vezes", () => {
		const once = addAgentCard([], approval, "run-1");
		expect(addAgentCard(once, approval, "run-1")).toBe(once);
		expect(addAgentCard(once, { ...approval, requestId: "req-2" }, "run-1")).toHaveLength(2);
	});
	it("o resultado da chamada tira os botões; run diferente não mexe", () => {
		const items = addAgentCard([], approval, "run-1");
		const settled = settleAgentCardsForCall(items, "call-1", "run-1");
		expect(settled[0]).toMatchObject({ settled: true });
		expect(settleAgentCardsForCall(items, "call-1", "run-2")).toBe(items);
		expect(settleAgentCardsForCall(items, "outra", "run-1")).toBe(items);
	});
});

describe("frases", () => {
	it("diz o que vai ser feito sem nome de ferramenta", () => {
		expect(describeApproval(approval)).toBe("Enviar para ana@exemplo.com");
		expect(describeApproval({ ...approval, effect: "money", riskFacts: { amount: 89.9, currency: "BRL", merchant: "Livraria" } })).toMatch(/^Pagar R\$\s89,90 em Livraria$/);
		expect(describeApproval({ ...approval, effect: "destructive", riskFacts: { target: "pasta Fotos" } })).toBe("Apagar pasta Fotos");
		expect(describeApproval({ ...approval, effect: "read", riskFacts: {} })).toBe("Consultar uma informação");
	});
	it("detalhes: só valores simples; credencial não mostra nada", () => {
		expect(approvalDetails(approval)).toEqual(["ana@exemplo.com", "Orçamento de novembro"]);
		expect(approvalDetails({ ...approval, effect: "credential" })).toEqual([]);
	});
	it("aprovação de evento diz qual evento, quando e quem, sem id nem texto interno", () => {
		const event = { ...approval, toolName: "calendar_delete", effect: "destructive" as const, args: { eventId: "abc123xyz" }, riskFacts: { irreversible: true, event: { action: "delete", title: "Reunião de produto", start: "2026-11-05T17:00:00.000Z", end: "2026-11-05T18:00:00.000Z", timeZone: "America/Sao_Paulo", location: "Sala 2", guests: ["ana@exemplo.com"], notifyGuests: false } } };
		expect(describeApproval(event)).toBe("Apagar o evento “Reunião de produto”");
		const lines = approvalSummaryLines(event);
		expect(lines[0]).toMatch(/14:00/);
		expect(lines.slice(1)).toEqual(["Local: Sala 2", "Convidados: ana@exemplo.com", "Os convidados não serão avisados."]);
		expect(approvalDetails(event)).toEqual([]);
		expect([describeApproval(event), ...lines].join(" ")).not.toMatch(/abc123xyz|Google Calendar|delete event/);
		expect(describeApproval({ ...event, riskFacts: { event: { action: "delete" } } })).toBe("Apagar um evento da agenda");
	});
	it("aprovação de e-mail: assunto, de onde sai e corpo inteiro; sem source nem in_reply_to", () => {
		const body = "Olá,\n".repeat(300);
		const mail = { ...approval, args: { source: "gmail", to: ["ana@exemplo.com"], body, in_reply_to: "msg-1" }, riskFacts: { recipients: ["ana@exemplo.com"], message: { subject: "Orçamento", body, from: "gmail", reply: true } } };
		expect(approvalSummaryLines(mail)).toEqual(["Assunto: Orçamento", "Sai do seu Gmail."]);
		expect(approvalMessageBody(mail)).toBe(body.trim());
		expect(approvalDetails(mail)).toEqual([]);
	});
	it("pagamento sem formulário do cartão não pode ser aprovado; outros efeitos podem", () => {
		expect(approvalPaysWithoutForm({ ...approval, effect: "money" })).toBe(true);
		expect(approvalPaysWithoutForm(approval)).toBe(false);
	});
	it("passo a passo tira a numeração que o texto traz", () => {
		expect(handoffSteps("1. Abra o app do banco\n2) Aprove o Pix\n- Volte aqui")).toEqual(["Abra o app do banco", "Aprove o Pix", "Volte aqui"]);
	});
	it("link do recibo só http(s)", () => {
		expect(safeReceiptUrl("https://cal.example.com/e/1")).toBe("https://cal.example.com/e/1");
		expect(safeReceiptUrl("javascript:alert(1)")).toBeNull();
		expect(safeReceiptUrl(undefined)).toBeNull();
	});
	it("dinheiro em reais", () => {
		expect(formatMoney(109.8, "BRL")).toMatch(/R\$\s109,80/);
	});
});

describe("pergunta do bot", () => {
	const ask: Extract<AgentV4Event, { type: "ask_owner" }> = { type: "ask_owner", cardId: "run-1:k1", question: "Qual capa?", choices: [{ value: "dura", label: "Capa dura" }, { value: "comum" }], runId: "run-1" };
	it("vira um item de questionário com as alternativas e o campo livre", () => {
		const item = askOwnerQuestionnaireItem(ask);
		expect(item).toMatchObject({ name: "answer", prompt: "Qual capa?", required: true, choices: [{ value: "dura", label: "Capa dura" }, { value: "comum" }] });
		expect(item.input).toBeDefined();
		expect(askOwnerQuestionnaireItem({ ...ask, choices: undefined })).not.toHaveProperty("choices");
	});
	it("o texto da resposta usa o rótulo da alternativa (ou o que foi digitado)", () => {
		expect(askOwnerAnswerText(ask, "dura")).toBe("Capa dura");
		expect(askOwnerAnswerText(ask, ["dura", "comum"])).toBe("Capa dura, comum");
		expect(askOwnerAnswerText(ask, "  qualquer uma  ")).toBe("qualquer uma");
		expect(askOwnerAnswerText(ask, undefined)).toBe("");
	});
});

describe("CVV", () => {
	it("só dígitos, no máximo 4; completo com 3 ou 4", () => {
		expect(cvvDigits("1a2 3-4 5")).toBe("1234");
		expect(cvvComplete("12")).toBe(false);
		expect(cvvComplete("123")).toBe(true);
		expect(cvvComplete("1234")).toBe(true);
		expect(cvvComplete("12345")).toBe(false);
	});
});

describe("quando o card ainda pede o dono", () => {
	const item = (card: AgentV4Event, settled?: boolean): Extract<ChatItem, { kind: "agent-card" }> => ({ id: "x", kind: "agent-card", card, ...(settled ? { settled } : {}) });
	const none = { pausedRunId: null, laterUserMessage: false };
	it("aprovação e handoff só com o run dele parado esperando", () => {
		expect(agentCardPending(item(approval), { ...none, pausedRunId: "run-1" })).toBe(true);
		expect(agentCardPending(item(approval), { ...none, pausedRunId: "run-2" })).toBe(false);
		expect(agentCardPending(item(approval), none)).toBe(false);
		expect(agentCardPending(item({ type: "handoff_request", callId: "c", message: "x", runId: "run-1" }), { ...none, pausedRunId: "run-1" })).toBe(true);
	});
	it("decidido ou resolvido em outro lugar = sem botões", () => {
		const paused = { ...none, pausedRunId: "run-1" };
		expect(agentCardPending(item(approval), paused, "approved")).toBe(false);
		expect(agentCardPending(item(approval, true), paused)).toBe(false);
	});
	it("pergunta vale até o dono falar de outra coisa", () => {
		const ask: AgentV4Event = { type: "ask_owner", cardId: "k", question: "?", runId: "run-1" };
		expect(agentCardPending(item(ask), none)).toBe(true);
		expect(agentCardPending(item(ask), { ...none, laterUserMessage: true })).toBe(false);
	});
	it("recibo nunca pede nada", () => {
		expect(agentCardPending(item({ type: "receipt", id: "r", name: "n", what: "Feito" }), none)).toBe(false);
	});
});
