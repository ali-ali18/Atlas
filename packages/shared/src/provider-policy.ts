import { parseModelRef } from "./model-ref.js";
export const CHATGPT_FALLBACK_MODEL = "deepseek/deepseek-v4.1-flash";
export function resolveChatgptFallbackModel(policy: unknown): string | null {
	const value =
		policy && typeof policy === "object" && !Array.isArray(policy)
			? (policy as Record<string, unknown>).chatgptFallbackModel
			: undefined;
	if (value === undefined) return CHATGPT_FALLBACK_MODEL;
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		!value.trim() ||
		parseModelRef(value).provider !== "openrouter"
	)
		throw new RangeError("Modelo de fallback inválido");
	return value.trim();
}
/** Manutenção jamais consome assinatura, mesmo com configuração antiga/incorreta. */
export function resolveMaintenanceModel(
	configured: string | undefined | null,
	fallback: string
): string {
	if (parseModelRef(fallback).provider !== "openrouter")
		throw new RangeError("Manutenção exige modelo OpenRouter");
	if (!configured?.trim()) return fallback;
	return parseModelRef(configured).provider === "openrouter"
		? configured.trim()
		: fallback;
}
export function resolveRoutineProviderModel(
	model: string,
	allowChatgptPlan: boolean,
	fallback: string | null
): string | null {
	// Só o plano ChatGPT exige opt-in; chaves próprias (OpenRouter, Anthropic, OpenCode Go) rodam rotinas.
	return parseModelRef(model).provider !== "chatgpt" || allowChatgptPlan
		? model
		: fallback;
}
export function inheritedSubagentModel(
	parent: string,
	requested?: string
): string {
	if (
		!requested ||
		parseModelRef(requested).provider !== parseModelRef(parent).provider
	)
		return parent;
	return requested;
}
