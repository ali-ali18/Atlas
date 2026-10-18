import type { LlmUsage } from "../chat-tools.js";
const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const tokens = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function responseUsage(value: unknown): LlmUsage {
	const raw = record(value);
	const input = record(raw.input_tokens_details);
	const output = record(raw.output_tokens_details);
	const promptTokens = tokens(raw.input_tokens);
	const completionTokens = tokens(raw.output_tokens);
	return {
		costKind: "plan",
		promptTokens,
		completionTokens,
		totalTokens: tokens(raw.total_tokens) ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
		cachedTokens: tokens(input.cached_tokens),
		cacheWriteTokens: tokens(input.cache_write_tokens),
		reasoningTokens: tokens(output.reasoning_tokens),
	};
}
