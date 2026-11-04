import { describe, expect, it } from "vitest";
import { formatReferenceReport, referenceTasks, runReferenceScenarios } from "./index.js";
import { main } from "../cli.js";

describe("cenários de referência do motor v2 (E6)", () => {
	it("traz as duas tarefas fixas", () => {
		expect(referenceTasks().map((task) => task.id)).toEqual(["referencia-youtube-gemini", "referencia-pesquisa-3-fontes"]);
	});

	it("roda no roteiro, conclui com 'answered' e relata passos e tokens de entrada por passo, de forma determinística", async () => {
		const first = await runReferenceScenarios();
		const second = await runReferenceScenarios();
		expect(first.metrics).toEqual(second.metrics);
		for (const item of first.metrics) {
			expect(item.errors, item.taskId).toEqual([]);
			expect(item.completionRate, item.taskId).toBe(1);
			expect(item.stopReasons, item.taskId).toEqual(["answered"]);
			expect(item.steps, item.taskId).toBeGreaterThan(0);
			expect(item.inputTokensPerStep).toHaveLength(item.steps);
			expect(item.avgInputTokensPerStep).toBeGreaterThan(0);
		}
		const report = formatReferenceReport(first);
		expect(report).toContain("referencia-youtube-gemini");
		expect(report).toContain("referencia-pesquisa-3-fontes");
	});

	it("o comando do CLI aceita --reference sem rede", async () => {
		await expect(main(["motor-v1-vs-v2", "--reference", "--only", "referencia-pesquisa-3-fontes"])).resolves.toBe(0);
	});
});
