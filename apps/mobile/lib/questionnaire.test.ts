import type { QuestionnaireCardItem } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { answeredQuestions, buildAnswers, choiceLetter, initialStepState, missingRequired, stepAnswered, stepFooter, stepReduce, stepSubtitle, toggleChoice, type StepAction, type StepState } from "./questionnaire";

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

describe("questionário em etapas", () => {
	const steps = [
		{ name: "a", prompt: "Qual?", required: true, choices: [{ value: "x" }, { value: "y" }] },
		{ name: "b", prompt: "Quais?", multiple: true, choices: [{ value: "1" }, { value: "2" }] },
		{ name: "c", prompt: "Mais algo?", input: { label: "Fale" } },
	];
	const run = (...actions: StepAction[]) => {
		let state: StepState = initialStepState();
		let submit: unknown = null;
		for (const action of actions) {
			const result = stepReduce(steps, state, action);
			state = result.state;
			submit = result.submit;
		}
		return { state, submit };
	};
	const pick = (name: string, value: string, multiple = false): StepAction => ({ type: "toggle", name, value, multiple });

	it("obrigatória sem resposta não avança; com resposta avança", () => {
		expect(run({ type: "next" }).state.index).toBe(0);
		expect(run(pick("a", "x"), { type: "next" }).state.index).toBe(1);
	});
	it("rodapé: Voltar só a partir da 2ª, Pular só se não é obrigatória, Enviar só na última", () => {
		expect(stepFooter(steps, initialStepState())).toEqual({ dots: 3, index: 0, back: false, skip: false, primary: "next", primaryEnabled: false });
		const second = run(pick("a", "x"), { type: "next" }).state;
		expect(stepFooter(steps, second)).toMatchObject({ back: true, skip: true, primary: "next", primaryEnabled: true });
		const last = run(pick("a", "x"), { type: "next" }, { type: "next" }).state;
		expect(stepFooter(steps, last)).toMatchObject({ index: 2, primary: "send", primaryEnabled: true });
	});
	it("voltar mantém as respostas e nunca passa da primeira", () => {
		const back = run(pick("a", "y"), { type: "next" }, { type: "back" }, { type: "back" });
		expect(back.state.index).toBe(0);
		expect(back.state.selected.a).toEqual(["y"]);
	});
	it("multiple liga e desliga; única troca", () => {
		expect(run(pick("b", "1", true), pick("b", "2", true)).state.selected.b).toEqual(["1", "2"]);
		expect(run(pick("b", "1", true), pick("b", "1", true)).state.selected.b).toEqual([]);
		expect(run(pick("a", "x"), pick("a", "y")).state.selected.a).toEqual(["y"]);
	});
	it("só envia no fim, com o mapa de respostas de sempre (escolha + texto livre)", () => {
		const out = run(pick("a", "x"), { type: "next" }, pick("b", "1", true), pick("b", "2", true), { type: "next" }, { type: "free", name: "c", text: " tudo " }, { type: "next" });
		expect(out.submit).toEqual({ a: "x", b: ["1", "2"], c: "tudo" });
		// nenhuma ação antes do fim solta o envio
		expect(run(pick("a", "x"), { type: "next" }, { type: "next" }).submit).toBeNull();
	});
	it("pular limpa a pergunta, avança, e na última envia sem ela", () => {
		const skipped = run(pick("a", "x"), { type: "next" }, pick("b", "1", true), { type: "skip" });
		expect(skipped.state.index).toBe(2);
		expect(skipped.state.selected.b).toEqual([]);
		const end = run(pick("a", "x"), { type: "next" }, { type: "skip" }, { type: "skip" });
		expect(end.submit).toEqual({ a: "x" });
	});
	it("não pula pergunta obrigatória", () => {
		const out = run({ type: "skip" });
		expect(out.state.index).toBe(0);
		expect(out.submit).toBeNull();
	});
	it("pergunta única obrigatória: Enviar só com resposta", () => {
		const one = [{ name: "q", prompt: "?", required: true, choices: [{ value: "z" }] }];
		expect(stepFooter(one, initialStepState())).toMatchObject({ primary: "send", primaryEnabled: false });
		expect(stepReduce(one, initialStepState(), { type: "next" }).submit).toBeNull();
		const chosen = stepReduce(one, initialStepState(), { type: "toggle", name: "q", value: "z", multiple: false }).state;
		expect(stepReduce(one, chosen, { type: "next" }).submit).toEqual({ q: "z" });
	});
	it("resposta livre conta como respondida; letras e subtítulo", () => {
		expect(stepAnswered(steps[2]!, { selected: {}, free: { c: "  " } })).toBe(false);
		expect(stepAnswered(steps[2]!, { selected: {}, free: { c: "oi" } })).toBe(true);
		expect([0, 1, 2, 25, 26, 27].map(choiceLetter)).toEqual(["A", "B", "C", "Z", "AA", "AB"]);
		expect(stepSubtitle(steps[1]!)).toBe("Selecione todas as opções aplicáveis");
		expect(stepSubtitle({ ...steps[0]!, description: "Escolha um" })).toBe("Escolha um");
		expect(stepSubtitle(steps[0]!)).toBeNull();
	});
	it("pular tudo não envia (o servidor recusa respostas vazias): avisa com `empty`", () => {
		const optional = [{ name: "a", prompt: "?", choices: [{ value: "x" }] }, { name: "b", prompt: "??", input: { label: "l" } }];
		let result = stepReduce(optional, initialStepState(), { type: "skip" });
		expect(result.submit).toBeNull();
		result = stepReduce(optional, result.state, { type: "skip" });
		expect(result).toMatchObject({ submit: null, empty: true });
		// Enviar na última sem nada também não sai
		const none = stepReduce(optional, { ...initialStepState(), index: 1 }, { type: "next" });
		expect(none).toMatchObject({ submit: null, empty: true });
		// com uma resposta antes, pular a última envia só ela
		const first = stepReduce(optional, initialStepState(), { type: "toggle", name: "a", value: "x", multiple: false });
		const second = stepReduce(optional, stepReduce(optional, first.state, { type: "next" }).state, { type: "skip" });
		expect(second.submit).toEqual({ a: "x" });
		expect(second.empty).toBeUndefined();
	});
});

describe("resumo do questionário respondido", () => {
	const asked: QuestionnaireCardItem[] = [
		{ name: "direction", prompt: "Direção?", choices: [{ value: "both", label: "Ambos" }, { value: "x", label: "Só um" }] },
		{ name: "tags", prompt: "Tags?", multiple: true, choices: [{ value: "a", label: "Alfa" }, { value: "b", label: "Beta" }] },
		{ name: "skipped", prompt: "Pulada?", choices: [{ value: "z" }] },
		{ name: "briefing", prompt: "Conte mais", input: { label: "Texto" } },
	];
	it("lista todas as alternativas, marca a escolhida e mantém letra e rótulo", () => {
		const [direction] = answeredQuestions(asked, { direction: "both" });
		expect(direction).toMatchObject({ name: "direction", prompt: "Direção?", text: null, answered: true });
		expect(direction!.options.map((option) => [option.letter, option.label, option.selected])).toEqual([
			["A", "Ambos", true],
			["B", "Só um", false],
		]);
	});
	it("múltipla escolha marca todas as escolhidas", () => {
		const tags = answeredQuestions(asked, { tags: ["a", "b"] })[1]!;
		expect(tags.options.map((option) => option.selected)).toEqual([true, true]);
		expect(tags.answered).toBe(true);
	});
	it("texto livre aparece como veio, sem alternativas", () => {
		const briefing = answeredQuestions(asked, { briefing: " agendar " })[3]!;
		expect(briefing).toMatchObject({ options: [], text: "agendar", answered: true });
	});
	it("valor fora das alternativas vira texto e a alternativa fica desmarcada", () => {
		const direction = answeredQuestions(asked, { direction: ["both", "outra"] })[0]!;
		expect(direction.text).toBe("outra");
		expect(direction.options.map((option) => option.selected)).toEqual([true, false]);
	});
	it("resposta ausente ou vazia mantém a pergunta, sem marcas", () => {
		for (const answers of [undefined, { direction: "  ", tags: [] }]) {
			const all = answeredQuestions(asked, answers);
			expect(all).toHaveLength(4);
			expect(all.every((question) => !question.answered && question.text === null && question.options.every((option) => !option.selected))).toBe(true);
		}
	});
});
