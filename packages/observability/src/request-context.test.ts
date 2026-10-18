import { describe, expect, it, vi } from "vitest";
import {
	currentRequestId,
	installRequestIdLogging,
	requestIdForJob,
	resetRequestIdLoggingForTests,
	runWithRequestId,
	sanitizeRequestId,
} from "./request-context.js";

describe("request-id", () => {
	it("aceita ids inofensivos e recusa o resto", () => {
		expect(sanitizeRequestId("abc-12345")).toBe("abc-12345");
		expect(sanitizeRequestId("curto")).toBeNull();
		expect(sanitizeRequestId("a".repeat(65))).toBeNull();
		expect(sanitizeRequestId("bad id\nforged line")).toBeNull();
		expect(sanitizeRequestId(null)).toBeNull();
	});

	it("propaga pelo fluxo assíncrono e some fora dele", async () => {
		expect(currentRequestId()).toBeUndefined();
		await runWithRequestId("req-0000001", async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(currentRequestId()).toBe("req-0000001");
		});
		expect(currentRequestId()).toBeUndefined();
	});

	it("worker: usa o requestId do job ou deriva do id", () => {
		expect(requestIdForJob({ id: "9", data: { requestId: "req-abcdef12" } })).toBe("req-abcdef12");
		expect(requestIdForJob({ id: "9", data: {} })).toBe("job-9");
		expect(requestIdForJob({ id: "9", data: { requestId: "x\ny" } })).toBe("job-9");
	});

	it("prefixa os logs só dentro do contexto", () => {
		resetRequestIdLoggingForTests();
		const lines: string[] = [];
		const fake = {
			log: (...args: unknown[]) => lines.push(args.join(" ")),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as Console;
		installRequestIdLogging(fake);
		fake.log("fora");
		runWithRequestId("req-0000002", () => fake.log("dentro %s", "ok"));
		expect(lines).toEqual(["fora", "[rid=req-0000002] dentro %s ok"]);
		resetRequestIdLoggingForTests();
	});
});
