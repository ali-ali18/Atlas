import {
	CONTEXT_MEMORIES,
	LLM_TIMEOUT_PRESETS,
	LLM_TIMEOUT_PRESET_VALUES,
	MAX_OUTPUT_TOKEN_PRESETS,
	TOOL_RESULT_MAX_CHARS_PRESETS,
	type AccountConfigPatch,
	type AccountConfigV1,
	type ContextMemory,
	type JevFeature,
	type JevMcpMode,
	type JevMode,
	type LlmTimeoutPreset,
	type LlmTimeouts,
	type Resolved,
} from "@workspace/shared";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { inheritLabel } from "./account-settings-state";
import type { SettingsPickerOption } from "@/components/ui/templates/template-4/settings-picker";

/**
 * Jev e Execução: presets e rótulos das opções, mapeados para os valores do
 * contrato (`AccountConfigV1`). Puro: sem React, sem rede.
 */

export const INHERIT = "inherit";
export type Inherit = typeof INHERIT;

// ---------------------------------------------------------------- Jev

/** Rótulos e descrições no idioma da tela (pt-BR por padrão, para chamadas e testes antigos). */
export const jevModeLabel = (mode: JevMode, { t }: Translator = defaultTranslator): string =>
	t(({ off: "settings.jev.mode.off", shadow: "settings.jev.mode.shadow", on: "settings.jev.mode.on" } as const)[mode]);

export const jevMcpModeLabel = (mode: JevMcpMode, { t }: Translator = defaultTranslator): string =>
	t(({ off: "settings.jev.mode.off", shadow: "settings.jev.mode.shadow", gate: "settings.jev.mode.gate" } as const)[mode]);

export const jevModeDescription = (mode: JevMode, { t }: Translator = defaultTranslator): string =>
	t(({ off: "settings.jev.mode.offDescription", shadow: "settings.jev.mode.shadowDescription", on: "settings.jev.mode.onDescription" } as const)[mode]);

export const jevMcpModeDescription = (mode: JevMcpMode, { t }: Translator = defaultTranslator): string =>
	t(({ off: "settings.jev.mcp.offDescription", shadow: "settings.jev.mcp.shadowDescription", gate: "settings.jev.mcp.gateDescription" } as const)[mode]);

export type JevFeatureSpec = {
	feature: JevFeature;
	/** Id da configuração na busca do modal. */
	itemId: string;
	label: string;
	/** Uma linha, sem jargão. */
	description: string;
};

const JEV_FEATURE_ITEMS: ReadonlyArray<{ feature: JevFeature; itemId: string }> = [
	{ feature: "intent", itemId: "jev.intencao" },
	{ feature: "tools", itemId: "jev.tools" },
	{ feature: "verify", itemId: "jev.verificacao" },
	{ feature: "blockpage", itemId: "jev.bloqueio" },
	{ feature: "delegate", itemId: "jev.delegacao" },
	{ feature: "stuck", itemId: "jev.travamento" },
	{ feature: "memory", itemId: "jev.memoria" },
];

const JEV_FEATURE_TEXT = {
	intent: { label: "settings.jev.feature.intent.label", description: "settings.jev.feature.intent.description" },
	tools: { label: "settings.jev.feature.tools.label", description: "settings.jev.feature.tools.description" },
	verify: { label: "settings.jev.feature.verify.label", description: "settings.jev.feature.verify.description" },
	blockpage: { label: "settings.jev.feature.blockpage.label", description: "settings.jev.feature.blockpage.description" },
	delegate: { label: "settings.jev.feature.delegate.label", description: "settings.jev.feature.delegate.description" },
	stuck: { label: "settings.jev.feature.stuck.label", description: "settings.jev.feature.stuck.description" },
	memory: { label: "settings.jev.feature.memory.label", description: "settings.jev.feature.memory.description" },
} as const;

/** Recursos do revisor, com nome e descrição no idioma da tela. */
export function jevFeatureSpecs({ t }: Translator = defaultTranslator): readonly JevFeatureSpec[] {
	return JEV_FEATURE_ITEMS.map(({ feature, itemId }) => ({
		feature,
		itemId,
		label: t(JEV_FEATURE_TEXT[feature].label),
		description: t(JEV_FEATURE_TEXT[feature].description),
	}));
}

export const JEV_FEATURE_SPECS: readonly JevFeatureSpec[] = jevFeatureSpecs();

const JEV_MODE_ORDER: readonly JevMode[] = ["off", "shadow", "on"];
const JEV_MCP_ORDER: readonly JevMcpMode[] = ["off", "shadow", "gate"];

const jevOptions = (inherit: string, translator: Translator): SettingsPickerOption<JevMode | Inherit>[] => [
	{ value: INHERIT, label: inherit },
	...JEV_MODE_ORDER.map((mode) => ({
		value: mode,
		label: jevModeLabel(mode, translator),
		description: jevModeDescription(mode, translator),
	})),
];

export function jevMcpOptions(mcp: Resolved<JevMcpMode>, translator: Translator = defaultTranslator): SettingsPickerOption<JevMcpMode | Inherit>[] {
	const { t } = translator;
	return [
		{ value: INHERIT, label: inheritLabel(mcp.source, jevMcpModeLabel(mcp.value, translator), t) ?? t("settings.exec.inherit") },
		...JEV_MCP_ORDER.map((mode) => ({
			value: mode,
			label: jevMcpModeLabel(mode, translator),
			description: jevMcpModeDescription(mode, translator),
		})),
	];
}

export const jevMcpChoice = (mcp: Resolved<JevMcpMode>): JevMcpMode | Inherit =>
	mcp.source === "user" ? mcp.value : INHERIT;

export function jevMcpPatch(choice: JevMcpMode | Inherit): AccountConfigPatch {
	return { jev: { mcp: choice === INHERIT ? null : choice } };
}

/** Geral: o servidor não tem um valor único para "todos", então herdar é só voltar ao padrão de cada recurso. */
export function jevGeneralOptions(translator: Translator = defaultTranslator): SettingsPickerOption<JevMode | Inherit>[] {
	return jevOptions(translator.t("settings.exec.inheritServer"), translator);
}

export const jevGeneralChoice = (config: AccountConfigV1): JevMode | Inherit => config.jev?.all ?? INHERIT;

export function jevGeneralPatch(choice: JevMode | Inherit): AccountConfigPatch {
	return { jev: { all: choice === INHERIT ? null : choice } };
}

/** "Herdar" de um recurso: do geral da conta, quando definido; senão do servidor ou da conta. */
export function jevFeatureOptions(
	config: AccountConfigV1,
	resolved: Resolved<JevMode>,
	translator: Translator = defaultTranslator,
): SettingsPickerOption<JevMode | Inherit>[] {
	const { t } = translator;
	const general = config.jev?.all;
	const label = general
		? t("settings.jev.inheritGeneral", { mode: jevModeLabel(general, translator) })
		: (inheritLabel(resolved.source, jevModeLabel(resolved.value, translator), t) ?? t("settings.exec.inherit"));
	return jevOptions(label, translator);
}

export const jevFeatureChoice = (config: AccountConfigV1, feature: JevFeature): JevMode | Inherit =>
	config.jev?.features?.[feature] ?? INHERIT;

export function jevFeaturePatch(feature: JevFeature, choice: JevMode | Inherit): AccountConfigPatch {
	return { jev: { features: { [feature]: choice === INHERIT ? null : choice } } };
}

// ---------------------------------------------------------------- Execução

export const timeoutPresetLabel = (preset: LlmTimeoutPreset, { t }: Translator = defaultTranslator): string =>
	t(({ short: "settings.exec.timeout.short", default: "settings.exec.timeout.default", extended: "settings.exec.timeout.extended" } as const)[preset]);

const timeoutPresetDescription = (preset: LlmTimeoutPreset, { t }: Translator): string =>
	t(
		({
			short: "settings.exec.timeout.shortDescription",
			default: "settings.exec.timeout.defaultDescription",
			extended: "settings.exec.timeout.extendedDescription",
		} as const)[preset],
	);

/** Preset que bate com os prazos herdados (para mostrar em "Herdar"); `null` = prazos personalizados no servidor. */
export function timeoutPresetOf(timeouts: LlmTimeouts): LlmTimeoutPreset | null {
	return (
		LLM_TIMEOUT_PRESETS.find((preset) => {
			const values = LLM_TIMEOUT_PRESET_VALUES[preset];
			return (
				values.totalMs === timeouts.totalMs &&
				values.firstEventMs === timeouts.firstEventMs &&
				values.idleMs === timeouts.idleMs
			);
		}) ?? null
	);
}

export function timeoutOptions(
	timeouts: Resolved<LlmTimeouts>,
	translator: Translator = defaultTranslator,
): SettingsPickerOption<LlmTimeoutPreset | Inherit>[] {
	const { t } = translator;
	const preset = timeoutPresetOf(timeouts.value);
	const label = preset ? timeoutPresetLabel(preset, translator).toLowerCase() : t("settings.exec.custom");
	return [
		{ value: INHERIT, label: inheritLabel(timeouts.source, label, t) ?? t("settings.exec.inherit") },
		...LLM_TIMEOUT_PRESETS.map((value) => ({
			value,
			label: timeoutPresetLabel(value, translator),
			description: timeoutPresetDescription(value, translator),
		})),
	];
}

export const timeoutChoice = (timeouts: Resolved<LlmTimeouts>): LlmTimeoutPreset | Inherit =>
	timeouts.source === "user" ? (timeoutPresetOf(timeouts.value) ?? INHERIT) : INHERIT;

/** Passos: o teto duro do run é 300; sem escolha, vale o do código. */
export const CODE_DEFAULT_MAX_STEPS = 300;
export const STEPS_PRESETS: readonly number[] = [100, 200, 300, 500];
/** Minutos: sem escolha, o run tem 30 min. */
export const WALL_MINUTES_PRESETS: readonly number[] = [5, 10, 15, 30, 60, 120];
export const CODE_DEFAULT_WALL_MINUTES = 30;
/** Custo USD: sem escolha, o run tem limite de 0.25. */
export const RUN_COST_PRESETS: readonly number[] = [0.05, 0.10, 0.25, 0.50, 1.00];
export const CODE_DEFAULT_RUN_COST_USD = 0.25;

export const formatOutputTokens = (tokens: number, { t }: Translator = defaultTranslator): string => t("settings.exec.fmtTokens", { n: tokens / 1024 });
export const formatSteps = (steps: number, { t }: Translator = defaultTranslator): string => t("settings.exec.fmtSteps", { n: steps });
export function formatMinutes(minutes: number, { t }: Translator = defaultTranslator): string {
	if (minutes < 60) return t("settings.exec.fmtMinutes", { n: minutes });
	return minutes % 60 === 0 ? t("settings.exec.fmtHours", { n: minutes / 60 }) : t("settings.exec.fmtMinutes", { n: minutes });
}
export const formatCostUsd = (cost: number): string => `US$ ${cost.toFixed(2)}`;
export const formatCostUsdNone = (translator: Translator = defaultTranslator): string => translator.t("settings.exec.noLimitCap");

export type NumberSettingSpec = {
	/** Presets do contrato; um valor salvo fora da lista (via API) continua aparecendo. */
	presets: readonly number[];
	format: (value: number, translator?: Translator) => string;
	/** Valor do código quando ninguém definiu nada. */
	codeDefault?: number;
};

export const MAX_OUTPUT_SPEC: NumberSettingSpec = {
	presets: MAX_OUTPUT_TOKEN_PRESETS,
	format: formatOutputTokens,
};
export const formatToolResultChars = (chars: number, { t }: Translator = defaultTranslator): string => t("settings.exec.fmtChars", { n: chars / 1000 });
export const TOOL_RESULT_SPEC: NumberSettingSpec = {
	presets: TOOL_RESULT_MAX_CHARS_PRESETS,
	format: formatToolResultChars,
	codeDefault: 20_000,
};
export const MAX_STEPS_SPEC: NumberSettingSpec = {
	presets: STEPS_PRESETS,
	format: formatSteps,
	codeDefault: CODE_DEFAULT_MAX_STEPS,
};
export const MAX_WALL_SPEC: NumberSettingSpec = {
	presets: WALL_MINUTES_PRESETS,
	format: formatMinutes,
	codeDefault: CODE_DEFAULT_WALL_MINUTES,
};
export const MAX_COST_SPEC: NumberSettingSpec = {
	presets: RUN_COST_PRESETS,
	format: formatCostUsd,
	codeDefault: CODE_DEFAULT_RUN_COST_USD,
};

/** Opções "Herdar + presets"; o texto de "Herdar" mostra a origem e o valor herdado. */
export function numberOptions(
	spec: NumberSettingSpec,
	resolved: Resolved<number | undefined>,
	noneLabel: string,
	translator: Translator = defaultTranslator,
): SettingsPickerOption<string>[] {
	const { t } = translator;
	const inheritedValue = resolved.value ?? spec.codeDefault;
	const shown = inheritedValue === undefined ? noneLabel : spec.format(inheritedValue, translator);
	// Com valor do usuário, o herdado não é conhecido aqui: "Herdar" simples.
	const inherit = resolved.source === "user" ? t("settings.exec.inheritServer") : (inheritLabel(resolved.source, shown, t) ?? t("settings.exec.inherit"));
	const stored = resolved.source === "user" ? resolved.value : undefined;
	const values = stored !== undefined && !spec.presets.includes(stored) ? [...spec.presets, stored].sort((a, b) => a - b) : spec.presets;
	return [
		{ value: INHERIT, label: inherit },
		...values.map((value) => ({ value: String(value), label: spec.format(value, translator) })),
	];
}

export const numberChoice = (resolved: Resolved<number | undefined>): string =>
	resolved.source === "user" && resolved.value !== undefined ? String(resolved.value) : INHERIT;

export type ExecutionNumberKey = "maxOutputTokens" | "toolResultMaxChars" | "maxSteps" | "maxWallMinutes" | "maxRunCostUsd";

export function numberPatch(key: ExecutionNumberKey, choice: string): AccountConfigPatch {
	return { execution: { [key]: choice === INHERIT ? null : Number(choice) } };
}

export function groupsJevPatch(enabled: boolean): AccountConfigPatch {
	return { groups: { jevCoordination: enabled } };
}

export function disciplinePatch(enabled: boolean): AccountConfigPatch {
	return { execution: { discipline: enabled } };
}

export function contextEconomyPatch(enabled: boolean): AccountConfigPatch {
	return { execution: { contextEconomy: enabled } };
}

export function reactionOnlyPatch(enabled: boolean): AccountConfigPatch {
	return { execution: { reactionOnly: enabled } };
}

const contextMemoryLabel = (value: ContextMemory, { t }: Translator): string =>
	t(({ standard: "settings.exec.memory.standard", economy: "settings.exec.memory.economy" } as const)[value]);

const contextMemoryDescription = (value: ContextMemory, { t }: Translator): string =>
	t(({ standard: "settings.exec.memory.standardDescription", economy: "settings.exec.memory.economyDescription" } as const)[value]);

/** Uma linha sob o rótulo; o texto inteiro fica só nos itens do menu. */
export const contextMemoryShort = (value: ContextMemory, { t }: Translator = defaultTranslator): string =>
	t(({ standard: "settings.exec.memory.standardShort", economy: "settings.exec.memory.economyShort" } as const)[value]);

export function contextMemoryOptions(translator: Translator = defaultTranslator): SettingsPickerOption<ContextMemory>[] {
	return CONTEXT_MEMORIES.map((value) => ({
		value,
		label: contextMemoryLabel(value, translator),
		description: contextMemoryDescription(value, translator),
	}));
}

export function contextMemoryPatch(choice: ContextMemory): AccountConfigPatch {
	return { execution: { contextMemory: choice } };
}

export function timeoutPatch(choice: LlmTimeoutPreset | Inherit): AccountConfigPatch {
	return { execution: { llmTimeoutPreset: choice === INHERIT ? null : choice } };
}

/** Estado herdado de um switch ("Padrão do servidor: ligado"); `null` quando o valor é do usuário. */
export function switchInheritNote(resolved: Resolved<boolean>, { t }: Translator = defaultTranslator): string | null {
	if (resolved.source === "user") return null;
	const value = resolved.value ? t("settings.exec.on") : t("settings.exec.off");
	return resolved.source === "env" ? t("settings.exec.noteServer", { value }) : t("settings.exec.noteAccount", { value });
}
