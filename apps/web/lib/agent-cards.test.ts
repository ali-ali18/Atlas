import assert from "node:assert/strict";
import test from "node:test";
import type { AgentV4Event, ComputerUseEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { createTranslator } from "@/lib/i18n/translator";
import { loadMessages } from "@/lib/i18n/messages";
import { dispatchComputerUseEvent, type ComputerUseHandlers } from "./atlas-api";
import {
	agentCardFromStored,
	agentCardKey,
	agentCardMessage,
	applyAgentCardEvent,
	applyAgentCardEvents,
	approvalDetailValues,
	approvalDetails,
	askOwnerAnswerText,
	askOwnerQuestionnaire,
	approvalNeedsCardCode,
	describeApproval,
	handoffSteps,
	safeReceiptUrl,
	settleAgentCardsForCall,
} from "./agent-cards";
import { hydrateRunEvents } from "./thread-live";
import { buildSessionMessage } from "@/hooks/use-atlas-chat";

const approval = (over: Partial<Extract<AgentV4Event, { type: "approval_request" }>> = {}): Extract<AgentV4Event, { type: "approval_request" }> => ({
	type: "approval_request",
	requestId: "req-1",
	callId: "call-1",
	toolName: "send_email",
	effect: "send",
	args: { to: "ana@exemplo.com", subject: "Orçamento" },
	riskFacts: { recipients: ["ana@exemplo.com"] },
	runId: "run-1",
	...over,
});
const receipt: AgentV4Event = { type: "receipt", id: "call-9", name: "create_event", what: "Evento criado: Reunião", where: "Agenda", url: "https://calendar.example.com/e/1", runId: "run-1" };
const user = (id: string, text = "oi"): Message => ({ id, kind: "user", text });

test("frase da aprovação sai do efeito e dos fatos, nunca do nome da ferramenta", () => {
	const text = describeApproval(approval());
	assert.equal(text, "Enviar para ana@exemplo.com");
	assert.doesNotMatch(text, /send_email|riskFacts|recipients/);
	// O Intl separa o símbolo da moeda com espaço sem quebra: normaliza para comparar.
	assert.equal(describeApproval(approval({ effect: "money", riskFacts: { amount: 120, currency: "brl", merchant: "Loja X" } })).replace(/\s/g, " "), "Pagar R$ 120,00 em Loja X");
	assert.equal(describeApproval(approval({ effect: "money", riskFacts: {} })), "Fazer um pagamento");
	assert.equal(describeApproval(approval({ effect: "destructive", riskFacts: { target: "planilha.xlsx" } })), "Apagar planilha.xlsx");
	assert.equal(describeApproval(approval({ effect: "public_link", riskFacts: {} })), "Criar um link público");
	// Fato com tipo errado é ignorado (o tipo em shared é aberto): sem quebrar, cai na frase genérica.
	assert.equal(describeApproval(approval({ riskFacts: { recipients: "não é lista" } })), "Enviar uma mensagem");
});

test("frase da aprovação no idioma da tela", async () => {
	const en = createTranslator("en-US", await loadMessages("en-US"));
	assert.equal(describeApproval(approval({ effect: "money", riskFacts: { amount: 10, currency: "USD", merchant: "Shop" } }), en).replace(/\s/g, " "), "Pay $10.00 at Shop");
});

test("pagamento reserva o espaço do código do cartão; outros efeitos não", () => {
	assert.equal(approvalNeedsCardCode(approval({ effect: "money" })), true);
	assert.equal(approvalNeedsCardCode(approval()), false);
});

test("detalhes mostram só valores simples, sem os nomes dos campos e com teto", () => {
	const values = approvalDetailValues({ to: "ana@exemplo.com", nested: { amount: 3, flag: true }, list: ["a", "b"], empty: "  " });
	assert.deepEqual(values, ["ana@exemplo.com", "3", "a", "b"]);
	assert.equal(approvalDetailValues(Array.from({ length: 20 }, (_, i) => `v${i}`)).length, 6);
	assert.deepEqual(approvalDetailValues(null), []);
});

test("passo a passo do handoff: uma linha por passo, sem a numeração do texto", () => {
	assert.deepEqual(handoffSteps("1. Abra o banco\n2) Toque em Pix\n\n- Confirme"), ["Abra o banco", "Toque em Pix", "Confirme"]);
	assert.deepEqual(handoffSteps("Troque a senha no site."), ["Troque a senha no site."]);
});

test("link do recibo só http(s)", () => {
	assert.equal(safeReceiptUrl("javascript:alert(1)"), null);
	assert.equal(safeReceiptUrl("nao é url"), null);
	assert.equal(safeReceiptUrl("https://a.com/x"), "https://a.com/x");
	assert.equal(safeReceiptUrl(undefined), null);
});

test("card ao vivo entra no fim uma vez só (reconexão reentrega o evento)", () => {
	const thread = [user("u1")];
	const once = applyAgentCardEvent(thread, approval());
	assert.equal(once.length, 2);
	assert.equal(once[1]!.kind, "agent-card");
	assert.equal(applyAgentCardEvent(once, approval()), once);
	// O runId de reserva entra no card que não trouxe o dele (a resposta precisa saber para onde ir).
	const withoutRun = approval({ runId: undefined });
	const added = applyAgentCardEvent(thread, withoutRun, "run-7");
	const card = added[1];
	assert.ok(card?.kind === "agent-card" && card.card.runId === "run-7");
});

test("resultado da chamada estacionada deixa o card resolvido; outra chamada não mexe", () => {
	const thread = applyAgentCardEvent([user("u1")], approval());
	assert.equal(settleAgentCardsForCall(thread, "outra"), thread);
	const settled = settleAgentCardsForCall(thread, "call-1");
	assert.ok(settled[1]?.kind === "agent-card" && settled[1].settled === true);
});

test("hidratação de um run vivo restaura os cards e marca o já resolvido", () => {
	const events: ComputerUseEvent[] = [
		approval(),
		{ type: "tool_result", id: "call-1", name: "send_email", ok: true, summary: "ok" },
		receipt,
		{ type: "handoff_request", callId: "call-2", message: "1. Entre no banco\n2. Aprove o Pix", runId: "run-1" },
		// Payload inválido (versão diferente do worker) não vira card.
		{ type: "ask_owner", cardId: "", question: "?" } as ComputerUseEvent,
	];
	const result = hydrateRunEvents([user("u1")], events, undefined, "run-1");
	const cards = result.filter((item): item is Extract<Message, { kind: "agent-card" }> => item.kind === "agent-card");
	assert.deepEqual(cards.map((card) => card.card.type), ["approval_request", "receipt", "handoff_request"]);
	assert.equal(cards[0]!.settled, true);
	assert.equal(cards[2]!.settled, undefined);
	// Reaplicar os mesmos eventos não duplica.
	assert.equal(applyAgentCardEvents(result, events, "run-1").filter((item) => item.kind === "agent-card").length, 3);
});

test("despacho: os 4 eventos v4 chegam validados ao handler; inválido é ignorado", () => {
	const seen: AgentV4Event[] = [];
	const handlers: ComputerUseHandlers = { onDelta: () => undefined, onAgentCard: (event) => seen.push(event) };
	dispatchComputerUseEvent(approval(), handlers);
	dispatchComputerUseEvent({ type: "handoff_request", callId: "c", message: "faça" }, handlers);
	dispatchComputerUseEvent({ type: "ask_owner", cardId: "k", question: "Qual cor?" }, handlers);
	dispatchComputerUseEvent(receipt, handlers);
	dispatchComputerUseEvent({ type: "approval_request", requestId: "r" } as unknown as ComputerUseEvent, handlers);
	assert.deepEqual(seen.map((event) => event.type), ["approval_request", "handoff_request", "ask_owner", "receipt"]);
	// Cliente sem o handler (versão antiga do componente) não quebra.
	assert.doesNotThrow(() => dispatchComputerUseEvent(receipt, { onDelta: () => undefined }));
});

test("card gravado na conversa (role = tipo do evento) é restaurado e validado", () => {
	const restored = buildSessionMessage({ id: "db-9", role: "receipt", content: JSON.stringify(receipt), createdAt: "2026-11-06T10:00:00Z" } as never);
	assert.ok(restored?.kind === "agent-card");
	assert.equal(restored.id, "db-9");
	assert.equal(agentCardKey(restored.card), agentCardKey(receipt));
	assert.equal(agentCardFromStored("db-1", "receipt", "{quebrado"), null);
	assert.equal(agentCardFromStored("db-1", "ask_owner", JSON.stringify(receipt)), null);
	assert.equal(agentCardFromStored("db-1", "assistant", JSON.stringify(receipt)), null);
});

test("ids do ao vivo seguem a chave estável", () => {
	assert.equal(agentCardMessage(approval()).id, "agent-card-approval_request|run-1|req-1");
});

test("card gravado sem runId no evento usa o run da linha: mesma chave do ao vivo (auditoria)", () => {
	const { runId: _omit, ...withoutRun } = receipt as Extract<AgentV4Event, { type: "receipt" }>;
	const stored = agentCardFromStored("db-1", "receipt", JSON.stringify(withoutRun), "run-1");
	assert.ok(stored);
	assert.equal(agentCardKey(stored.card), agentCardKey(receipt));
});

test("resultado de chamada com o mesmo id em outro run não resolve o card (auditoria)", () => {
	const thread = applyAgentCardEvent([user("u1")], approval());
	assert.equal(settleAgentCardsForCall(thread, "call-1", "run-2"), thread);
	assert.notEqual(settleAgentCardsForCall(thread, "call-1", "run-1"), thread);
});

test("aprovação de credencial não mostra os valores (auditoria)", () => {
	assert.deepEqual(approvalDetails(approval({ effect: "credential", args: { name: "senha-banco" } })), []);
	assert.deepEqual(approvalDetails(approval()), ["ana@exemplo.com", "Orçamento"]);
});

const ask: Extract<AgentV4Event, { type: "ask_owner" }> = {
	type: "ask_owner",
	cardId: "k1",
	question: "  Qual capa?  ",
	choices: [{ value: "comum", label: "Capa comum" }, { value: "dura", description: "R$ 30 a mais" }],
};

test("pergunta do bot vira questionário com a alternativa e o campo livre obrigatório", () => {
	const message = askOwnerQuestionnaire(ask, "Pergunta", "pending");
	assert.equal(message.kind, "questionnaire");
	assert.equal(message.questionnaireId, "k1");
	assert.equal(message.status, "pending");
	assert.equal(message.items.length, 1);
	assert.equal(message.items[0]?.name, "answer");
	assert.equal(message.items[0]?.prompt, "Qual capa?");
	assert.equal(message.items[0]?.required, true);
	assert.equal(message.items[0]?.choices?.length, 2);
	assert.equal(message.answers, undefined);
});

test("pergunta sem pergunta usa a oferta; sem alternativas não tem choices; respondida leva as respostas", () => {
	const message = askOwnerQuestionnaire({ type: "ask_owner", cardId: "k2", question: "  ", offer: "Quer que eu agende?" }, "T", "submitted", { answer: "Sim" });
	assert.equal(message.items[0]?.prompt, "Quer que eu agende?");
	assert.equal(message.items[0]?.choices, undefined);
	assert.deepEqual(message.answers, { answer: "Sim" });
});

test("texto da resposta: rótulo da alternativa, valor se não houver, lista com vírgula, vazio some", () => {
	assert.equal(askOwnerAnswerText(ask, "comum"), "Capa comum");
	assert.equal(askOwnerAnswerText(ask, "dura"), "dura");
	assert.equal(askOwnerAnswerText(ask, "outra coisa"), "outra coisa");
	assert.equal(askOwnerAnswerText(ask, ["comum", "x"]), "Capa comum, x");
	assert.equal(askOwnerAnswerText(ask, "  "), "");
	assert.equal(askOwnerAnswerText(ask, undefined), "");
});
