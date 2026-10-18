import { describe, expect, it } from "vitest";
import {
	buildSummaryPrompt,
	emptySummaryFacts,
	parseSummaryResponse,
} from "./summary.js";

describe("buildSummaryPrompt", () => {
	it("inclui o transcript e a instrução de JSON", () => {
		const prompt = buildSummaryPrompt(["USUÁRIO: oi", "ASSISTENTE: olá"]);
		expect(prompt).toContain("USUÁRIO: oi");
		expect(prompt).toContain("ASSISTENTE: olá");
		expect(prompt).toContain("constraints");
		expect(prompt).toContain("nunca as omita");
	});

	it("sem anterior não menciona versão prévia (assinatura compatível)", () => {
		const prompt = buildSummaryPrompt(["USUÁRIO: oi"]);
		expect(prompt).not.toContain("Resumo anterior");
	});

	it("v2 inclui o anterior + fatos e pede mesclagem preservando decisões", () => {
		const prompt = buildSummaryPrompt(["USUÁRIO: e o deploy?"], {
			content: "Objetivo: migrar a fila para Postgres.",
			factsJson: {
				decisions: ["usar Postgres"],
				pendings: [],
				prefs: [],
				constraints: ["nunca apagar transcript"],
			},
			version: 1,
		});
		expect(prompt).toContain("Resumo anterior (v1):");
		expect(prompt).toContain("Objetivo: migrar a fila para Postgres.");
		expect(prompt).toContain("usar Postgres");
		expect(prompt).toContain("nunca apagar transcript");
		expect(prompt).toContain("mescle o anterior com mensagens novas");
		expect(prompt).toContain("preservando decisões/constraints");
		expect(prompt).toContain("USUÁRIO: e o deploy?");
	});
});

describe("parseSummaryResponse", () => {
	it("extrai prosa e fatos do bloco json", () => {
		const text = [
			"Objetivo: migrar a fila. Decidido usar Postgres.",
			"```json",
			JSON.stringify({
				decisions: ["usar Postgres"],
				pendings: ["migrar rota X"],
				prefs: ["respostas curtas"],
				constraints: ["nunca apagar transcript"],
				extra: "ignorado",
			}),
			"```",
		].join("\n");
		const { content, facts } = parseSummaryResponse(text);
		expect(content).toContain("Objetivo: migrar a fila.");
		expect(content).not.toContain("```json");
		expect(facts.decisions).toEqual(["usar Postgres"]);
		expect(facts.pendings).toEqual(["migrar rota X"]);
		expect(facts.constraints).toEqual(["nunca apagar transcript"]);
	});

	it("sem bloco json usa o texto integral com fatos vazios", () => {
		const { content, facts } = parseSummaryResponse("só prosa aqui");
		expect(content).toBe("só prosa aqui");
		expect(facts).toEqual(emptySummaryFacts());
	});

	it("limita tamanhos", () => {
		const big = "x".repeat(5000);
		const { content, facts } = parseSummaryResponse(
			`${big}\n\`\`\`json\n${JSON.stringify({ decisions: ["y".repeat(500)] })}\n\`\`\``,
		);
		expect(content.length).toBeLessThanOrEqual(2000);
		expect(facts.decisions[0]?.length).toBeLessThanOrEqual(200);
	});
});
