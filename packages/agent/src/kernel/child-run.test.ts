import { describe, expect, it } from "vitest";
import type { SpendHook } from "./types.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { z } from "zod";
import { defineTool } from "../tools/define-tool.js";

// Opções do kernel que o run filho (ajudante) usa: papel do modelo, sem ask_owner, gasto de fora no teto, proveniência exposta.
const lookup = defineTool({ name: "lookup", description: "Look up.", inputSchema: z.object({ q: z.string() }), effect: "read", execute: ({ q }) => ({ ok: true, summary: `result ${q}` }) });

describe("kernel: opções do run filho", () => {
	it("role troca o papel do modelo no laço e na janela de contexto", async () => {
		const h = kernelHarness([reply({ text: "ok" })]);
		await h.run({ role: "helper" });
		expect(h.llm.requests.map((r) => r.role)).toEqual(["helper"]);
	});

	it("askOwner: false tira a tool ask_owner", async () => {
		const withTool = kernelHarness([reply({ text: "ok" })]);
		await withTool.run();
		expect(withTool.llm.requests[0]?.tools?.map((t) => t.name)).toContain("ask_owner");
		const without = kernelHarness([reply({ text: "ok" })]);
		await without.run({ askOwner: false });
		expect(without.llm.requests[0]?.tools?.map((t) => t.name)).not.toContain("ask_owner");
	});

	it("gasto de fora conta no teto do dono e entra no resultado da mãe; o gasto próprio é publicado", async () => {
		let outside = 0;
		const reported: number[] = [];
		const spend: SpendHook = { outsideUsd: () => outside, report: (usd) => reported.push(usd) };
		const h = kernelHarness(
			[
				reply({ calls: [call("c1", "lookup", { q: "a" })], usage: { costUsd: 0.01 } }),
				() => {
					outside = 0.05; // os ajudantes gastaram durante o passo
					return reply({ calls: [call("c2", "lookup", { q: "b" })], usage: { costUsd: 0.01 } });
				},
				reply({ text: "final answer" }),
			],
			{ tools: [lookup] },
		);
		const result = await h.run({ spend, limits: { ownerMaxUsd: 0.06 } });
		expect(reported[0]).toBe(0); // início
		expect(reported.at(-1)).toBeCloseTo(0.03, 5);
		expect(result.stop?.kind).toBe("cost");
		expect(result.spentUsd).toBeCloseTo(0.08, 5); // 0.03 próprio + 0.05 dos ajudantes
		expect(h.log.of("final")[0]?.spentUsd).toBeCloseTo(0.08, 5);
		const cp = h.runs.checkpoints.get("owner-1:run-1")?.payload as { outsideUsd?: number; spentUsd: number };
		expect(cp.outsideUsd).toBeCloseTo(0.05, 5);
		expect(cp.spentUsd).toBeCloseTo(0.03, 5);
	});

	it("countInResult: false (filho) não soma o gasto de fora no resultado nem no checkpoint, mas o teto continua valendo", async () => {
		const spend: SpendHook = { outsideUsd: () => 0.05, report: () => undefined, countInResult: false };
		const h = kernelHarness([reply({ calls: [call("c1", "lookup", { q: "a" })], usage: { costUsd: 0.01 } }), reply({ text: "final" })], { tools: [lookup] });
		const result = await h.run({ spend, limits: { ownerMaxUsd: 0.06 } });
		expect(result.stop?.kind).toBe("cost"); // 0.01 + 0.05 >= 0.06 depois do primeiro passo
		expect(result.spentUsd).toBeCloseTo(0.02, 5); // 1 passo + o passo final
		expect((h.runs.checkpoints.get("owner-1:run-1")?.payload as { outsideUsd?: number }).outsideUsd).toBeUndefined();
	});

	it("exposeProvenance dá a leitura ao vivo dos sinais (sem os textos)", async () => {
		const web = defineTool({ name: "web_read", description: "Read.", inputSchema: z.object({}), effect: "read", trust: "untrusted", source: "web", execute: () => ({ ok: true, summary: "page text" }) });
		let read: (() => unknown) | undefined;
		const h = kernelHarness([reply({ calls: [call("c1", "web_read", {})] }), reply({ text: "done" })], { tools: [web] });
		await h.run({ exposeProvenance: (fn) => (read = fn) });
		expect(read?.()).toEqual({ untrustedReadInRun: true, privateReadInRun: false, sources: ["web"] });
	});
});
