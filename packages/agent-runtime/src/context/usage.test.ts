import { describe, expect, it } from "vitest";
import type { ContextUsageEvent } from "@workspace/shared";
import { createContextUsageReporter } from "./usage.js";

const sample = (usedTokens: number, extra: Partial<Parameters<ReturnType<typeof createContextUsageReporter>>[0]> = {}) => ({
	usedTokens,
	windowTokens: 100_000,
	compactAtTokens: 80_000,
	sessionId: "s1",
	...extra,
});

describe("medidor de contexto (context_usage)", () => {
	it("emite na primeira medição com sessão, uso, janela e ponto de resumo", async () => {
		const events: ContextUsageEvent[] = [];
		const report = createContextUsageReporter((event) => void events.push(event));
		expect(await report(sample(42_000))).toBe(true);
		expect(events).toEqual([{ type: "context_usage", sessionId: "s1", usedTokens: 42_000, windowTokens: 100_000, compactAtTokens: 80_000 }]);
	});

	it("troca de modelo emite de novo, mesmo com uso parecido", async () => {
		const events: ContextUsageEvent[] = [];
		const report = createContextUsageReporter((event) => void events.push(event));
		await report(sample(42_000, { model: "normal/m" }));
		expect(await report(sample(42_100, { model: "normal/m" }))).toBe(false);
		expect(await report(sample(42_100, { model: "coding/m" }))).toBe(true);
		expect(events.map((event) => event.model)).toEqual(["normal/m", "coding/m"]);
	});

	it("só emite quando o uso muda pelo menos 1% da janela", async () => {
		const events: ContextUsageEvent[] = [];
		const report = createContextUsageReporter((event) => void events.push(event));
		await report(sample(42_000));
		expect(await report(sample(42_400))).toBe(false);
		expect(await report(sample(42_999))).toBe(false);
		expect(await report(sample(43_000))).toBe(true);
		expect(events.map((event) => event.usedTokens)).toEqual([42_000, 43_000]);
	});

	it("o recuo depois de um resumo também é emitido, e janela nova reinicia a conta", async () => {
		const events: ContextUsageEvent[] = [];
		const report = createContextUsageReporter((event) => void events.push(event));
		await report(sample(79_000));
		expect(await report(sample(30_000))).toBe(true);
		expect(await report(sample(30_100, { windowTokens: 200_000 }))).toBe(true);
		expect(events.at(-1)?.windowTokens).toBe(200_000);
	});

	it("ignora janela inválida e limita o ponto de resumo à janela", async () => {
		const events: ContextUsageEvent[] = [];
		const report = createContextUsageReporter((event) => void events.push(event));
		expect(await report(sample(10, { windowTokens: 0 }))).toBe(false);
		await report(sample(10, { compactAtTokens: 500_000 }));
		expect(events[0]?.compactAtTokens).toBe(100_000);
		expect(Object.keys(events[0]!)).toContain("sessionId");
		await report(sample(90_000, { sessionId: undefined }));
		expect("sessionId" in events[1]!).toBe(false);
	});
});
