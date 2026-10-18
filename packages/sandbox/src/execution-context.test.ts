import { afterEach, expect, it, vi } from "vitest";
import {
	runSandboxOperation,
	SandboxExecutionAbortedError,
} from "./execution-context.js";
import { controlNavigate } from "./control-client.js";
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
it("cancelamento observado em transporte não cooperativo, sem afirmar término externo", async () => {
	const abort = new AbortController();
	let signal: AbortSignal | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			signal = init.signal;
			return new Promise<Response>(() => undefined);
		}),
	);
	const work = controlNavigate("localhost", 1, "https://example.test", {
		signal: abort.signal,
	}).catch((e: Error) => e);
	abort.abort();
	const result = await work;
	expect(result).toBeInstanceOf(SandboxExecutionAbortedError);
	expect(result).toHaveProperty("externalOperationMayContinue", true);
	expect(signal?.aborted).toBe(true);
});
it("init/tool compartilham prazo absoluto e nunca renovam budget por chamada", async () => {
	vi.useFakeTimers();
	const context = { deadlineAtMs: Date.now() + 10 };
	const work = runSandboxOperation(
		context,
		1000,
		() => new Promise<void>(() => undefined),
	).catch((e: Error) => e);
	await vi.advanceTimersByTimeAsync(11);
	expect(await work).toHaveProperty("reason", "deadline");
	await expect(
		runSandboxOperation(context, 1000, async () => true),
	).rejects.toHaveProperty("reason", "deadline");
});

it("sem teto por categoria, operação longa obedece apenas ao prazo do run", async () => {
	vi.useFakeTimers();
	const work = runSandboxOperation(
		{ deadlineAtMs: Date.now() + 480_000 },
		undefined,
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 200_000));
			return "done";
		},
	);
	await vi.advanceTimersByTimeAsync(200_001);
	expect(await work).toBe("done");
});
