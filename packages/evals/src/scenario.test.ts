import { describe, expect, it } from "vitest";
import { expectationName, parseScenario, selectScenarios, type Scenario } from "./scenario.js";

const minimal = { version: 1, id: "exemplo", title: "Exemplo", bot: { name: "Ada" }, user: "oi", expect: [{ type: "completed" }] };

describe("schema do cenário", () => {
	it("aceita o mínimo e preenche os padrões", () => {
		const parsed = parseScenario(minimal);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.scenario.bot.language).toBe("pt-BR");
		expect(parsed.scenario.run).toEqual({ maxSteps: 8, origin: "chat", briefReadOnly: false });
		expect(parsed.scenario.tools).toEqual({ fixtures: [], connectors: [], allowReal: [] });
		expect(parsed.scenario.source.kind).toBe("seed");
	});

	it("campo desconhecido é erro (na raiz e dentro de uma expectativa)", () => {
		const root = parseScenario({ ...minimal, expected: [] });
		expect(root.ok).toBe(false);
		const nested = parseScenario({ ...minimal, expect: [{ type: "no_question", strict: true }] });
		expect(nested.ok).toBe(false);
		if (!nested.ok) expect(nested.error).toMatch(/expect\.0/);
	});

	it("versão diferente, id fora do padrão e tipo de verificação inexistente falham", () => {
		expect(parseScenario({ ...minimal, version: 2 }).ok).toBe(false);
		expect(parseScenario({ ...minimal, id: "Com Espaço" }).ok).toBe(false);
		expect(parseScenario({ ...minimal, expect: [{ type: "vibes" }] }).ok).toBe(false);
	});

	it("tool_called sem tool nem toolPattern e text_contains sem valor falham com motivo", () => {
		const tool = parseScenario({ ...minimal, expect: [{ type: "tool_called" }] });
		expect(tool).toMatchObject({ ok: false, error: expect.stringContaining("tool ou toolPattern") });
		const text = parseScenario({ ...minimal, expect: [{ type: "text_contains" }] });
		expect(text).toMatchObject({ ok: false, error: expect.stringContaining("value ou pattern") });
	});

	it("nomes de verificação repetidos pedem um id", () => {
		const parsed = parseScenario({ ...minimal, expect: [{ type: "text_contains", value: "a" }, { type: "text_contains", value: "b" }] });
		expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining("nome repetido") });
		expect(parseScenario({ ...minimal, expect: [{ type: "text_contains", value: "a" }, { id: "b", type: "text_contains", value: "b" }] }).ok).toBe(true);
	});

	it("histórico aceita chamadas e resultados de tool", () => {
		const parsed = parseScenario({
			...minimal,
			history: [
				{ role: "user", content: "lista" },
				{ role: "assistant", toolCalls: [{ id: "c1", name: "list_routines" }] },
				{ role: "tool", toolCallId: "c1", content: "nenhuma" },
				{ role: "assistant", content: "Você não tem rotinas." },
			],
		});
		expect(parsed.ok).toBe(true);
	});

	it("nome da verificação: id > tipo:tool > tipo", () => {
		expect(expectationName({ type: "tool_called", tool: "x" })).toBe("tool_called:x");
		expect(expectationName({ type: "tool_not_called", toolPattern: "delete" })).toBe("tool_not_called:delete");
		expect(expectationName({ id: "meu", type: "no_question" })).toBe("meu");
		expect(expectationName({ type: "language", value: "en-US" })).toBe("language:en-US");
	});
});

describe("seleção de cenários", () => {
	const scenarios = [
		{ id: "a", tags: ["x"] },
		{ id: "b", tags: ["y"] },
	] as unknown as Scenario[];
	it("all, ids e tags", () => {
		expect(selectScenarios(scenarios, "all")).toHaveLength(2);
		expect(selectScenarios(scenarios, "b").map((item) => item.id)).toEqual(["b"]);
		expect(selectScenarios(scenarios, "x").map((item) => item.id)).toEqual(["a"]);
	});
	it("id desconhecido é erro (não roda uma bateria vazia em silêncio)", () => {
		expect(() => selectScenarios(scenarios, "z")).toThrow(/desconhecido: z/);
	});
});
