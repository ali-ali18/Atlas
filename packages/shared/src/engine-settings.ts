import { userAuthoredText } from "./autonomy-request.js";
import {
	LONG_WORK_MAX_MINUTES,
	LONG_WORK_MAX_USD,
	LONG_WORK_MIN_MINUTES,
	LONG_WORK_MIN_USD,
	readEnginePolicy,
	type EngineScope,
	type RunEngine,
} from "./engine-policy.js";
import { isWellFormedModelId, readHelperPolicy } from "./engine-helpers.js";
import { normalizedLower } from "./skill-extract.js";

/**
 * Configuração do motor pelo dono (piloto do motor v2, F4): engrenagem do bot e tool `set_engine`.
 * Tudo puro. Grava só as chaves do motor em `policyJson`, sem tocar nas outras (ver `engine-policy.ts`).
 */

export type EngineSettingsPatch = {
	engine?: RunEngine;
	/** `all` = o motor novo também em rotinas, grupos e conversa entre bots (padrão do motor novo); `chat` = só a conversa direta. */
	scope?: EngineScope;
	/** `null` = sem limite de gasto (o padrão); número = teto duro opcional em US$. */
	longWorkBudgetUsd?: number | null;
	longWorkMinutes?: number;
	/** `null` = volta a usar o modelo do bot nos ajudantes. */
	helperModel?: string | null;
};

const PATCH_KEYS = ["engine", "scope", "longWorkBudgetUsd", "longWorkMinutes", "helperModel"] as const;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Nova política com as chaves do motor mescladas. `v1` grava `engine: "v1"` explícito (o padrão do deploy
 * nunca leva um bot que escolheu o motor anterior para o v2) e remove `engineScope`; `scope: "chat"` grava `engineScope: "chat"` (o
 * padrão do motor novo é `all`); `helperModel: null` remove o modelo.
 */
export function withEngineSettings(policyJson: unknown, patch: EngineSettingsPatch): Record<string, unknown> {
	const base = { ...asRecord(policyJson) };
	if (patch.engine === "v2" || patch.engine === "v1") base.engine = patch.engine;
	if (patch.engine === "v1") delete base.engineScope;
	if (patch.scope === "all") base.engineScope = "all";
	else if (patch.scope === "chat") {
		// `chat` precisa ficar gravado: sem `engineScope` o motor novo vale em tudo (padrão `all`). E só vale com o motor novo explícito.
		base.engineScope = "chat";
		if (base.engine !== "v1") base.engine = "v2";
	}
	if (patch.longWorkBudgetUsd === null) delete base.longWorkBudgetUsd;
	else if (patch.longWorkBudgetUsd !== undefined) base.longWorkBudgetUsd = patch.longWorkBudgetUsd;
	if (patch.longWorkMinutes !== undefined) base.longWorkMinutes = patch.longWorkMinutes;
	if (patch.helperModel === null) delete base.helperModel;
	else if (patch.helperModel !== undefined) base.helperModel = patch.helperModel;
	return base;
}

export type ParsedEngineArgs = { ok: true; patch: EngineSettingsPatch } | { ok: false; error: string };

const ACCEPTED = `Accepted fields: engine ("current" = the previous engine, or "new"), scope ("all" = also routines, groups and bot-to-bot messages, the default with the new engine; "chat" = only the direct chat; needs the new engine), budget_usd (optional spending cap per long task, ${LONG_WORK_MIN_USD} to ${LONG_WORK_MAX_USD}; 0 or empty = no spending limit, the default), minutes (maximum time of a long task, ${LONG_WORK_MIN_MINUTES} to ${LONG_WORK_MAX_MINUTES}, default 60), helper_model (model id, or "" to use the bot's model).`;

/** Valida os argumentos da tool: campo desconhecido ou valor fora da faixa FALHA com a lista do aceito (nunca ajusta em silêncio). */
export function parseSetEngineArgs(args: unknown): ParsedEngineArgs {
	const raw = asRecord(args);
	const allowed = new Set(["engine", "scope", "budget_usd", "minutes", "helper_model"]);
	const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
	if (unknown.length > 0) return { ok: false, error: `Unknown field(s): ${unknown.join(", ")}. ${ACCEPTED}` };
	const patch: EngineSettingsPatch = {};
	if (raw.engine !== undefined) {
		if (raw.engine === "new") patch.engine = "v2";
		else if (raw.engine === "current") patch.engine = "v1";
		else return { ok: false, error: `Invalid engine. ${ACCEPTED}` };
	}
	if (raw.scope !== undefined) {
		if (raw.scope !== "chat" && raw.scope !== "all") return { ok: false, error: `Invalid scope. ${ACCEPTED}` };
		patch.scope = raw.scope;
	}
	if (raw.budget_usd !== undefined) {
		const usd = raw.budget_usd;
		if (usd === null || usd === "" || usd === 0) patch.longWorkBudgetUsd = null;
		else if (typeof usd !== "number" || !Number.isFinite(usd) || usd < LONG_WORK_MIN_USD || usd > LONG_WORK_MAX_USD) {
			return { ok: false, error: `Invalid budget_usd. ${ACCEPTED}` };
		} else patch.longWorkBudgetUsd = Math.round(usd * 100) / 100;
	}
	if (raw.minutes !== undefined) {
		const minutes = raw.minutes;
		if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < LONG_WORK_MIN_MINUTES || minutes > LONG_WORK_MAX_MINUTES) {
			return { ok: false, error: `Invalid minutes. ${ACCEPTED}` };
		}
		patch.longWorkMinutes = Math.round(minutes);
	}
	if (raw.helper_model !== undefined) {
		if (typeof raw.helper_model !== "string") return { ok: false, error: `Invalid helper_model. ${ACCEPTED}` };
		const model = raw.helper_model.trim();
		if (model === "") patch.helperModel = null;
		else if (isWellFormedModelId(model)) patch.helperModel = model;
		else return { ok: false, error: `Invalid helper_model. ${ACCEPTED}` };
	}
	if (PATCH_KEYS.every((key) => patch[key] === undefined)) return { ok: false, error: `Nothing to change. ${ACCEPTED}` };
	return { ok: true, patch };
}

const ENGINE_PATTERNS: RegExp[] = [
	/\bmotor (novo|v2|antigo|atual|velho)\b/,
	/\bnovo motor\b/,
	/\b(liga|ligue|ligar|ativa|ative|ativar|desliga|desligue|desligar|desativa|desative|desativar|volta|volte|voltar|troca|troque|trocar|muda|mude|mudar|usa|use|usar)\b[^.!?\n]{0,25}\bmotor\b/,
	/\bmotor\b[^.!?\n]{0,25}\b(novo|v2|antigo|atual|trabalho longo)\b/,
	/\b(turn on|turn off|switch|enable|disable|use)\b[^.!?\n]{0,25}\b(new|old|v2|current) engine\b/,
	/\b(new|old|v2) engine\b/,
	// "orçamento de 1 dólar por tarefa", "limite de 2 dólares", "até 30 minutos por tarefa longa"
	/\b(orcamento|limite|teto|budget)\b[^.!?\n]{0,30}\b(dolar|dolares|usd|us\$|\$|minutos?|dollars?)\b[^.!?\n]{0,30}\b(tarefas?|trabalhos?|task)/,
	/\b(orcamento|limite|teto)\b[^.!?\n]{0,30}\b(tarefas? longas?|trabalho longo)\b/,
];

const REQUEST_MAX_CHARS = 400;

/** O dono pediu para ligar, desligar ou ajustar o motor? Só a fala dele conta (resultado de tool nunca). */
export function looksLikeEngineRequest(text: string): boolean {
	const authored = userAuthoredText(text);
	if (!authored || authored.length > REQUEST_MAX_CHARS) return false;
	const n = normalizedLower(authored);
	return ENGINE_PATTERNS.some((pattern) => pattern.test(n));
}

const BRL_FORMAT = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Frase para o dono (pt-BR): "Motor novo (padrão) · sem limite de gasto, até 60 min por tarefa longa". Bot sem escolha
 * mostra o padrão (o `off` de emergência do deploy não aparece aqui); escolha explícita mostra "Motor novo" ou "Motor anterior".
 */
export function describeEngineSettings(policyJson: unknown): string {
	const policy = readEnginePolicy(policyJson);
	if (policy.engine !== "v2") return "Motor anterior";
	const helper = readHelperPolicy(policyJson).helperModel;
	const where = policy.scope === "all" ? " · também em rotinas e grupos" : "";
	const budget =
		policy.longWorkBudgetUsd === undefined
			? `sem limite de gasto, até ${policy.longWorkMinutes} min por tarefa longa`
			: `gasto máximo de US$ ${BRL_FORMAT.format(policy.longWorkBudgetUsd)} e até ${policy.longWorkMinutes} min por tarefa longa`;
	return `${policy.explicit === undefined ? "Motor novo (padrão)" : "Motor novo"}${where} · ${budget}${helper ? ` · ajudantes: ${helper}` : ""}`;
}

/**
 * `longWorkBudgetUsd` vazio, `null` ou `0` = sem limite de gasto: a chave sai do `policyJson` (nunca grava 0). Usado pelo PATCH
 * antes de validar e gravar; o resto do `policyJson` passa intacto.
 */
export function normalizeEngineSettings(policyJson: unknown): unknown {
	const policy = asRecord(policyJson);
	if (!("longWorkBudgetUsd" in policy)) return policyJson;
	const value = policy.longWorkBudgetUsd;
	if (value !== null && value !== 0 && value !== "") return policyJson;
	const { longWorkBudgetUsd: _removed, ...rest } = policy;
	return rest;
}

/**
 * Valida as chaves do motor num `policyJson` vindo da UI (a rota PATCH grava o jsonb inteiro). Ausente = ok;
 * presente e fora da faixa = mensagem de erro (a rota responde 400), nunca ajuste silencioso.
 */
export function engineSettingsError(policyJson: unknown): string | null {
	const policy = asRecord(policyJson);
	if (policy.engine !== undefined && policy.engine !== "v1" && policy.engine !== "v2") return 'Invalid engine: expected "v1" or "v2"';
	if (policy.engineScope !== undefined && policy.engineScope !== "chat" && policy.engineScope !== "all") return 'Invalid engineScope: expected "chat" or "all"';
	const inRange = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
	if (policy.longWorkBudgetUsd !== undefined && policy.longWorkBudgetUsd !== null && !inRange(policy.longWorkBudgetUsd, LONG_WORK_MIN_USD, LONG_WORK_MAX_USD)) {
		return `Invalid longWorkBudgetUsd: expected ${LONG_WORK_MIN_USD} to ${LONG_WORK_MAX_USD}`;
	}
	if (policy.longWorkMinutes !== undefined && !inRange(policy.longWorkMinutes, LONG_WORK_MIN_MINUTES, LONG_WORK_MAX_MINUTES)) {
		return `Invalid longWorkMinutes: expected ${LONG_WORK_MIN_MINUTES} to ${LONG_WORK_MAX_MINUTES}`;
	}
	if (policy.helperModel !== undefined && policy.helperModel !== null && (typeof policy.helperModel !== "string" || !isWellFormedModelId(policy.helperModel.trim()))) {
		return "Invalid helperModel: expected a model id";
	}
	return null;
}
