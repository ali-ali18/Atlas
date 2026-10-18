import {
	JEV_FEATURES,
	LLM_TIMEOUT_PRESET_VALUES,
	mergeAccountConfig,
	type AccountConfigPatch,
	type AccountSettingsResponse,
	type ConfigSource,
	type UpdateAccountSettingsInput,
} from "@workspace/shared";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export const SAVE_ERROR_FALLBACK = "Não foi possível salvar. Tente novamente.";

/**
 * Rótulo curto da opção "Herdar" com o valor herdado ("Herdar (pt-BR)"). A origem
 * (servidor ou conta) não entra: o texto tem de caber em painéis estreitos.
 * Origem `user` não herda nada: devolve `null`.
 */
export function inheritLabel(source: ConfigSource, valueLabel: string): string | null {
	if (source === "user") return null;
	return `Herdar (${valueLabel})`;
}

/**
 * Mostra a mudança antes de o servidor responder. Só valores novos: `null`
 * (voltar a herdar) não altera nada aqui, porque o valor herdado só o servidor
 * sabe; a resposta do PATCH traz o certo.
 */
export function applyOptimisticPatch(
	view: AccountSettingsResponse,
	patch: AccountConfigPatch,
	extra: { sandboxAutoStart?: boolean } = {},
): AccountSettingsResponse {
	const effective = { ...view.effective } as Record<string, unknown>;
	let changed = false;
	const set = (group: string, key: string, value: unknown) => {
		// Chave vazia = o próprio grupo é o valor (ex.: `sandboxAutoStart`).
		effective[group] = key
			? { ...(effective[group] as object), [key]: { value, source: "user" } }
			: { value, source: "user" };
		changed = true;
	};

	const language = patch.general?.defaultBotLanguage;
	if (typeof language === "string") set("general", "defaultBotLanguage", language);
	const timezone = patch.general?.timezone;
	if (typeof timezone === "string") set("general", "timezone", timezone);
	const chatgpt = patch.providers?.chatgptEnabled;
	if (typeof chatgpt === "boolean") set("providers", "chatgptEnabled", chatgpt);
	const groupsJev = patch.groups?.jevCoordination;
	if (typeof groupsJev === "boolean") set("groups", "jevCoordination", groupsJev);
	for (const key of ["default", "maintenance", "vision", "image", "stt"] as const) {
		const id = patch.models?.[key];
		if (typeof id === "string") set("models", key, id);
	}
	const fallbacks = patch.models?.fallbacks;
	if (Array.isArray(fallbacks)) set("models", "fallbacks", [...fallbacks]);

	let config = view.config;
	if (patch.jev || patch.execution || patch.reflection) {
		const touched: AccountConfigPatch = {};
		if (patch.reflection) touched.reflection = patch.reflection;
		if (patch.jev) touched.jev = patch.jev;
		if (patch.execution) touched.execution = patch.execution;
		config = mergeAccountConfig(view.config, touched);
		changed = true;
		applyJevAndExecution(patch, config, effective, set);
	}
	if (typeof extra.sandboxAutoStart === "boolean") {
		set("sandboxAutoStart", "", extra.sandboxAutoStart);
	}

	if (!changed) return view;
	const next = { ...view, config, effective: effective as AccountSettingsResponse["effective"] };
	return typeof extra.sandboxAutoStart === "boolean"
		? { ...next, settings: { ...view.settings, sandboxAutoStart: extra.sandboxAutoStart } }
		: next;
}

/**
 * Jev e execução: só valores novos mudam o efetivo (`null` volta a herdar e a
 * resposta do servidor traz o valor certo). Um recurso do Jev vale o que a
 * conta escolheu para ele ou, na falta, o "geral" da conta.
 */
function applyJevAndExecution(
	patch: AccountConfigPatch,
	config: AccountSettingsResponse["config"],
	effective: Record<string, unknown>,
	set: (group: string, key: string, value: unknown) => void,
) {
	if (typeof patch.jev?.mcp === "string") set("jev", "mcp", patch.jev.mcp);
	if (patch.jev?.all !== undefined || patch.jev?.features) {
		const features = { ...((effective.jev as { features?: object } | undefined)?.features ?? {}) } as Record<string, unknown>;
		for (const feature of JEV_FEATURES) {
			const mode = config.jev?.features?.[feature] ?? config.jev?.all;
			if (mode) features[feature] = { value: mode, source: "user" };
		}
		effective.jev = { ...(effective.jev as object), features };
	}
	const execution = patch.execution;
	if (!execution) return;
	if (typeof execution.discipline === "boolean") set("execution", "discipline", execution.discipline);
	if (typeof execution.contextEconomy === "boolean") set("execution", "contextEconomy", execution.contextEconomy);
	if (typeof execution.reactionOnly === "boolean") set("execution", "reactionOnly", execution.reactionOnly);
	if (typeof execution.contextMemory === "string") set("execution", "contextMemory", execution.contextMemory);
	if (typeof execution.llmTimeoutPreset === "string") {
		set("execution", "llmTimeouts", { ...LLM_TIMEOUT_PRESET_VALUES[execution.llmTimeoutPreset] });
	}
	for (const key of ["maxOutputTokens", "maxSteps", "maxWallMinutes"] as const) {
		const value = execution[key];
		if (typeof value === "number") set("execution", key, value);
	}
}

/** Mensagem pt-BR para o usuário; erro do servidor só quando é de validação (400). */
export function saveErrorMessage(error: unknown): string {
	if (error && typeof error === "object" && "status" in error && "message" in error) {
		const { status, message } = error as { status: unknown; message: unknown };
		if (status === 400 && typeof message === "string" && message.trim()) return message;
	}
	return SAVE_ERROR_FALLBACK;
}

export type CommitResult =
	| { ok: true; view: AccountSettingsResponse }
	| { ok: false; view: AccountSettingsResponse; error: string };

/**
 * Envia o PATCH e devolve a visão final: a do servidor em caso de sucesso, ou
 * a anterior (rollback) com a mensagem de erro. `onOptimistic` recebe a visão
 * otimista para a tela já refletir a escolha enquanto o PATCH está em voo.
 */
export async function commitSettingsChange(input: {
	view: AccountSettingsResponse;
	patch: AccountConfigPatch;
	/** Colunas fora do `configJson` (hoje só `sandboxAutoStart`). */
	extra?: { sandboxAutoStart?: boolean };
	send: (input: UpdateAccountSettingsInput) => Promise<AccountSettingsResponse>;
	onOptimistic?: (view: AccountSettingsResponse) => void;
}): Promise<CommitResult> {
	input.onOptimistic?.(applyOptimisticPatch(input.view, input.patch, input.extra));
	try {
		// Só a coluna (ex.: sandboxAutoStart): não manda `config` vazio, que regravaria o JSON à toa.
		const body: UpdateAccountSettingsInput = Object.keys(input.patch).length > 0 ? { config: input.patch } : {};
		if (input.extra?.sandboxAutoStart !== undefined) body.sandboxAutoStart = input.extra.sandboxAutoStart;
		return { ok: true, view: await input.send(body) };
	} catch (error) {
		return { ok: false, view: input.view, error: saveErrorMessage(error) };
	}
}
