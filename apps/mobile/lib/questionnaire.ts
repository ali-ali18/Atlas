// Respostas de um questionário: o mesmo mapa que o web envia (`name -> valor ou lista de valores`); escolhas e
// texto livre de um item compartilham o mesmo `name` e, com mais de um valor, viram lista.
import type { QuestionnaireCardItem } from "@workspace/shared";

export type AnswerMap = Record<string, string | string[]>;

export function buildAnswers(items: readonly QuestionnaireCardItem[], selected: Record<string, readonly string[]>, free: Record<string, string>): AnswerMap {
	const answers: AnswerMap = {};
	for (const item of items) {
		const values = [...(selected[item.name] ?? []), ...(free[item.name]?.trim() ? [free[item.name]!.trim()] : [])].filter(Boolean);
		if (values.length === 0) continue;
		answers[item.name] = values.length > 1 ? values : values[0]!;
	}
	return answers;
}

/** Nomes dos itens obrigatórios ainda sem resposta (o item sem `required` pode ficar em branco). */
export function missingRequired(items: readonly QuestionnaireCardItem[], answers: AnswerMap): string[] {
	return items.filter((item) => item.required && answers[item.name] === undefined).map((item) => item.name);
}

/** Alterna uma escolha: item de escolha única troca o valor, o de várias liga e desliga. */
export function toggleChoice(current: readonly string[], value: string, multiple: boolean): string[] {
	if (!multiple) return current.length === 1 && current[0] === value ? [] : [value];
	return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

// ---- passo a passo ----------------------------------------------------------------------------------------------
// Uma pergunta por vez no cartão (como o `questionnaire-card` do web): Voltar a partir da 2ª, Pular quando a pergunta
// não é obrigatória, Avançar, e Enviar na última. O envio é um só, no fim, com o mesmo mapa de respostas de sempre.

export type StepState = { index: number; selected: Record<string, string[]>; free: Record<string, string> };

export const initialStepState = (): StepState => ({ index: 0, selected: {}, free: {} });

export type StepAction = { type: "toggle"; name: string; value: string; multiple: boolean } | { type: "free"; name: string; text: string } | { type: "back" } | { type: "next" } | { type: "skip" };

/** A pergunta já tem resposta (uma escolha ou texto livre)? */
export function stepAnswered(item: QuestionnaireCardItem, state: Pick<StepState, "selected" | "free">): boolean {
	return (state.selected[item.name]?.length ?? 0) > 0 || !!state.free[item.name]?.trim();
}

/** Letra da caixa de cada opção: A, B, C… (depois do Z recomeça com AA). */
export function choiceLetter(index: number): string {
	let n = index;
	let out = "";
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

export function stepSubtitle(item: QuestionnaireCardItem): string | null {
	if (item.multiple) return "Selecione todas as opções aplicáveis";
	return item.description?.trim() || null;
}

export type StepFooter = {
	dots: number;
	index: number;
	back: boolean;
	skip: boolean;
	/** `send` na última pergunta. */
	primary: "next" | "send";
	/** Obrigatória sem resposta: "Avançar"/"Enviar" fica apagado. */
	primaryEnabled: boolean;
};

export function stepFooter(items: readonly QuestionnaireCardItem[], state: StepState): StepFooter {
	const item = items[state.index];
	const last = state.index >= items.length - 1;
	return {
		dots: items.length,
		index: state.index,
		back: state.index > 0,
		skip: !!item && !item.required,
		primary: last ? "send" : "next",
		primaryEnabled: !item || !item.required || stepAnswered(item, state),
	};
}

/**
 * Um passo do cartão. `submit` vem preenchido quando a ação encerra o questionário (Enviar na última, ou Pular na
 * última): só então o mapa de respostas sai. Obrigatória sem resposta não avança.
 */
export function stepReduce(items: readonly QuestionnaireCardItem[], state: StepState, action: StepAction): { state: StepState; submit: AnswerMap | null; empty?: true } {
	const item = items[state.index];
	const last = state.index >= items.length - 1;
	switch (action.type) {
		case "toggle":
			return { state: { ...state, selected: { ...state.selected, [action.name]: toggleChoice(state.selected[action.name] ?? [], action.value, action.multiple) } }, submit: null };
		case "free":
			return { state: { ...state, free: { ...state.free, [action.name]: action.text } }, submit: null };
		case "back":
			return { state: { ...state, index: Math.max(0, state.index - 1) }, submit: null };
		case "next": {
			if (!item || (item.required && !stepAnswered(item, state))) return { state, submit: null };
			if (!last) return { state: { ...state, index: state.index + 1 }, submit: null };
			return finish(items, state, state);
		}
		case "skip": {
			if (!item || item.required) return { state, submit: null };
			// Pular limpa o que houver nesta pergunta: pular é "sem resposta", não "resposta antiga".
			const selected = { ...state.selected, [item.name]: [] };
			const free = { ...state.free, [item.name]: "" };
			const next = { ...state, selected, free, index: last ? state.index : state.index + 1 };
			if (!last) return { state: next, submit: null };
			return finish(items, next, next);
		}
	}
}

/**
 * Fim do questionário. O servidor recusa `answers` vazio (400: "ao menos 1 preenchido"), então pular tudo não envia:
 * `empty` pede ao cartão uma mensagem clara. Não há endpoint de dispensar/pular o questionário.
 */
function finish(items: readonly QuestionnaireCardItem[], state: StepState, answersFrom: Pick<StepState, "selected" | "free">): { state: StepState; submit: AnswerMap | null; empty?: true } {
	const answers = buildAnswers(items, answersFrom.selected, answersFrom.free);
	if (Object.keys(answers).length === 0) return { state, submit: null, empty: true };
	return { state, submit: missingRequired(items, answers).length === 0 ? answers : null };
}

export const EMPTY_QUESTIONNAIRE_NOTICE = "Responda ao menos uma pergunta para enviar.";

export type AnsweredOption = { value: string; letter: string; label: string; description?: string; selected: boolean };
export type AnsweredQuestion = {
	name: string;
	prompt: string;
	/** TODAS as alternativas da pergunta, com a(s) escolhida(s) marcada(s). */
	options: AnsweredOption[];
	/** Texto livre digitado (ou valor que não casa com nenhuma alternativa); `null` se não houve. */
	text: string | null;
	/** Houve alguma resposta (escolha ou texto)? Falso = pergunta pulada. */
	answered: boolean;
};

/**
 * Questionário já enviado, para o cartão respondido, na ordem das perguntas: cada pergunta traz todas as alternativas
 * (rótulo, não o `value` cru; a letra é a da etapa pendente) com `selected`, várias escolhas marcadas juntas e o texto
 * livre como veio. Pergunta sem resposta (pulada) continua na lista com `answered: false`.
 */
export function answeredQuestions(items: readonly QuestionnaireCardItem[], answers: AnswerMap | undefined): AnsweredQuestion[] {
	return items.map((item) => {
		const raw = answers?.[item.name];
		const values = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map((value) => value.trim()).filter(Boolean);
		const known = new Set((item.choices ?? []).map((choice) => choice.value));
		const options = (item.choices ?? []).map((choice, position): AnsweredOption => {
			const option: AnsweredOption = { value: choice.value, letter: choiceLetter(position), label: choice.label ?? choice.value, selected: values.includes(choice.value) };
			if (choice.description) option.description = choice.description;
			return option;
		});
		const free = values.filter((value) => !known.has(value));
		return { name: item.name, prompt: item.prompt, options, text: free.length > 0 ? free.join(", ") : null, answered: values.length > 0 };
	});
}
