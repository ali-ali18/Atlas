import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { createComputerHandlers } from "@/hooks/use-atlas-chat";
import { applyLiveEvent, applyTaskListEvent, createLiveBubbleState, fromTranscript, hydrateRunEvents, mergePreservingSkills } from "./thread-live";

const delta = (id: string, text: string): ComputerUseEvent => ({ type: "assistant_delta", id, delta: text });

function baseThread(): Message[] {
	return [
		{ id: "u1", kind: "user", text: "oi" },
		{ id: "a1", kind: "assistant", text: "Olá! Como posso ajudar?", runId: "run-0", runSource: { kind: "routine", label: "Resumo", at: "2026-10-01T10:00:00Z" } },
		{ id: "c1", kind: "confirm", title: "Agenda: criar evento?", status: "pending", confirmId: "cf-1" },
		{ id: "u2", kind: "user", text: "marca reunião amanhã" },
	];
}

/** Pipeline completo, à força: uma cópia nova da tela nunca está "assentada", então não pega o caminho rápido. */
function fullPipeline(previous: Message[], event: ComputerUseEvent): Message[] {
	return applyLiveEvent([...previous], event, createLiveBubbleState());
}

test("delta num balão ao vivo existente troca só esse item; os outros mantêm a referência", () => {
	const state = createLiveBubbleState();
	const first = applyLiveEvent(baseThread(), delta("s1", "Vou "), state);
	const second = applyLiveEvent(first, delta("s1", "marcar"), state);
	assert.notEqual(second, first);
	assert.equal(second.length, first.length);
	const live = second.findIndex((item) => item.id === "cu-s1");
	assert.equal(second[live]?.kind === "assistant" ? second[live].text : null, "Vou marcar");
	second.forEach((item, index) => {
		if (index !== live) assert.equal(item, first[index], `item ${item.id} deveria ser a mesma referência`);
	});
	// A tela anterior não é alterada (imutável).
	const before = first[live];
	assert.equal(before?.kind === "assistant" ? before.text : null, "Vou ");
});

test("o caminho rápido dá o mesmo resultado do pipeline completo", () => {
	const state = createLiveBubbleState();
	let fast = applyLiveEvent(baseThread(), delta("s1", "Primeiro "), state);
	let full = fullPipeline(baseThread(), delta("s1", "Primeiro "));
	for (const piece of ["pedaço", " do texto", "\n\nsegundo parágrafo."]) {
		fast = applyLiveEvent(fast, delta("s1", piece), state);
		full = fullPipeline(full, delta("s1", piece));
	}
	const shape = (items: Message[]) => items.map((item) => ({ id: item.id, kind: item.kind, text: "text" in item ? item.text : undefined }));
	assert.deepEqual(shape(fast), shape(full));
});

test("caminho rápido: balão cuja fala inteira já está gravada sai da tela e os deltas seguintes são ignorados", () => {
	const state = createLiveBubbleState();
	const persisted: Message[] = [...baseThread(), { id: "a2", kind: "assistant", text: "Reunião marcada para amanhã às 10h." }];
	const started = applyLiveEvent(persisted, delta("s2", "Reunião marcada para amanhã"), state);
	assert.ok(started.some((item) => item.id === "cu-s2"));
	const covered = applyLiveEvent(started, delta("s2", " às 10h."), state);
	assert.equal(covered.some((item) => item.id === "cu-s2"), false);
	assert.ok(state.superseded.has("cu-s2"));
	assert.equal(applyLiveEvent(covered, delta("s2", " Mais algo"), state), covered);
});

test("tela que não veio do pipeline (cartão, sync) passa pelo pipeline completo no primeiro delta", () => {
	const state = createLiveBubbleState();
	const live = applyLiveEvent(baseThread(), delta("s1", "Vou "), state);
	// Cartão inserido por outro caminho, sem dedupe: o pipeline completo colapsa o card repetido.
	const withDuplicate: Message[] = [...live, { id: "c1-live", kind: "confirm", title: "Agenda: criar evento?", status: "pending", confirmId: "cf-1" }];
	const next = applyLiveEvent(withDuplicate, delta("s1", "marcar"), state);
	assert.equal(next.filter((item) => item.kind === "confirm").length, 1);
});

test("descarte e erro continuam no pipeline completo (rascunho revisado, texto não some)", () => {
	const state = createLiveBubbleState();
	let screen = applyLiveEvent(baseThread(), delta("s1", "Rascunho que vai ser refeito"), state);
	screen = applyLiveEvent(screen, { type: "assistant_discard", id: "s1", reason: "evidence" }, state);
	const draft = screen.find((item) => item.id === "cu-s1");
	assert.equal(draft?.kind, "assistant");
	assert.equal(draft?.kind === "assistant" ? draft.text : "", "Rascunho que vai ser refeito");
	screen = applyLiveEvent(screen, { type: "error", error: "Falhou ao criar o evento." }, state);
	assert.ok(screen.some((item) => item.id === "cu-run-error"));
});

test("fromTranscript e o merge reaproveitam os objetos que não mudaram (campos extras preservados)", () => {
	const thread = baseThread();
	const rebuilt = fromTranscript(thread.filter((item) => item.kind !== "confirm") as never, thread);
	assert.equal(rebuilt[1], thread[1]);
	const merged = mergePreservingSkills(thread, rebuilt);
	merged.forEach((item, index) => assert.equal(item, thread[index]));
	const assistant = merged[1];
	assert.equal(assistant?.kind === "assistant" ? assistant.runId : undefined, "run-0");
});

test("hidratação reaplica os eventos e a tela resultante aceita o caminho rápido", () => {
	const state = createLiveBubbleState();
	const hydrated = hydrateRunEvents(baseThread(), [delta("s1", "Retomando ")], state);
	const next = applyLiveEvent(hydrated, delta("s1", "daqui"), state);
	hydrated.forEach((item, index) => {
		if (item.id !== "cu-s1") assert.equal(next[index], item);
	});
});

test("merge é linear: milhares de itens não custam O(n²)", () => {
	const big: Message[] = Array.from({ length: 6000 }, (_, index) => ({ id: `m${index}`, kind: index % 2 ? "assistant" : "user", text: `fala ${index}` }) as Message);
	const transcript = [...big, { id: "cu-x", kind: "assistant", text: "novo" } as Message];
	const started = performance.now();
	const merged = mergePreservingSkills(big, transcript);
	assert.equal(merged.length, big.length + 1);
	assert.ok(performance.now() - started < 1500);
});

const taskListEvent = (items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>, runId?: string): ComputerUseEvent => ({ type: "task_list", items, ...(runId ? { runId } : {}) });
const STEPS = [
	{ content: "Ler", status: "completed" as const },
	{ content: "Montar", status: "in_progress" as const },
];

test("reconexão: task_list no meio dos eventos do run mantém a última lista na tela", () => {
	const events = [
		taskListEvent([{ content: "Ler", status: "in_progress" }, { content: "Montar", status: "pending" }], "run-1"),
		delta("s1", "Lendo o arquivo"),
		taskListEvent(STEPS, "run-1"),
		delta("s2", "Montando"),
	];
	const screen = hydrateRunEvents(baseThread(), events, createLiveBubbleState(), "run-1");
	const cards = screen.filter((item) => item.kind === "task-list");
	assert.equal(cards.length, 1);
	assert.deepEqual(cards[0]?.kind === "task-list" ? cards[0].items : null, STEPS);
	assert.equal(cards[0]?.id, "task-list-run-1");
});

test("reconexão: evento sem runId usa o run da reidratação; lista vazia não cria cartão", () => {
	const screen = hydrateRunEvents(baseThread(), [taskListEvent(STEPS)], createLiveBubbleState(), "run-7");
	assert.equal(screen.find((item) => item.kind === "task-list")?.kind === "task-list" && (screen.find((item) => item.kind === "task-list") as { runId: string }).runId, "run-7");
	assert.equal(hydrateRunEvents(baseThread(), [taskListEvent([])], createLiveBubbleState(), "run-7").some((item) => item.kind === "task-list"), false);
});

test("dedupe ao vivo × gravado: a lista reidratada atualiza o cartão gravado do run no lugar, sem duplicar", () => {
	const persisted: Message[] = [...baseThread(), { id: "db-tl", kind: "task-list", runId: "run-1", items: [{ content: "Ler", status: "pending" }] }];
	const screen = hydrateRunEvents(persisted, [taskListEvent(STEPS, "run-1")], createLiveBubbleState(), "run-1");
	const cards = screen.filter((item) => item.kind === "task-list");
	assert.equal(cards.length, 1);
	assert.equal(cards[0]?.id, "db-tl");
	assert.deepEqual(cards[0]?.kind === "task-list" ? cards[0].items : null, STEPS);
	// E um evento ao vivo seguinte continua no mesmo cartão.
	const live = applyTaskListEvent(screen, { type: "task_list", items: [{ content: "Ler", status: "completed" }, { content: "Montar", status: "completed" }], runId: "run-1" });
	assert.equal(live.filter((item) => item.kind === "task-list").length, 1);
});

test("onTaskList do handler real usa o runId do run quando o evento vem sem runId", () => {
	let messages: Message[] = baseThread();
	const handlers = createComputerHandlers({
		runId: "run-9",
		setMessages: (update: Message[] | ((previous: Message[]) => Message[])) => { messages = typeof update === "function" ? update(messages) : update; },
	} as never);
	handlers.onTaskList?.({ type: "task_list", items: STEPS });
	const card = messages.find((item) => item.kind === "task-list");
	assert.equal(card?.kind === "task-list" ? card.runId : null, "run-9");
	assert.equal(card?.id, "task-list-run-9");
});
