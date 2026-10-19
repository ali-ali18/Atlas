import { BOT_LANGUAGES, type BotLanguage } from "./bot-language.js";
import { parseModelRef } from "./model-ref.js";
import { isValidTimeZone } from "./proactive.js";
import { ORCHESTRATOR_MEMORY_MAX_CHARS, ORCHESTRATOR_MEMORY_MIN_CHARS } from "./memory-limits.js";

/**
 * Configuração da conta (`UserSettings.configJson`), versionada `{ v: 1, … }`.
 * Só ESCOLHAS: enums, números e ids de modelo. Nunca segredo nem texto livre.
 * Funções puras: sem I/O, sem `process.env`.
 */

export const ACCOUNT_CONFIG_VERSION = 1;
/** Tamanho máximo do JSON gravado (bytes de `JSON.stringify`). */
export const ACCOUNT_CONFIG_MAX_BYTES = 4096;

export const JEV_MODES = ["off", "shadow", "on"] as const;
export type JevMode = (typeof JEV_MODES)[number];
export const JEV_MCP_MODES = ["off", "shadow", "gate"] as const;
export type JevMcpMode = (typeof JEV_MCP_MODES)[number];
export const JEV_FEATURES = ["intent", "tools", "verify", "blockpage", "delegate", "stuck"] as const;
export type JevFeature = (typeof JEV_FEATURES)[number];
export const LLM_TIMEOUT_PRESETS = ["short", "default", "extended"] as const;
export type LlmTimeoutPreset = (typeof LLM_TIMEOUT_PRESETS)[number];
/** Memória da conversa: "standard" resume perto do limite do modelo; "economy" enxuga cedo (menor custo). */
export const CONTEXT_MEMORIES = ["standard", "economy"] as const;
export type ContextMemory = (typeof CONTEXT_MEMORIES)[number];
export const MAX_OUTPUT_TOKEN_PRESETS = [2048, 4096, 8192, 16384, 32768] as const;
/** Tamanho máximo (caracteres) do resultado de uma ferramenta que vai inline ao contexto; o resto fica guardado e é lido sob demanda. */
export const TOOL_RESULT_MAX_CHARS_PRESETS = [20_000, 50_000, 100_000, 200_000] as const;
export const MAX_FALLBACK_MODELS = 3;
export const MAX_STEPS_LIMIT = 500;
export const MAX_WALL_MINUTES_LIMIT = 240;

export type AccountConfigV1 = {
	v: 1;
	providers?: { chatgptEnabled?: boolean };
	models?: {
		default?: string;
		fallbacks?: string[];
		maintenance?: string;
		vision?: string;
		image?: string;
		/** Modelo usado automaticamente quando o bot trabalha em uma sessão de código. */
		coding?: string;
		/** Modelo do ditado por voz (STT): id OpenRouter (`vendor/modelo`) ou do endpoint OpenAI-compatível. */
		stt?: string;
	};
	jev?: {
		mcp?: JevMcpMode;
		all?: JevMode;
		features?: Partial<Record<JevFeature, JevMode>>;
	};
	/** Grupos de bots: coordenação inteligente (roteamento e delegação decididos pelo Jev). */
	groups?: { jevCoordination?: boolean };
	execution?: {
		discipline?: boolean;
		contextEconomy?: boolean;
		contextMemory?: ContextMemory;
		llmTimeoutPreset?: LlmTimeoutPreset;
		maxOutputTokens?: number;
		toolResultMaxChars?: number;
		maxSteps?: number;
		maxWallMinutes?: number;
		maxRunCostUsd?: number | null;
		/** Responder só com uma reação quando a mensagem não precisa de resposta (ligado quando ausente). */
		reactionOnly?: boolean;
	};
	/** Sessões de código: Verificador inteligente das ações (ligado quando ausente). */
	coding?: { verifier?: boolean };
	general?: { defaultBotLanguage?: BotLanguage; timezone?: string };
	/** Reflexao diaria do orquestrador: liga/desliga e horario (no fuso da conta). */
	reflection?: { enabled?: boolean; time?: string; memoryChars?: number };
};

/** Mesmo formato, mas cada folha ou grupo pode ser `null` (= remove a chave, volta a herdar). */
export type AccountConfigPatch = { v?: 1 } & {
	[G in Exclude<keyof AccountConfigV1, "v">]?: DeepNullable<NonNullable<AccountConfigV1[G]>> | null;
};
type DeepNullable<T> = {
	[K in keyof T]?: T[K] extends readonly unknown[] ? T[K] | null : T[K] extends object ? DeepNullable<T[K]> | null : T[K] | null;
};

export type AccountConfigError = { path: string; message: string };

type Leaf = { message: string; parse: (value: unknown) => { value: unknown } | null };
type Spec = { [key: string]: Leaf | Spec };

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,200}$/;

const bool = (message: string): Leaf => ({
	message,
	parse: (v) => (typeof v === "boolean" ? { value: v } : null),
});
const oneOf = (options: readonly string[], message: string): Leaf => ({
	message,
	parse: (v) => (typeof v === "string" && options.includes(v) ? { value: v } : null),
});
const oneOfNumbers = (options: readonly number[], message: string): Leaf => ({
	message,
	parse: (v) => (typeof v === "number" && options.includes(v) ? { value: v } : null),
});
const intRange = (min: number, max: number, message: string): Leaf => ({
	message,
	parse: (v) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? { value: v } : null),
});
const nullableOneOfNumbers = (options: readonly number[], message: string): Leaf => ({
	message,
	parse: (v) => {
		if (v === null) return { value: null };
		if (typeof v === "number" && options.includes(v)) return { value: v };
		return null;
	},
});

/** Id de modelo bem formado. `openRouterOnly` rejeita `chatgpt/*` (manutenção, visão, imagem, reserva). */
export function isValidConfigModelId(value: unknown, openRouterOnly: boolean): value is string {
	if (typeof value !== "string" || !MODEL_ID.test(value)) return false;
	try {
		return !openRouterOnly || parseModelRef(value).provider === "openrouter";
	} catch {
		return false;
	}
}

const modelId = (openRouterOnly: boolean, message: string): Leaf => ({
	message,
	parse: (v) => (isValidConfigModelId(v, openRouterOnly) ? { value: v } : null),
});

const OPENROUTER_ONLY = "Informe um id de modelo do OpenRouter (letras, números e . _ : / -, até 200).";
const fallbackList: Leaf = {
	message: `Informe até ${MAX_FALLBACK_MODELS} ids de modelo do OpenRouter, sem repetição.`,
	parse: (v) => {
		if (!Array.isArray(v) || v.length > MAX_FALLBACK_MODELS) return null;
		if (!v.every((item) => isValidConfigModelId(item, true))) return null;
		return new Set(v).size === v.length ? { value: [...v] } : null;
	},
};

const TIME_HHMM = new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$");

const SPEC: Spec = {
	providers: { chatgptEnabled: bool("Use verdadeiro ou falso.") },
	models: {
		default: modelId(false, "Informe um id de modelo válido (letras, números e . _ : / -, até 200)."),
		fallbacks: fallbackList,
		maintenance: modelId(true, OPENROUTER_ONLY),
		vision: modelId(true, OPENROUTER_ONLY),
		image: modelId(true, OPENROUTER_ONLY),
		coding: modelId(false, "Informe um id de modelo válido (letras, números e . _ : / -, até 200)."),
		stt: modelId(true, OPENROUTER_ONLY),
	},
	jev: {
		mcp: oneOf(JEV_MCP_MODES, "Use off, shadow ou gate."),
		all: oneOf(JEV_MODES, "Use off, shadow ou on."),
		features: Object.fromEntries(JEV_FEATURES.map((f) => [f, oneOf(JEV_MODES, "Use off, shadow ou on.")])),
	},
	groups: { jevCoordination: bool("Use verdadeiro ou falso.") },
	execution: {
		discipline: bool("Use verdadeiro ou falso."),
		reactionOnly: bool("Use verdadeiro ou falso."),
		contextEconomy: bool("Use verdadeiro ou falso."),
		contextMemory: oneOf(CONTEXT_MEMORIES, "Use standard ou economy."),
		llmTimeoutPreset: oneOf(LLM_TIMEOUT_PRESETS, "Use short, default ou extended."),
		maxOutputTokens: oneOfNumbers(MAX_OUTPUT_TOKEN_PRESETS, `Use um de: ${MAX_OUTPUT_TOKEN_PRESETS.join(", ")}.`),
		toolResultMaxChars: oneOfNumbers(TOOL_RESULT_MAX_CHARS_PRESETS, `Use um de: ${TOOL_RESULT_MAX_CHARS_PRESETS.join(", ")}.`),
		maxSteps: oneOfNumbers([100, 200, 300, 500], "Use um de: 100, 200, 300, 500."),
		maxWallMinutes: intRange(1, MAX_WALL_MINUTES_LIMIT, `Use um inteiro de 1 a ${MAX_WALL_MINUTES_LIMIT}.`),
		maxRunCostUsd: nullableOneOfNumbers([0.05, 0.10, 0.25, 0.50, 1.00], "Use um de: 0.05, 0.10, 0.25, 0.50, 1.00, ou null para sem limite."),
	},
	coding: { verifier: bool("Use verdadeiro ou falso.") },
	reflection: {
		enabled: bool("Use verdadeiro ou falso."),
		memoryChars: intRange(ORCHESTRATOR_MEMORY_MIN_CHARS, ORCHESTRATOR_MEMORY_MAX_CHARS, `Use um inteiro de ${ORCHESTRATOR_MEMORY_MIN_CHARS} a ${ORCHESTRATOR_MEMORY_MAX_CHARS}.`),
		time: {
			message: "Informe um horário no formato HH:MM.",
			parse: (v) => (typeof v === "string" && TIME_HHMM.test(v) ? { value: v } : null),
		},
	},
	general: {
		defaultBotLanguage: oneOf(BOT_LANGUAGES, "Use pt-BR, en-US ou es-ES."),
		timezone: {
			message: "Informe um fuso horário válido (ex.: America/Sao_Paulo).",
			parse: (v) => (isValidTimeZone(v) ? { value: v } : null),
		},
	},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isLeaf = (node: Leaf | Spec): node is Leaf => typeof (node as Leaf).parse === "function";

/**
 * Percorre `raw` pela especificação. Estrito: coleta erros e aceita `null` (remoção).
 * Tolerante: descarta o que não reconhece e não aceita `null`.
 */
function walk(
	spec: Spec,
	raw: Record<string, unknown>,
	path: string,
	mode: { strict: boolean; errors: AccountConfigError[] },
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (mode.strict) {
		for (const key of Object.keys(raw)) {
			if (!(key in spec)) mode.errors.push({ path: path + key, message: "Configuração desconhecida." });
		}
	}
	for (const [key, node] of Object.entries(spec)) {
		if (!Object.hasOwn(raw, key)) continue;
		const value = raw[key];
		const here = path + key;
		if (value === null) {
			if (mode.strict) out[key] = null;
			continue;
		}
		if (isLeaf(node)) {
			const parsed = node.parse(value);
			if (parsed) out[key] = parsed.value;
			else if (mode.strict) mode.errors.push({ path: here, message: node.message });
			continue;
		}
		if (!isRecord(value)) {
			if (mode.strict) mode.errors.push({ path: here, message: "Esperado um objeto." });
			continue;
		}
		const child = walk(node, value, `${here}.`, mode);
		if (mode.strict || Object.keys(child).length > 0) out[key] = child;
	}
	return out;
}

/** Leitura tolerante: qualquer valor vira uma config válida; o que não se reconhece cai fora (herda do env/padrão). */
export function parseAccountConfig(raw: unknown): AccountConfigV1 {
	if (!isRecord(raw) || raw.v !== ACCOUNT_CONFIG_VERSION) return { v: ACCOUNT_CONFIG_VERSION };
	const { v: _v, ...rest } = raw;
	const groups = walk(SPEC, rest, "", { strict: false, errors: [] });
	return { v: ACCOUNT_CONFIG_VERSION, ...groups } as AccountConfigV1;
}

export function accountConfigByteSize(config: unknown): number {
	return new TextEncoder().encode(JSON.stringify(config ?? null)).length;
}

export type AccountConfigPatchResult =
	| { ok: true; patch: AccountConfigPatch }
	| { ok: false; errors: AccountConfigError[] };

/** Escrita estrita: chave desconhecida, tipo/enum/modelo inválido, `v` ≠ 1 ou > 4 KB viram erro por campo. */
export function validateAccountConfigPatch(raw: unknown): AccountConfigPatchResult {
	if (!isRecord(raw)) return { ok: false, errors: [{ path: "config", message: "Esperado um objeto." }] };
	const errors: AccountConfigError[] = [];
	if (accountConfigByteSize(raw) > ACCOUNT_CONFIG_MAX_BYTES) {
		return { ok: false, errors: [{ path: "config", message: `A configuração passa de ${ACCOUNT_CONFIG_MAX_BYTES} bytes.` }] };
	}
	const { v, ...rest } = raw;
	if (v !== undefined && v !== ACCOUNT_CONFIG_VERSION) {
		errors.push({ path: "v", message: `Versão não suportada (use ${ACCOUNT_CONFIG_VERSION}).` });
	}
	const patch = walk(SPEC, rest, "", { strict: true, errors });
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, patch: patch as AccountConfigPatch };
}

function mergeNode(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete out[key];
		} else if (isRecord(value) && isRecord(out[key])) {
			out[key] = mergeNode(out[key] as Record<string, unknown>, value);
		} else if (isRecord(value)) {
			out[key] = mergeNode({}, value);
		} else {
			out[key] = value;
		}
		if (isRecord(out[key]) && Object.keys(out[key] as object).length === 0) delete out[key];
	}
	return out;
}

/** Merge patch: `null` remove a chave, ausente não muda; grupos vazios somem. */
export function mergeAccountConfig(current: unknown, patch: AccountConfigPatch): AccountConfigV1 {
	const base = parseAccountConfig(current) as Record<string, unknown>;
	const { v: _v, ...rest } = patch;
	return { ...mergeNode(base, rest as Record<string, unknown>), v: ACCOUNT_CONFIG_VERSION } as AccountConfigV1;
}
