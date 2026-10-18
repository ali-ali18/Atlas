import { clipForJev, decideWithJev, jevModeFor, jevYes, type JevRuntime } from "./decide.js";

const QUESTION = {
	independent_subtasks: {
		instructions:
		"Does the user's request split into 2 or 3 clearly independent read-only lookups or research parts that could run in parallel (for example the same research across different stores, sources, repositories or documents), each needing its own searching or reading? Simple single questions and dependent steps are not.",
		criteria: { true: "2-3 independent parts", false: "A single task or dependent steps" },
	},
};

export const DELEGATION_HINT =
	"Hint (automatic): this request seems to split into 2-3 independent, read-only parts. Consider calling delegate_task once with one self-contained goal per part (they run in parallel), then verify the key facts and write the final answer yourself. If the parts depend on each other or are quick, just do them yourself.";

/** Dica (em inglês) para o modelo quando o Jev vê tarefas independentes; `null` caso contrário. */
export async function suggestDelegation(input: {
	rt: JevRuntime | undefined;
	userRequest: string;
	signal?: AbortSignal;
}): Promise<string | null> {
	const mode = jevModeFor(input.rt, "delegate");
	const request = input.userRequest.trim();
	if (mode === "off" || !request) return null;
	const result = await decideWithJev({
		rt: input.rt,
		feature: "delegate",
		state: { userRequest: clipForJev(request, 1_500) },
		questions: QUESTION,
		signal: input.signal,
	});
	if (!result || mode !== "on") return null;
	return jevYes(result.answers.independent_subtasks) ? DELEGATION_HINT : null;
}
