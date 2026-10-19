import {
	CONTEXT_MEMORIES,
	JEV_FEATURES,
	JEV_MCP_MODES,
	JEV_MODES,
	parseAccountConfig,
	type ContextMemory,
	type JevFeature,
	type JevMcpMode,
	type JevMode,
	type LlmTimeoutPreset,
} from "./account-config.js";
import { hasModelTiers, normalizeModelTiers, type ModelTiers } from "./model-tiers.js";
import type { BotLanguage } from "./bot-language.js";
import { resolveMaintenanceModel } from "./provider-policy.js";

/**
 * Configuração efetiva da conta: usuário > env (padrão do servidor) > padrão do código.
 * Puro: o `env` entra por parâmetro; nada de `process.env` aqui.
 */

export type ConfigSource = "user" | "env" | "default";
export type Resolved<T> = { value: T; source: ConfigSource };
export type ConfigEnv = Record<string, string | undefined>;

export type LlmTimeouts = { totalMs: number; firstEventMs: number; idleMs: number };

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
export const DEFAULT_MAINTENANCE_MODEL = "openai/gpt-6-luna";
export const DEFAULT_LLM_TIMEOUTS: LlmTimeouts = { totalMs: 90_000, firstEventMs: 30_000, idleMs: 20_000 };
export const LLM_TIMEOUT_PRESET_VALUES: Record<LlmTimeoutPreset, LlmTimeouts> = {
	short: { totalMs: 45_000, firstEventMs: 15_000, idleMs: 10_000 },
	default: DEFAULT_LLM_TIMEOUTS,
	extended: { totalMs: 180_000, firstEventMs: 60_000, idleMs: 40_000 },
};

export type EffectiveAccountConfig = {
	providers: { chatgptEnabled: Resolved<boolean> };
	models: {
		default: Resolved<string>;
		fallbacks: Resolved<string[]>;
		/** Revisão de memória: usuário > ATLAS_MAINTENANCE_MODEL > SUMMARIZER_MODEL > padrão. Nunca `chatgpt/*`. */
		maintenance: Resolved<string>;
		/** Resumo da conversa: igual a `maintenance`, mas sem ler ATLAS_MAINTENANCE_MODEL (compatível com o worker de hoje). */
		summary: Resolved<string>;
		vision: Resolved<string | undefined>;
		image: Resolved<string | undefined>;
		/** Modelo para código: usuário > nenhum (o modelo normal do bot segue valendo). */
		coding: Resolved<string | undefined>;
		/** Ditado: usuário > ATLAS_STT_MODEL > padrão do provedor (decidido no servidor; aqui `undefined`). */
		stt: Resolved<string | undefined>;
		/** Modelos por dificuldade: usuário > nenhum (cada nível vazio herda o padrão e as reservas). */
		tiers: Resolved<ModelTiers>;
		/** Classificar a dificuldade com o revisor: usuário > desligado (regras locais). */
		classifyWithReviewer: Resolved<boolean>;
	};
	jev: { mcp: Resolved<JevMcpMode>; features: Record<JevFeature, Resolved<JevMode>> };
	/** Grupos de bots: usuário > GROUPS_JEV_COORDINATION > desligada. */
	groups: { jevCoordination: Resolved<boolean> };
	execution: {
		discipline: Resolved<boolean>;
		/** Responder só com reação quando não precisa de resposta: usuário > ligada. */
		reactionOnly: Resolved<boolean>;
		/** Economia de contexto (tools raras adiadas, prompt por intenção): usuário > ATLAS_CONTEXT_ECONOMY > ligada. */
		contextEconomy: Resolved<boolean>;
		/** Memória da conversa: usuário > Padrão ("standard"). */
		contextMemory: Resolved<ContextMemory>;
		llmTimeouts: Resolved<LlmTimeouts>;
		maxOutputTokens: Resolved<number | undefined>;
		/** Teto inline do resultado de ferramenta: usuário > ATLAS_TOOL_RESULT_MAX_CHARS > nenhum (o runtime usa 20 mil). */
		toolResultMaxChars: Resolved<number | undefined>;
		maxSteps: Resolved<number | undefined>;
		maxWallMinutes: Resolved<number | undefined>;
		maxRunCostUsd: Resolved<number | undefined>;
	};
	sandboxAutoStart: Resolved<boolean>;
	general: { defaultBotLanguage: Resolved<BotLanguage>; timezone: Resolved<string | undefined> };
};

const user = <T>(value: T): Resolved<T> => ({ value, source: "user" });
const env = <T>(value: T): Resolved<T> => ({ value, source: "env" });
const dflt = <T>(value: T): Resolved<T> => ({ value, source: "default" });

const trimmed = (raw: string | undefined): string | undefined => raw?.trim() || undefined;

function envInt(raw: string | undefined, min: number, max: number): number | undefined {
	const text = trimmed(raw);
	if (!text) return undefined;
	const parsed = Number(text);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function envCostUsd(raw: string | undefined): number | undefined {
	const text = trimmed(raw);
	if (!text) return undefined;
	const parsed = parseFloat(text);
	const valid = [0.05, 0.10, 0.25, 0.50, 1.00];
	return valid.includes(Math.round(parsed * 100) / 100) ? Math.round(parsed * 100) / 100 : undefined;
}

function envEnum<T extends string>(raw: string | undefined, options: readonly T[]): T | undefined {
	const value = raw?.trim().toLowerCase();
	return options.find((option) => option === value);
}

function resolveTimeouts(preset: LlmTimeoutPreset | undefined, e: ConfigEnv): Resolved<LlmTimeouts> {
	if (preset) return user({ ...LLM_TIMEOUT_PRESET_VALUES[preset] });
	const total = envInt(e.LLM_DECISION_TIMEOUT_MS, 1, 3_600_000);
	const first = envInt(e.LLM_FIRST_EVENT_TIMEOUT_MS, 1, 3_600_000);
	const idle = envInt(e.LLM_IDLE_TIMEOUT_MS, 1, 3_600_000);
	const value: LlmTimeouts = {
		totalMs: total ?? DEFAULT_LLM_TIMEOUTS.totalMs,
		firstEventMs: first ?? DEFAULT_LLM_TIMEOUTS.firstEventMs,
		idleMs: idle ?? DEFAULT_LLM_TIMEOUTS.idleMs,
	};
	return total !== undefined || first !== undefined || idle !== undefined ? env(value) : dflt(value);
}

function resolveMaintenance(userModel: string | undefined, candidate: string | undefined): Resolved<string> {
	if (userModel) return user(userModel);
	if (candidate) {
		const resolved = resolveMaintenanceModel(candidate, DEFAULT_MAINTENANCE_MODEL);
		return resolved === candidate ? env(resolved) : dflt(resolved);
	}
	return dflt(DEFAULT_MAINTENANCE_MODEL);
}

function resolveJevFeature(
	feature: JevFeature,
	envName: string,
	cfg: ReturnType<typeof parseAccountConfig>,
	e: ConfigEnv,
): Resolved<JevMode> {
	const own = cfg.jev?.features?.[feature];
	if (own) return user(own);
	if (cfg.jev?.all) return user(cfg.jev.all);
	const fromEnv = envEnum(e[envName], JEV_MODES);
	return fromEnv ? env(fromEnv) : dflt("off");
}

/** Env de cada recurso do Jev, como já lido pelo worker e pela API. */
const JEV_FEATURE_ENV: Record<JevFeature, string> = {
	intent: "JEV_INTENT_MODE",
	tools: "JEV_TOOLS_MODE",
	verify: "JEV_VERIFY_MODE",
	blockpage: "JEV_BLOCKPAGE_MODE",
	delegate: "JEV_DELEGATE_MODE",
	stuck: "JEV_STUCK_MODE",
};

export function resolveEffectiveConfig(input: {
	user: { config?: unknown; sandboxAutoStart?: boolean | null };
	env: ConfigEnv;
}): EffectiveAccountConfig {
	const cfg = parseAccountConfig(input.user.config);
	const e = input.env;

	const chatgptEnv = e.ATLAS_PROVIDER_CHATGPT_ENABLED?.trim().toLowerCase();
	const chatgptEnabled =
		cfg.providers?.chatgptEnabled !== undefined
			? user(cfg.providers.chatgptEnabled)
			: chatgptEnv === "true" || chatgptEnv === "false"
				? env(chatgptEnv === "true")
				: dflt(false);

	const envDefaultModel = trimmed(e.OPENROUTER_MODEL);
	const envFallbacks = (e.OPENROUTER_FALLBACK_MODELS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const envVision = trimmed(e.ATLAS_VISION_FALLBACK_MODEL);
	const envImage = trimmed(e.ATLAS_IMAGE_MODEL);
	const envStt = trimmed(e.ATLAS_STT_MODEL);
	const envMaintenance = trimmed(e.ATLAS_MAINTENANCE_MODEL);
	const envSummarizer = trimmed(e.SUMMARIZER_MODEL);

	const discipline = ((): Resolved<boolean> => {
		if (cfg.execution?.discipline !== undefined) return user(cfg.execution.discipline);
		const raw = e.ATLAS_EXECUTION_DISCIPLINE?.trim().toLowerCase();
		if (raw === "off" || raw === "0" || raw === "false") return env(false);
		if (raw === "on" || raw === "1" || raw === "true") return env(true);
		return dflt(true);
	})();

	const contextEconomy = ((): Resolved<boolean> => {
		if (cfg.execution?.contextEconomy !== undefined) return user(cfg.execution.contextEconomy);
		const raw = e.ATLAS_CONTEXT_ECONOMY?.trim().toLowerCase();
		if (raw === "off" || raw === "0" || raw === "false") return env(false);
		if (raw === "on" || raw === "1" || raw === "true") return env(true);
		return dflt(true);
	})();

	const contextMemory: Resolved<ContextMemory> = cfg.execution?.contextMemory
		? user(cfg.execution.contextMemory)
		: dflt("standard");

	const optionalInt = (
		fromUser: number | undefined,
		fromEnv: number | undefined,
	): Resolved<number | undefined> =>
		fromUser !== undefined ? user(fromUser) : fromEnv !== undefined ? env(fromEnv) : dflt(undefined);

	const mcpEnv = envEnum(e.JEV_MCP_MODE, JEV_MCP_MODES);
	const features = Object.fromEntries(
		JEV_FEATURES.map((feature) => [feature, resolveJevFeature(feature, JEV_FEATURE_ENV[feature], cfg, e)]),
	) as Record<JevFeature, Resolved<JevMode>>;

	return {
		providers: { chatgptEnabled },
		models: {
			default: cfg.models?.default
				? user(cfg.models.default)
				: envDefaultModel
					? env(envDefaultModel)
					: dflt(DEFAULT_OPENROUTER_MODEL),
			fallbacks: cfg.models?.fallbacks
				? user(cfg.models.fallbacks)
				: envFallbacks.length > 0
					? env(envFallbacks)
					: dflt([]),
			maintenance: resolveMaintenance(cfg.models?.maintenance, envMaintenance ?? envSummarizer),
			summary: resolveMaintenance(cfg.models?.maintenance, envSummarizer),
			// Sem visão configurada não há modelo de reserva (comportamento de hoje).
			vision: cfg.models?.vision
				? user(cfg.models.vision)
				: envVision
					? env(resolveMaintenanceModel(envVision, DEFAULT_OPENROUTER_MODEL))
					: dflt(undefined),
			image: cfg.models?.image ? user(cfg.models.image) : envImage ? env(envImage) : dflt(undefined),
			coding: cfg.models?.coding ? user(cfg.models.coding) : dflt(undefined),
			stt: cfg.models?.stt ? user(cfg.models.stt) : envStt ? env(envStt) : dflt(undefined),
			tiers: ((): Resolved<ModelTiers> => {
				const tiers = normalizeModelTiers(cfg.models?.tiers);
				return hasModelTiers(tiers) ? user(tiers) : dflt({});
			})(),
			classifyWithReviewer:
				cfg.models?.classifyWithReviewer !== undefined ? user(cfg.models.classifyWithReviewer) : dflt(false),
		},
		jev: {
			mcp: cfg.jev?.mcp ? user(cfg.jev.mcp) : mcpEnv ? env(mcpEnv) : dflt("off"),
			features,
		},
		groups: {
			jevCoordination: ((): Resolved<boolean> => {
				if (cfg.groups?.jevCoordination !== undefined) return user(cfg.groups.jevCoordination);
				const raw = e.GROUPS_JEV_COORDINATION?.trim().toLowerCase();
				if (raw === "on" || raw === "1" || raw === "true") return env(true);
				if (raw === "off" || raw === "0" || raw === "false") return env(false);
				return dflt(false);
			})(),
		},
		execution: {
			discipline,
			reactionOnly: cfg.execution?.reactionOnly !== undefined ? user(cfg.execution.reactionOnly) : dflt(true),
			contextEconomy,
			contextMemory,
			llmTimeouts: resolveTimeouts(cfg.execution?.llmTimeoutPreset, e),
			maxOutputTokens: optionalInt(cfg.execution?.maxOutputTokens, envInt(e.LLM_MAX_OUTPUT_TOKENS, 1, 1_000_000)),
			toolResultMaxChars: optionalInt(cfg.execution?.toolResultMaxChars, envInt(e.ATLAS_TOOL_RESULT_MAX_CHARS, 1_000, 1_000_000)),
			maxSteps: optionalInt(cfg.execution?.maxSteps, undefined),
			maxWallMinutes: optionalInt(cfg.execution?.maxWallMinutes, undefined),
			maxRunCostUsd: ((): Resolved<number | undefined> => {
				if (cfg.execution?.maxRunCostUsd !== undefined && cfg.execution.maxRunCostUsd !== null) {
					return user(cfg.execution.maxRunCostUsd);
				}
				const fromEnv = envCostUsd(e.ATLAS_MAX_RUN_COST_USD);
				if (fromEnv !== undefined) return env(fromEnv);
				return dflt(0.25);
			})(),
		},
		sandboxAutoStart:
			typeof input.user.sandboxAutoStart === "boolean" ? user(input.user.sandboxAutoStart) : dflt(true),
		general: {
			defaultBotLanguage: cfg.general?.defaultBotLanguage
				? user(cfg.general.defaultBotLanguage)
				: dflt("pt-BR"),
			timezone: cfg.general?.timezone ? user(cfg.general.timezone) : dflt(undefined),
		},
	};
}

/**
 * Valores planos congelados no run (`checkpointJson.configSnapshot`): o run
 * inteiro, inclusive retomadas e subagentes, usa estes valores mesmo que a
 * conta mude no meio.
 */
export type RunConfigSnapshot = {
	v: 1;
	chatgptEnabled: boolean;
	fallbackModels: string[];
	visionModel?: string;
	imageModel?: string;
	/** Modelo para código da conta (o do bot, quando existe, vence no worker). */
	codingModel?: string;
	/** Modelos por dificuldade da conta; ausente = nenhum nível configurado. */
	modelTiers?: ModelTiers;
	/** Dificuldade classificada pelo revisor (Jev); ausente = regras locais. */
	classifyWithReviewer?: boolean;
	jevMcpMode: JevMcpMode;
	jevModes: Record<JevFeature, JevMode>;
	executionDiscipline: boolean;
	/** Ausente em snapshot antigo: o runtime cai no env (`ATLAS_CONTEXT_ECONOMY`). */
	contextEconomy?: boolean;
	/** Ausente em snapshot antigo: o runtime assume Padrão. */
	contextMemory?: ContextMemory;
	llmTimeouts: LlmTimeouts;
	maxOutputTokens?: number;
	/** Ausente: o runtime usa o padrão de 20 mil caracteres. */
	toolResultMaxChars?: number;
	maxSteps?: number;
	maxWallMinutes?: number;
	/** Ausente em snapshot antigo: o runtime usa default 0.25. */
	maxRunCostUsd?: number;
	sandboxAutoStart: boolean;
};

export function toRunConfigSnapshot(effective: EffectiveAccountConfig): RunConfigSnapshot {
	const snapshot: RunConfigSnapshot = {
		v: 1,
		chatgptEnabled: effective.providers.chatgptEnabled.value,
		fallbackModels: effective.models.fallbacks.value,
		jevMcpMode: effective.jev.mcp.value,
		jevModes: Object.fromEntries(
			JEV_FEATURES.map((feature) => [feature, effective.jev.features[feature].value]),
		) as Record<JevFeature, JevMode>,
		executionDiscipline: effective.execution.discipline.value,
		contextEconomy: effective.execution.contextEconomy.value,
		contextMemory: effective.execution.contextMemory.value,
		llmTimeouts: effective.execution.llmTimeouts.value,
		sandboxAutoStart: effective.sandboxAutoStart.value,
	};
	if (effective.models.vision.value) snapshot.visionModel = effective.models.vision.value;
	if (effective.models.image.value) snapshot.imageModel = effective.models.image.value;
	if (effective.models.coding.value) snapshot.codingModel = effective.models.coding.value;
	if (hasModelTiers(effective.models.tiers.value)) snapshot.modelTiers = effective.models.tiers.value;
	if (effective.models.classifyWithReviewer.value) snapshot.classifyWithReviewer = true;
	if (effective.execution.maxOutputTokens.value !== undefined)
		snapshot.maxOutputTokens = effective.execution.maxOutputTokens.value;
	if (effective.execution.toolResultMaxChars.value !== undefined)
		snapshot.toolResultMaxChars = effective.execution.toolResultMaxChars.value;
	if (effective.execution.maxSteps.value !== undefined) snapshot.maxSteps = effective.execution.maxSteps.value;
	if (effective.execution.maxWallMinutes.value !== undefined)
		snapshot.maxWallMinutes = effective.execution.maxWallMinutes.value;
	if (effective.execution.maxRunCostUsd.value !== undefined)
		snapshot.maxRunCostUsd = effective.execution.maxRunCostUsd.value;
	return snapshot;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;
const positiveNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
	value === undefined || check(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Lê o snapshot do checkpoint. Qualquer inconsistência = `null` (o worker resolve de novo). */
export function parseRunConfigSnapshot(raw: unknown): RunConfigSnapshot | null {
	if (!isRecord(raw) || raw.v !== 1) return null;
	const timeouts = raw.llmTimeouts;
	const modes = raw.jevModes;
	if (
		typeof raw.chatgptEnabled !== "boolean" ||
		typeof raw.executionDiscipline !== "boolean" ||
		typeof raw.sandboxAutoStart !== "boolean" ||
		!Array.isArray(raw.fallbackModels) ||
		!raw.fallbackModels.every(nonEmptyString) ||
		!(JEV_MCP_MODES as readonly unknown[]).includes(raw.jevMcpMode) ||
		!isRecord(timeouts) ||
		!positiveInt(timeouts.totalMs) ||
		!positiveInt(timeouts.firstEventMs) ||
		!positiveInt(timeouts.idleMs) ||
		!isRecord(modes) ||
		!JEV_FEATURES.every((f) => (JEV_MODES as readonly unknown[]).includes(modes[f])) ||
		!optional(raw.contextEconomy, (v) => typeof v === "boolean") ||
		!optional(raw.contextMemory, (v) => (CONTEXT_MEMORIES as readonly unknown[]).includes(v)) ||
		!optional(raw.visionModel, nonEmptyString) ||
		!optional(raw.imageModel, nonEmptyString) ||
		!optional(raw.codingModel, nonEmptyString) ||
		!optional(raw.modelTiers, isRecord) ||
		!optional(raw.classifyWithReviewer, (v) => typeof v === "boolean") ||
		!optional(raw.maxOutputTokens, positiveInt) ||
		!optional(raw.toolResultMaxChars, positiveInt) ||
		!optional(raw.maxSteps, positiveInt) ||
		!optional(raw.maxWallMinutes, positiveInt) ||
		!optional(raw.maxRunCostUsd, positiveNumber)
	)
		return null;
	return raw as unknown as RunConfigSnapshot;
}
