import { formatModelRef } from "./model-ref.js";
import type { ProviderModel } from "./model.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Não deriva capacidades por nome e ignora referências malformadas do provedor. */
export function parseChatgptModels(raw: unknown): ProviderModel[] {
	const root = record(raw);
	const rows = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : [];
	const models = new Map<string, ProviderModel>();
	for (const value of rows) {
		const row = record(value);
		if (typeof row.slug !== "string") continue;
		let id: string;
		try { id = formatModelRef("chatgpt", row.slug); } catch { continue; }
		const caps = record(row.capabilities);
		const vision = typeof caps.vision === "boolean" ? caps.vision : typeof row.supports_vision === "boolean" ? row.supports_vision : undefined;
		const tools = typeof caps.tools === "boolean" ? caps.tools : typeof row.supports_tools === "boolean" ? row.supports_tools : undefined;
		const length = row.context_length;
		models.set(id, {
			id, name: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : row.slug,
			provider: "chatgpt", visibility: typeof row.visibility === "string" ? row.visibility : "unknown",
			contextLength: typeof length === "number" && Number.isSafeInteger(length) && length > 0 ? length : null,
			capabilities: vision === undefined && tools === undefined ? "unknown" : { ...(vision !== undefined ? { vision } : {}), ...(tools !== undefined ? { tools } : {}) },
			...(vision !== undefined ? { inputModalities: vision ? ["text", "image"] : ["text"] } : {}),
		});
	}
	return [...models.values()];
}

export function visibleProviderModels(models: readonly ProviderModel[], selected?: string): ProviderModel[] {
	return models.filter((model) => model.visibility === "list" || model.id === selected);
}
