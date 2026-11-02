import type { QuestionnaireCardItem } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { buildAnswers, missingRequired, toggleChoice } from "./questionnaire";

const items: QuestionnaireCardItem[] = [
	{ name: "direction", prompt: "Direção?", required: true, choices: [{ value: "a" }, { value: "b" }] },
	{ name: "tags", prompt: "Tags?", multiple: true, choices: [{ value: "x" }, { value: "y" }] },
	{ name: "briefing", prompt: "Conte mais", input: { label: "Texto" } },
];

describe("questionário", () => {
	it("um valor vira texto, mais de um vira lista, vazio some", () => {
		expect(buildAnswers(items, { direction: ["a"], tags: ["x", "y"] }, { briefing: "  agendar reuniões " })).toEqual({ direction: "a", tags: ["x", "y"], briefing: "agendar reuniões" });
		expect(buildAnswers(items, {}, { briefing: "   " })).toEqual({});
	});
	it("escolha e texto livre do mesmo item juntam numa lista", () => {
		expect(buildAnswers([{ name: "n", prompt: "?", choices: [{ value: "a" }], input: { label: "outro" } }], { n: ["a"] }, { n: "outra coisa" })).toEqual({ n: ["a", "outra coisa"] });
	});
	it("só o obrigatório sem resposta bloqueia", () => {
		expect(missingRequired(items, {})).toEqual(["direction"]);
		expect(missingRequired(items, { direction: "a" })).toEqual([]);
	});
	it("escolha única troca e desmarca; várias liga e desliga", () => {
		expect(toggleChoice([], "a", false)).toEqual(["a"]);
		expect(toggleChoice(["a"], "b", false)).toEqual(["b"]);
		expect(toggleChoice(["a"], "a", false)).toEqual([]);
		expect(toggleChoice(["x"], "y", true)).toEqual(["x", "y"]);
		expect(toggleChoice(["x", "y"], "x", true)).toEqual(["y"]);
	});
});
