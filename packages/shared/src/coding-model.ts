/**
 * "Modelo para código": usado automaticamente quando o bot trabalha numa sessão
 * de código. Precedência: bot (`Bot.policyJson.codingModel`) > conta
 * (`config.models.coding`) > modelo normal do run.
 */

export type CodingModelSource = "bot" | "account" | "normal";

export type CodingModelResolution = {
	/** Modelo a usar no run de código. */
	model: string;
	source: CodingModelSource;
	/** Modelo configurado que não pôde ser usado (provedor indisponível); `model` é o normal. */
	unavailable?: string;
};

/** Modelo para código guardado em `Bot.policyJson.codingModel` (null = herda da conta). */
export function readCodingModel(policyJson: unknown): string | null {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return null;
	const value = (policyJson as Record<string, unknown>).codingModel;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Nova política com o modelo para código trocado, sem perder as outras chaves. */
export function withCodingModel(policyJson: unknown, model: string | null): Record<string, unknown> {
	const base =
		policyJson && typeof policyJson === "object" && !Array.isArray(policyJson)
			? { ...(policyJson as Record<string, unknown>) }
			: {};
	if (model) base.codingModel = model;
	else delete base.codingModel;
	return base;
}

/** Só a ordem de precedência (sem checar disponibilidade). */
export function configuredCodingModel(input: {
	bot?: string | null;
	account?: string | null;
}): { model: string; source: "bot" | "account" } | null {
	const bot = input.bot?.trim();
	if (bot) return { model: bot, source: "bot" };
	const account = input.account?.trim();
	if (account) return { model: account, source: "account" };
	return null;
}

/**
 * Escolhe o modelo do run de código: o configurado (bot > conta) se o usuário
 * consegue usá-lo; senão cai, sem erro, no modelo normal.
 */
export async function resolveCodingModel(input: {
	bot?: string | null;
	account?: string | null;
	normal: string;
	isAvailable: (model: string) => boolean | Promise<boolean>;
}): Promise<CodingModelResolution> {
	const configured = configuredCodingModel(input);
	if (!configured) return { model: input.normal, source: "normal" };
	if (configured.model === input.normal) return { model: input.normal, source: configured.source };
	const usable = await Promise.resolve(input.isAvailable(configured.model)).catch(() => false);
	if (!usable) return { model: input.normal, source: "normal", unavailable: configured.model };
	return { model: configured.model, source: configured.source };
}
