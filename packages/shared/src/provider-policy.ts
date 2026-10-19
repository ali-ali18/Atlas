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

/** Provedores que a manutenção pode usar: chave própria do usuário ou do servidor. Nunca a assinatura ChatGPT. */
export type MaintenanceProvider = "openrouter" | "anthropic" | "opencode-go";

export function isMaintenanceModel(model: string | null | undefined): model is string {
	if (!model?.trim()) return false;
	try {
		return parseModelRef(model.trim()).provider !== "chatgpt";
	} catch {
		return false;
	}
}

export type MaintenanceKeyAvailability = Record<MaintenanceProvider, boolean>;

export type MaintenanceCandidate = { model: string; provider: MaintenanceProvider; role: "chosen" | "account-default" | "server-default" };

/**
 * Ordem de tentativa da manutenção. Escolhida pelo usuário primeiro; sem escolha, o padrão do servidor
 * (barato, OpenRouter) vem antes do modelo padrão da conta. Escolhida sem chave pula para o padrão da conta
 * e depois o do servidor. Sem repetição; ChatGPT nunca entra. Lista vazia = nenhuma chave utilizável.
 */
export function buildMaintenanceCandidates(input: {
	chosen?: string | null;
	accountDefault?: string | null;
	serverDefault?: string | null;
	keys: MaintenanceKeyAvailability;
}): MaintenanceCandidate[] {
	const out: MaintenanceCandidate[] = [];
	const add = (model: string | null | undefined, role: MaintenanceCandidate["role"]) => {
		if (!isMaintenanceModel(model)) return;
		const id = model.trim();
		const provider = parseModelRef(id).provider as MaintenanceProvider;
		if (!input.keys[provider] || out.some((item) => item.model === id)) return;
		out.push({ model: id, provider, role });
	};
	const chosen = input.chosen?.trim();
	if (chosen) {
		add(chosen, "chosen");
		add(input.accountDefault, "account-default");
		add(input.serverDefault, "server-default");
	} else {
		add(input.serverDefault, "server-default");
		add(input.accountDefault, "account-default");
	}
	return out;
}

export const MAINTENANCE_NO_KEY_MESSAGE =
	"Nenhuma chave disponível para a manutenção. Conecte Anthropic ou OpenCode Go em Configurações > Provedores e chaves, ou configure o OpenRouter no servidor.";

/** Falha do provedor em que tentar OUTRO modelo/provedor ajuda (modelo indisponível, política de dados, 400/404, auth 401/403). */
export function isMaintenanceFallbackError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const status = (error as { status?: unknown }).status;
	if (typeof status === "number" && [400, 401, 402, 403, 404].includes(status)) return true;
	const text = String((error as { message?: unknown }).message ?? "").toLowerCase();
	return /no endpoints? (found|available)|data policy|zero data retention|zdr|endpoints? .*available|model .*(not found|unavailable|not available)|not a valid model/.test(text);
}
