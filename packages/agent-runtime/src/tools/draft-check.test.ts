import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import {
	collectEvidence,
	createDeliverableVerifier,
	draftLines,
	extractFigures,
	findUnsupportedFigures,
	parseUnconfirmed,
	normalizeFigure,
} from "./draft-check.js";

describe("draft-check: números do rascunho contra as fontes", () => {
	it("normaliza formatos diferentes para a mesma chave", () => {
		expect(normalizeFigure("1.299,00")).toBe("1299");
		expect(normalizeFigure("1,299.00")).toBe("1299");
		expect(normalizeFigure("1299")).toBe("1299");
		expect(normalizeFigure("3,50")).toBe("3.5");
		expect(normalizeFigure("3.5")).toBe("3.5");
		expect(normalizeFigure("1.200")).toBe("1200");
	});

	it("ignora anos, numeração, datas e URLs; confere moeda, % e números de 3+ dígitos", () => {
		const keys = extractFigures([
			"1. Introdução, 2024, 3 itens",
			"Publicado em 2025-03-04 e 03/10/2026, veja https://x.test/p/987654",
			"Preço R$ 49 por mês, desconto de 15%, 120 usuários, nota 4,5",
		]).map((figure) => figure.key);
		expect(keys).toEqual(["49", "15", "120", "4.5"]);
	});

	it("número presente na evidência em outro formato não é sinalizado", () => {
		const out = findUnsupportedFigures(["Preço: R$ 1.299,00 por ano"], "the page lists $1,299 per year");
		expect(out).toEqual([]);
	});

	it("número sem fonte é sinalizado uma vez, com a linha", () => {
		const out = findUnsupportedFigures(["Cotação do dólar: R$ 5,87", "Repetindo: 5,87"], "Plan costs $20 per month");
		expect(out).toHaveLength(1);
		expect(out[0]?.line).toContain("Cotação do dólar");
	});

	it("número declarado em unconfirmed passa em qualquer idioma; sem declarar, é sinalizado", () => {
		const lines = ["Kurs: 5,87 (nicht bestätigt)", "為替レート 5.87（未確認）"];
		for (const line of lines) {
			expect(findUnsupportedFigures([line], "nothing relevant")).toHaveLength(1);
			expect(findUnsupportedFigures([line], "nothing relevant", ["5,87"])).toEqual([]);
		}
	});

	it("unconfirmed declara só os números listados", () => {
		const out = findUnsupportedFigures(["a 5,87", "b 9,99"], "nothing relevant", ["5.87"]);
		expect(out.map((item) => item.raw)).toEqual(["9,99"]);
	});

	it("parseUnconfirmed valida tipo, tamanho e quantidade", () => {
		expect(parseUnconfirmed(undefined)).toEqual([]);
		expect(parseUnconfirmed([" 5,87 "])).toEqual(["5,87"]);
		expect(() => parseUnconfirmed("5,87")).toThrow(/unconfirmed/);
		expect(() => parseUnconfirmed([5])).toThrow(/unconfirmed\[0\]/);
		expect(() => parseUnconfirmed([""])).toThrow(/unconfirmed\[0\]/);
		expect(() => parseUnconfirmed(["x".repeat(51)])).toThrow(/50/);
		expect(() => parseUnconfirmed(Array.from({ length: 31 }, () => "1"))).toThrow(/30/);
	});

	it("evidência não inclui o resultado do próprio create_file (o erro cita o número)", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "pesquise" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_file", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "File not created: \"5.87\" in: rate 5.87" },
			{ role: "tool", tool_call_id: "c2", content: "page says 20 dollars" },
		];
		const evidence = collectEvidence(messages, [
			{ sourceRef: "https://a.test", findings: "plan 300", keyFacts: ["seats 25"], links: [], confidence: "high", step: 1 },
		]);
		expect(evidence).not.toContain("5.87");
		expect(evidence).toContain("20 dollars");
		expect(evidence).toContain("seats 25");
	});

	it("draftLines junta content, planilha e slides", () => {
		const lines = draftLines({
			title: "T",
			content: "a\nb",
			sheets: [{ rows: [["x", 10], ["y", 20]] }],
			slides: [{ title: "S", bullets: ["b1"] }],
		});
		expect(lines).toEqual(["T", "a", "b", "x | 10", "y | 20", "S", "b1"]);
	});
});

describe("draft-check: porteiro do create_file", () => {
	const make = (research = true, evidence = "Plan costs $20 per month") =>
		createDeliverableVerifier({ evidence: () => evidence, isResearch: () => research });

	it("bloqueia número sem fonte com a dica, no máximo 2 vezes; depois deixa passar", () => {
		const verifier = make();
		const args = { filename: "r.pdf", content: "Dólar a R$ 5,87" };
		expect(() => verifier.verify(args)).toThrow(/5,87/);
		expect(() => verifier.verify(args)).toThrow(/unconfirmed/);
		expect(() => verifier.verify(args)).not.toThrow();
		expect(verifier.blocks()).toBe(2);
	});

	it("passa quando tudo tem fonte ou está marcado", () => {
		const verifier = make();
		expect(() => verifier.verify({ filename: "r.pdf", content: "Plano a US$ 20 por mês" })).not.toThrow();
		expect(() => verifier.verify({ filename: "r.pdf", content: "Dólar a R$ 5,87 (não confirmado)", unconfirmed: ["R$ 5,87"] })).not.toThrow();
		expect(verifier.blocks()).toBe(0);
	});

	it("o mesmo número sem unconfirmed é bloqueado, mesmo escrito 'não confirmado'", () => {
		const verifier = make();
		expect(() => verifier.verify({ filename: "r.pdf", content: "Dólar a R$ 5,87 (não confirmado)" })).toThrow(/list it in unconfirmed/);
	});

	it("unconfirmed inválido é erro de validação, também fora de pesquisa", () => {
		expect(() => make().verify({ filename: "r.pdf", content: "x", unconfirmed: "5,87" })).toThrow(/unconfirmed must be an array/);
		expect(() => make(false).verify({ filename: "r.pdf", content: "x", unconfirmed: [1] })).toThrow(/unconfirmed\[0\]/);
	});

	it("não age fora de pesquisa nem em arquivo de código", () => {
		expect(() => make(false).verify({ filename: "r.pdf", content: "Dólar a R$ 5,87" })).not.toThrow();
		expect(() => make().verify({ filename: "calc.py", content: "RATE = 5.87" })).not.toThrow();
	});
});
