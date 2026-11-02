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
