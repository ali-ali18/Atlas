import { countQuestions } from "../text.js";
import type { Trajectory } from "../trajectory.js";

/** Preço fixo do comparativo (US$ por milhão de tokens): perfil de modelo barato. Troque por `--price-in/--price-out`. */
export type Prices = { promptUsdPerMTok: number; completionUsdPerMTok: number };
export const DEFAULT_PRICES: Prices = { promptUsdPerMTok: 1, completionUsdPerMTok: 5 };

export type EngineKind = "v1" | "v2";

export type RunMetrics = {
	engine: EngineKind;
	taskId: string;
	/** Terminou com resposta normal (`answered`), sem erro, e entregou texto. */
	completed: boolean;
	stopReason: string;
	stopDetail: string | null;
	/** Perguntas feitas ao usuário na entrega (pontos de interrogação + questionário). */
	questions: number;
	modelCalls: number;
	toolCalls: number;
	costUsd: number;
	/** Itens listados em "Não deu para confirmar" (texto final ou documento). */
	unconfirmed: number;
	documentGenerated: boolean;
	/** Fração dos termos obrigatórios citados na entrega (texto + documento). */
	coverage: number;
	error: string | null;
};

const MARKER = /n[aã]o deu para confirmar|could not be confirmed|no se pudo confirmar/i;

/** Conteúdo dos arquivos criados no run (o documento também é entrega). */
export function documentTexts(trajectory: Pick<Trajectory, "toolCalls">): string[] {
	return trajectory.toolCalls.filter((call) => call.name === "create_file").map((call) => String(call.args.content ?? ""));
}

/** Itens (linhas de lista) depois do marcador "Não deu para confirmar" em cada texto. */
export function countUnconfirmed(texts: readonly string[]): number {
	let total = 0;
	for (const text of texts) {
		const at = text.search(MARKER);
		if (at < 0) continue;
		total += text.slice(at).split("\n").filter((line) => /^\s*[-*•]\s+\S/.test(line)).length;
	}
	return total;
}

export function estimateCost(trajectory: Pick<Trajectory, "modelCalls">, prices: Prices): number {
	let prompt = 0;
	let completion = 0;
	for (const call of trajectory.modelCalls) {
		prompt += call.usage?.promptTokens ?? 0;
		completion += call.usage?.completionTokens ?? 0;
	}
	return (prompt * prices.promptUsdPerMTok + completion * prices.completionUsdPerMTok) / 1_000_000;
}

export function measureRun(input: { engine: EngineKind; taskId: string; trajectory: Trajectory; mustMention: readonly string[]; prices: Prices }): RunMetrics {
	const { trajectory } = input;
	const docs = documentTexts(trajectory);
	const delivered = [trajectory.text, ...docs].join("\n");
	const askedQuestionnaire = trajectory.toolCalls.filter((call) => call.name === "propose_questionnaire").length;
	const stopReason = trajectory.stop?.reason ?? (trajectory.error ? "error" : "unknown");
	const mentioned = input.mustMention.filter((term) => delivered.toLowerCase().includes(term.toLowerCase())).length;
	return {
		engine: input.engine,
		taskId: input.taskId,
		completed: !trajectory.error && stopReason === "answered" && trajectory.text.trim().length > 0,
		stopReason,
		stopDetail: trajectory.stop?.detail ?? null,
		questions: countQuestions(trajectory.text) + askedQuestionnaire,
		modelCalls: trajectory.modelCalls.filter((call) => call.kind === "main").length,
		toolCalls: trajectory.toolCalls.length,
		costUsd: estimateCost(trajectory, input.prices),
		unconfirmed: countUnconfirmed([trajectory.text, ...docs]),
		documentGenerated: trajectory.events.some((event) => event.type === "file"),
		coverage: input.mustMention.length === 0 ? 1 : mentioned / input.mustMention.length,
		error: trajectory.error ?? null,
	};
}
