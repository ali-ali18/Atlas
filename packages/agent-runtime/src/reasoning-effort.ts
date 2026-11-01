import { effortForModel, type ReasoningEffort } from "@workspace/shared";

/**
 * Nível de raciocínio de cada chamada ao modelo. O modelo pode mudar no meio do run (modo Automático, modelo para
 * código), então a decisão é por modelo: `undefined` = não mandar nada (sem escolha ou modelo sem suporte).
 * `supportsReasoning` vem do catálogo/capacidades do provedor; sem ele, vale só a curadoria do `shared`.
 */
export function createReasoningEffortPicker(input: {
	effort?: ReasoningEffort;
	supportsReasoning?: (modelId: string) => boolean | Promise<boolean>;
}): (modelId: string) => Promise<ReasoningEffort | undefined> {
	const cache = new Map<string, ReasoningEffort | undefined>();
	return async (modelId) => {
		if (!input.effort) return undefined;
		if (cache.has(modelId)) return cache.get(modelId);
		const reasoning = input.supportsReasoning ? await Promise.resolve(input.supportsReasoning(modelId)).catch(() => undefined) : undefined;
		const picked = effortForModel(input.effort, modelId, undefined, reasoning);
		cache.set(modelId, picked);
		return picked;
	};
}
