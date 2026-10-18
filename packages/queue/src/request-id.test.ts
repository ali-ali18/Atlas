import { runWithRequestId } from "@workspace/observability";
import { describe, expect, it } from "vitest";
import { propagateRequestId } from "./request-id.js";

function fakeQueue() {
	const calls: Array<{ name: string; data: unknown; opts: unknown }> = [];
	return {
		calls,
		add(name: string, data: unknown, opts?: unknown) {
			calls.push({ name, data, opts });
			return Promise.resolve();
		},
	};
}

describe("propagateRequestId", () => {
	it("injeta o request-id corrente no payload", async () => {
		const queue = propagateRequestId(fakeQueue());
		await runWithRequestId("req-00000001", () => queue.add("run-agent", { runId: "r1" }, { jobId: "j" }));
		expect(queue.calls[0]).toEqual({ name: "run-agent", data: { runId: "r1", requestId: "req-00000001" }, opts: { jobId: "j" } });
	});

	it("sem contexto, ou com requestId já no payload, não mexe", async () => {
		const queue = propagateRequestId(fakeQueue());
		await queue.add("run-agent", { runId: "r2" });
		await runWithRequestId("req-00000002", () => queue.add("run-agent", { runId: "r3", requestId: "req-original1" }));
		expect(queue.calls[0]?.data).toEqual({ runId: "r2" });
		expect(queue.calls[1]?.data).toEqual({ runId: "r3", requestId: "req-original1" });
	});
});
