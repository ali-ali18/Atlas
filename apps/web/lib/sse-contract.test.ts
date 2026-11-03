// Contrato SSE de run (harness v3, PR3b): o front publicado precisa sobreviver a tipo de evento novo e só
// pode encerrar o run pelos terminais de hoje. Espelho no mobile: `apps/mobile/lib/sse-contract.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";

import { parseSseBlock, RUN_EVENT_TYPES, RUN_TERMINAL_EVENTS, runTerminalKey, type ComputerUseEvent } from "@workspace/shared";
import { dispatchComputerUseEvent, isRunTerminalEvent, type ComputerUseHandlers } from "./atlas-api";

/** Handlers que só anotam o que foi chamado; os "terminais" são os que a UI usa para fechar o run. */
function spy() {
	const calls: string[] = [];
	const note = (name: string) => () => { calls.push(name); };
	const handlers: ComputerUseHandlers = {
		onDelta: note("onDelta"),
		onRunId: note("onRunId"),
		onToolIntent: note("onToolIntent"),
		onToolCall: note("onToolCall"),
		onToolResult: note("onToolResult"),
		onChart: note("onChart"),
		onPage: note("onPage"),
		onFile: note("onFile"),
		onTaskList: note("onTaskList"),
		onStatus: (status) => { calls.push(status === "budget_exhausted" ? "terminal:budget_exhausted" : "onStatus"); },
		onDone: note("terminal:done"),
		onPaused: note("terminal:paused"),
		onCancelled: note("terminal:cancelled"),
		onError: note("terminal:error"),
	};
	return { calls, handlers };
}

const sse = (id: number, event: object) => `id: ${id}\ndata: ${JSON.stringify(event)}`;

const sequence: ComputerUseEvent[] = [
	{ type: "run", runId: "r1", status: "running" },
	{ type: "assistant_delta", id: "a1", delta: "Olá" },
	{ type: "tool_intent", name: "run_code" },
	{ type: "tool_call", id: "t1", name: "run_code", args: "{}", step: 1, maxSteps: 8 },
	{ type: "tool_result", id: "t1", name: "run_code", ok: true, summary: "ok" },
	{ type: "task_list", items: [{ content: "Passo", status: "in_progress" }], runId: "r1" },
	{ type: "file", artifactId: "f1", filename: "a.pdf", mime: "application/pdf", size: 1, format: "pdf", version: 1, runId: "r1" },
	{ type: "done", message: { role: "assistant", content: "pronto" }, model: "m" },
];

test("sequência completa passa por parseSseBlock + dispatch e só o done encerra", () => {
	const { calls, handlers } = spy();
	sequence.forEach((event, index) => {
		const parsed = parseSseBlock(sse(index + 1, event));
		assert.equal(parsed.id, index + 1);
		assert.ok(parsed.event);
		dispatchComputerUseEvent(parsed.event, handlers, { seq: parsed.id });
	});
	assert.deepEqual(calls.filter((name) => name.startsWith("terminal:")), ["terminal:done"]);
	assert.equal(calls.at(-1), "terminal:done");
	assert.ok(calls.includes("onTaskList") && calls.includes("onFile") && calls.includes("onToolResult"));
});

test("tipo desconhecido é ignorado sem chamar handler nem quebrar o fluxo seguinte", () => {
	const { calls, handlers } = spy();
	const unknown = parseSseBlock(sse(1, { type: "tipo_do_futuro", payload: { x: 1 } }));
	assert.ok(unknown.event, "o parser entrega o evento mesmo sem conhecer o tipo");
	assert.doesNotThrow(() => dispatchComputerUseEvent(unknown.event as ComputerUseEvent, handlers));
	assert.deepEqual(calls, []);
	dispatchComputerUseEvent({ type: "assistant_delta", id: "a", delta: "x" }, handlers);
	assert.deepEqual(calls, ["onDelta"]);
});

test("bloco com JSON inválido ou sem data não gera evento", () => {
	assert.equal(parseSseBlock("id: 4\ndata: {quebrado").event, undefined);
	assert.equal(parseSseBlock(": ping").event, undefined);
});

test("nenhum tipo da lista, fora os terminais, dispara handler terminal", () => {
	for (const type of RUN_EVENT_TYPES) {
		if (type === "done" || type === "paused" || type === "cancelled" || type === "error") continue;
		const { calls, handlers } = spy();
		const event = (type === "status" ? { type, status: "running" } : { type }) as ComputerUseEvent;
		assert.doesNotThrow(() => dispatchComputerUseEvent(event, handlers), type);
		assert.deepEqual(calls.filter((name) => name.startsWith("terminal:")), [], type);
	}
});

test("os terminais da lista encerram: 4 por tipo + status budget_exhausted", () => {
	const events: Record<string, ComputerUseEvent> = {
		done: { type: "done", message: { role: "assistant", content: "" }, model: "m" },
		paused: { type: "paused" },
		cancelled: { type: "cancelled" },
		error: { type: "error", error: "x" },
		"status:budget_exhausted": { type: "status", status: "budget_exhausted" },
	};
	assert.deepEqual(Object.keys(events).sort(), [...RUN_TERMINAL_EVENTS].sort());
	for (const key of RUN_TERMINAL_EVENTS) {
		const { calls, handlers } = spy();
		dispatchComputerUseEvent(events[key]!, handlers);
		assert.equal(calls.filter((name) => name.startsWith("terminal:")).length, 1, key);
		assert.equal(runTerminalKey(events[key]!), key);
	}
	assert.equal(runTerminalKey({ type: "status", status: "running" }), null);
});

test("isRunTerminalEvent (predicado do laço de SSE): 5 terminais encerram, o resto e tipo desconhecido não", () => {
	assert.equal(isRunTerminalEvent({ type: "done", message: { role: "assistant", content: "" }, model: "m" }), true);
	assert.equal(isRunTerminalEvent({ type: "paused" }), true);
	assert.equal(isRunTerminalEvent({ type: "cancelled" }), true);
	assert.equal(isRunTerminalEvent({ type: "error", error: "x" }), true);
	assert.equal(isRunTerminalEvent({ type: "status", status: "budget_exhausted" }), true);
	assert.equal(isRunTerminalEvent({ type: "status", status: "running" }), false);
	for (const type of RUN_EVENT_TYPES) {
		if (type === "done" || type === "paused" || type === "cancelled" || type === "error") continue;
		const event = (type === "status" ? { type, status: "running" } : { type }) as ComputerUseEvent;
		assert.equal(isRunTerminalEvent(event), false, type);
	}
	assert.equal(isRunTerminalEvent({ type: "tipo_do_futuro" } as unknown as ComputerUseEvent), false);
});
