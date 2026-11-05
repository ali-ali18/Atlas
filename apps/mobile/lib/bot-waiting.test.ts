import { describe, expect, it } from "vitest";
import { applyRunEvent, botRunStore, EMPTY_RUN_SETS } from "./bot-waiting";
import type { HubEvent } from "./event-hub";

const run = (botId: string | null, status: string, seq = 1): HubEvent => ({ seq, type: "run", payload: { runId: "r1", status, ...(botId ? { botId } : {}) } });

describe("applyRunEvent", () => {
	it("run ativo marca o bot como trabalhando; terminal limpa", () => {
		const on = applyRunEvent(EMPTY_RUN_SETS, run("b1", "running"));
		expect([...on.active]).toEqual(["b1"]);
		const off = applyRunEvent(on, run("b1", "completed"));
		expect(off.active.size).toBe(0);
		expect(off.waiting.size).toBe(0);
	});
	it("waiting_user vira 'precisa de você' e tira de trabalhando", () => {
		const on = applyRunEvent(EMPTY_RUN_SETS, run("b1", "running"));
		const waiting = applyRunEvent(on, run("b1", "waiting_user"));
		expect([...waiting.waiting]).toEqual(["b1"]);
		expect(waiting.active.size).toBe(0);
		const resumed = applyRunEvent(waiting, run("b1", "running"));
		expect([...resumed.active]).toEqual(["b1"]);
		expect(resumed.waiting.size).toBe(0);
	});
	it("evento sem bot, de outro tipo ou sem mudança devolve o mesmo objeto", () => {
		expect(applyRunEvent(EMPTY_RUN_SETS, run(null, "running"))).toBe(EMPTY_RUN_SETS);
		expect(applyRunEvent(EMPTY_RUN_SETS, { seq: 2, type: "message", payload: { botId: "b1" } })).toBe(EMPTY_RUN_SETS);
		expect(applyRunEvent(EMPTY_RUN_SETS, run("b1", "completed"))).toBe(EMPTY_RUN_SETS);
		const on = applyRunEvent(EMPTY_RUN_SETS, run("b1", "running"));
		expect(applyRunEvent(on, run("b1", "queued"))).toBe(on);
	});
});

describe("botRunStore", () => {
	it("avisa os assinantes só quando muda e limpa no reset", () => {
		let calls = 0;
		const off = botRunStore.subscribe(() => calls++);
		botRunStore.apply(run("b2", "running"));
		botRunStore.apply(run("b2", "running"));
		expect(calls).toBe(1);
		expect(botRunStore.get().active.has("b2")).toBe(true);
		botRunStore.reset();
		expect(calls).toBe(2);
		expect(botRunStore.get().active.size).toBe(0);
		off();
	});
});
