import { describe, expect, it } from "vitest";
import { argsProblem, valueAt } from "./predicates.js";
import { chartBlocks, countQuestions, detectLanguage, endsWithQuestion, findInternals, isUnfulfilledPromise, stripFences } from "./text.js";

describe("heurísticas de texto", () => {
	it("pergunta no fim (ignora bloco cercado e pontuação de fecho)", () => {
		expect(endsWithQuestion("Pronto.\nQuer que eu envie?")).toBe(true);
		expect(endsWithQuestion("Quer que eu envie? **")).toBe(true);
		expect(endsWithQuestion("Você pediu isso? Fiz assim.")).toBe(false);
		expect(endsWithQuestion("Feito.\n```js\nconst a = b ? 1 : 2?\n```")).toBe(false);
		expect(endsWithQuestion("")).toBe(false);
		expect(countQuestions("A? B? ```x?```")).toBe(2);
	});

	it("idioma pelas palavras funcionais; texto curto fica indefinido", () => {
		expect(detectLanguage("Good morning! Here are three tips for your week and the plan.")).toBe("en-US");
		expect(detectLanguage("Bom dia! Você pode organizar a semana com uma lista de tarefas que não acaba.")).toBe("pt-BR");
		expect(detectLanguage("Hola, el plan de la semana es simple y está listo para usted.")).toBe("es-ES");
		expect(detectLanguage("Ok!")).toBeNull();
	});

	it("promessa sem entrega no começo ou no fim", () => {
		expect(isUnfulfilledPromise("Vou gerar o PDF agora.")).toBe(true);
		expect(isUnfulfilledPromise("Entendi o pedido. Vou gerar o arquivo agora.")).toBe(true);
		expect(isUnfulfilledPromise("Let me prepare that for you.")).toBe(true);
		expect(isUnfulfilledPromise("Pronto: o PDF está no card acima.")).toBe(false);
		expect(isUnfulfilledPromise("")).toBe(false);
	});

	it("internals: nome de tool com _, termos extras como palavra inteira, revisão e frase de runtime", () => {
		const tools = ["propose_routine", "memory", "mcp__loja__delete_orders"];
		expect(findInternals("Usei propose_routine para criar.", tools)).toEqual(["propose_routine"]);
		expect(findInternals("Salvei na memory.", tools)).toEqual([]);
		expect(findInternals("Paleta Oceano aplicada.", tools, ["ocean"])).toEqual([]);
		expect(findInternals("Paleta ocean aplicada.", tools, ["ocean"])).toEqual(["ocean"]);
		expect(findInternals("Atualizei para a revisão 3.", tools)).toEqual(["revisão 3"]);
		expect(findInternals("A ferramenta recusou o pedido.", tools)).toEqual(["A ferramenta recusou"]);
		expect(findInternals("```chart\n{\"orientation\":\"horizontal\"}\n```\nPronto.", tools, ["orientation"])).toEqual([]);
	});

	it("blocos de gráfico e remoção de cercas", () => {
		const text = "Veja:\n```chart\n{\"type\":\"bar\"}\n```\ne\n```chart\n{\"type\":\"pie\"}\n```";
		expect(chartBlocks(text)).toEqual(['{"type":"bar"}', '{"type":"pie"}']);
		expect(stripFences(text)).not.toContain("bar");
	});
});

describe("predicados de argumento", () => {
	it("caminho com pontos e índices", () => {
		expect(valueAt({ items: [{ sku: "A" }] }, "items.0.sku")).toBe("A");
		expect(valueAt({ a: 1 }, "a.b")).toBeUndefined();
	});
	it("equals, oneOf, contains, matches e exists", () => {
		const args = { trigger_type: "once", title: "Ligar pro Fornecedor", ids: ["1", "2"] };
		expect(argsProblem(args, { trigger_type: { equals: "once" } })).toBeNull();
		expect(argsProblem(args, { trigger_type: { equals: "cron" } })).toMatch(/esperado "cron"/);
		expect(argsProblem(args, { trigger_type: { oneOf: ["once", "interval"] } })).toBeNull();
		expect(argsProblem(args, { title: { contains: "fornecedor" } })).toBeNull();
		expect(argsProblem(args, { title: { matches: "^ligar" } })).toBeNull();
		expect(argsProblem(args, { ids: { contains: "2" } })).toBeNull();
		expect(argsProblem(args, { run_at: { exists: true } })).toMatch(/ausente/);
		expect(argsProblem(args, { run_at: { exists: false } })).toBeNull();
		expect(argsProblem(args, undefined)).toBeNull();
	});
});
