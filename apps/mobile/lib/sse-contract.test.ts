// Contrato SSE de run (harness v3, PR3b), lado mobile. Espelho de `apps/web/lib/sse-contract.test.ts`.
import { parseSseBlock, RUN_EVENT_TYPES, RUN_TERMINAL_EVENTS, runTerminalKey, type ComputerUseEvent } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { applyRunEvent, createLiveState, isRunBoundary, startLiveRun } from "./chat-live";

const start = () => startLiveRun(createLiveState(), "r1");
const run = (events: ComputerUseEvent[], state = start()) => events.reduce(applyRunEvent, state);

const sequence: ComputerUseEvent[] = [
	{ type: "run", runId: "r1", status: "running" },
	{ type: "assistant_delta", id: "a1", delta: "Olá" },
	{ type: "tool_intent", name: "run_code" },
	{ type: "tool_call", id: "t1", name: "run_code", args: "{}", step: 1, maxSteps: 8 },
	{ type: "tool_result", id: "t1", name: "run_code", ok: true, summary: "ok" },
	{ type: "task_list", items: [{ content: "Passo", status: "in_progress" }], runId: "r1" },
	{ type: "file", artifactId: "f1", filename: "a.pdf", mime: "application/pdf", size: 1, format: "pdf", version: 1, runId: "r1" },
];
const done: ComputerUseEvent = { type: "done", message: { role: "assistant", content: "pronto" }, model: "m" };

describe("contrato SSE no mobile", () => {
	it("sequência pelo parseSseBlock: só o terminal encerra o run", () => {
		const events = [...sequence, done].map((event, index) => parseSseBlock(`id: ${index + 1}\ndata: ${JSON.stringify(event)}`).event);
		expect(events.every(Boolean)).toBe(true);
		const parsed = events as ComputerUseEvent[];
		const before = run(parsed.slice(0, -1));
		expect(before.ended).toBe(false);
		expect(parsed.slice(0, -1).some(isRunBoundary)).toBe(false);
		const after = run(parsed.slice(-1), before);
		expect(after).toMatchObject({ ended: true, finishes: 1 });
		expect(isRunBoundary(parsed.at(-1)!)).toBe(true);
	});

	it("tipo desconhecido não muda o estado nem encerra", () => {
		const state = run(sequence);
		const unknown = { type: "tipo_do_futuro", payload: { x: 1 } } as unknown as ComputerUseEvent;
		expect(applyRunEvent(state, unknown)).toBe(state);
		expect(isRunBoundary(unknown)).toBe(false);
	});

	it("isRunBoundary coincide com a lista de terminais, tipo a tipo", () => {
		for (const type of RUN_EVENT_TYPES) {
			const event = (type === "status" ? { type, status: "running" } : { type }) as ComputerUseEvent;
			const terminal = type === "done" || type === "paused" || type === "cancelled" || type === "error";
			expect(isRunBoundary(event), type).toBe(terminal);
			expect(runTerminalKey(event) !== null, type).toBe(terminal);
		}
		expect(isRunBoundary({ type: "status", status: "budget_exhausted" })).toBe(true);
		expect(RUN_TERMINAL_EVENTS).toHaveLength(5);
	});

	it("cada terminal marca o run como encerrado ou parado", () => {
		expect(run([{ type: "paused" }]).paused).toBe(true);
		expect(run([{ type: "cancelled" }]).ended).toBe(true);
		expect(run([{ type: "error", error: "x" }]).ended).toBe(true);
		expect(run([{ type: "status", status: "budget_exhausted" }]).ended).toBe(true);
		expect(run([{ type: "status", status: "running" }]).ended).toBe(false);
	});
});
