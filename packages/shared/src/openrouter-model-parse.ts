import type { ModelCatalogInfo } from "./model-capabilities.js";

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

const positiveNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** Metadados de capacidade de um item do `/api/v1/models` do OpenRouter (campo ausente = não declarado). */
export function parseOpenRouterModelInfo(raw: unknown): Required<Pick<ModelCatalogInfo, "contextLength" | "maxOutputTokens">> & {
	inputModalities?: string[];
	outputModalities?: string[];
	supportedParameters?: string[];
} {
	const item = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const arch = item.architecture !== null && typeof item.architecture === "object" ? (item.architecture as Record<string, unknown>) : {};
	const top = item.top_provider !== null && typeof item.top_provider === "object" ? (item.top_provider as Record<string, unknown>) : {};
	const inputModalities = strings(arch.input_modalities);
	const outputModalities = strings(arch.output_modalities);
	const supportedParameters = strings(item.supported_parameters);
	return {
		contextLength: positiveNumber(item.context_length),
		maxOutputTokens: positiveNumber(top.max_completion_tokens),
		...(inputModalities ? { inputModalities } : {}),
		...(outputModalities ? { outputModalities } : {}),
		...(supportedParameters ? { supportedParameters } : {}),
	};
}
