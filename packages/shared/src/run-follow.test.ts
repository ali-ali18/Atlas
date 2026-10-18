import { describe, expect, it } from "vitest";
import {
	decideRunFollow,
	decideStreamFailure,
	runFollowBackoffMs,
} from "./run-follow.js";

describe("runFollowBackoffMs", () => {
	it("dobra de 2s até o teto de 30s", () => {
		expect([1, 2, 3, 4, 5, 6, 20].map(runFollowBackoffMs)).toEqual([
			2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
		]);
	});
	it("trata falhas <= 0 como a primeira", () => {
		expect(runFollowBackoffMs(0)).toBe(2_000);
	});
});

describe("decideRunFollow", () => {
	it("run vivo segue; paused espera o usuário; terminal e vazio param", () => {
		for (const s of ["queued", "running", "retrying", "waiting_user", "waiting_external"]) {
			expect(decideRunFollow(s)).toBe("follow");
		}
		expect(decideRunFollow("paused")).toBe("wait_user");
		for (const s of ["completed", "failed", "cancelled", "budget_exhausted", null, undefined]) {
			expect(decideRunFollow(s)).toBe("stop");
		}
	});
});

describe("decideStreamFailure", () => {
	it("queda com run rodando reconecta com backoff", () => {
		expect(decideStreamFailure({ runStatus: "running", aborted: false, failures: 1 }))
			.toEqual({ action: "retry", delayMs: 2_000 });
		expect(decideStreamFailure({ runStatus: "running", aborted: false, failures: 3 }))
			.toEqual({ action: "retry", delayMs: 8_000 });
	});
	it("429 faz backoff crescente e nunca passa de 30s", () => {
		const d = decideStreamFailure({ runStatus: "running", aborted: false, httpStatus: 429, failures: 9 });
		expect(d).toEqual({ action: "retry", delayMs: 30_000 });
	});
	it("429 sem status conhecido do run também faz backoff", () => {
		expect(decideStreamFailure({ runStatus: null, aborted: false, httpStatus: 429, failures: 2 }))
			.toEqual({ action: "retry", delayMs: 4_000 });
	});
	it("paused para de reconectar", () => {
		expect(decideStreamFailure({ runStatus: "paused", aborted: false, httpStatus: 429, failures: 5 }))
			.toEqual({ action: "wait_user" });
	});
	it("terminal, abort e 404 param", () => {
		expect(decideStreamFailure({ runStatus: "completed", aborted: false, failures: 1 })).toEqual({ action: "stop" });
		expect(decideStreamFailure({ runStatus: "running", aborted: true, failures: 1 })).toEqual({ action: "stop" });
		expect(decideStreamFailure({ runStatus: "running", aborted: false, httpStatus: 404, failures: 1 })).toEqual({ action: "stop" });
	});
});
