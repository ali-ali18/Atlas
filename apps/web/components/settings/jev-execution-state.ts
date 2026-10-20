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
import { inheritLabel } from "./account-settings-state";
import type { SettingsPickerOption } from "@/components/ui/templates/template-4/settings-picker";

/**
 * Jev e Execução: presets e rótulos das opções, mapeados para os valores do
 * contrato (`AccountConfigV1`). Puro: sem React, sem rede.
 */

export const INHERIT = "inherit";
export type Inherit = typeof INHERIT;

// ---------------------------------------------------------------- Jev

export const JEV_MODE_LABELS: Record<JevMode, string> = {
	off: "Desligado",
	shadow: "Observar",
	on: "Ativo",
};

export const JEV_MCP_MODE_LABELS: Record<JevMcpMode, string> = {
	off: "Desligado",
	shadow: "Observar",
	gate: "Bloquear",
};

export const JEV_MODE_DESCRIPTIONS: Record<JevMode, string> = {
	off: "Não faz nada.",
	shadow: "Registra o que faria, sem mudar o resultado.",
	on: "Age de verdade.",
};

export const JEV_MCP_MODE_DESCRIPTIONS: Record<JevMcpMode, string> = {
	off: "Não revisa.",
	shadow: "Registra a revisão, sem impedir nada.",
	gate: "Impede a escrita quando a revisão reprova.",
};

export type JevFeatureSpec = {
	feature: JevFeature;
	/** Id da configuração na busca do modal. */
	itemId: string;
	label: string;
	/** Uma linha, sem jargão. */
	description: string;
};

export const JEV_FEATURE_SPECS: readonly JevFeatureSpec[] = [
	{ feature: "intent", itemId: "jev.intencao", label: "Intenção", description: "Entende o que você pediu antes de agir." },
	{ feature: "tools", itemId: "jev.tools", label: "Seleção de tools", description: "Escolhe quais ferramentas o agente pode usar." },
	{ feature: "verify", itemId: "jev.verificacao", label: "Verificação da resposta", description: "Confere se a resposta final cumpre o pedido." },
	{ feature: "blockpage", itemId: "jev.bloqueio", label: "Página de bloqueio", description: "Reconhece páginas bloqueadas, como captcha e login." },
	{ feature: "delegate", itemId: "jev.delegacao", label: "Delegação", description: "Decide quando passar uma tarefa para um subagente." },
	{ feature: "stuck", itemId: "jev.travamento", label: "Travamento", description: "Percebe quando o agente está em círculos." },
	{ feature: "memory", itemId: "jev.memoria", label: "Porteiro da memória", description: "Decide se um fato novo vale ser guardado na memória." },
];

const JEV_MODE_ORDER: readonly JevMode[] = ["off", "shadow", "on"];
const JEV_MCP_ORDER: readonly JevMcpMode[] = ["off", "shadow", "gate"];

const jevOptions = (inherit: string): SettingsPickerOption<JevMode | Inherit>[] => [
	{ value: INHERIT, label: inherit },
	...JEV_MODE_ORDER.map((mode) => ({
		value: mode,
		label: JEV_MODE_LABELS[mode],
		description: JEV_MODE_DESCRIPTIONS[mode],
	})),
];

export function jevMcpOptions(mcp: Resolved<JevMcpMode>): SettingsPickerOption<JevMcpMode | Inherit>[] {
	return [
		{ value: INHERIT, label: inheritLabel(mcp.source, JEV_MCP_MODE_LABELS[mcp.value]) ?? "Herdar" },
		...JEV_MCP_ORDER.map((mode) => ({
			value: mode,
			label: JEV_MCP_MODE_LABELS[mode],
			description: JEV_MCP_MODE_DESCRIPTIONS[mode],
		})),
	];
}

export const jevMcpChoice = (mcp: Resolved<JevMcpMode>): JevMcpMode | Inherit =>
	mcp.source === "user" ? mcp.value : INHERIT;

export function jevMcpPatch(choice: JevMcpMode | Inherit): AccountConfigPatch {
	return { jev: { mcp: choice === INHERIT ? null : choice } };
}

/** Geral: o servidor não tem um valor único para "todos", então herdar é só voltar ao padrão de cada recurso. */
export function jevGeneralOptions(): SettingsPickerOption<JevMode | Inherit>[] {
	return jevOptions("Herdar do servidor");
}

export const jevGeneralChoice = (config: AccountConfigV1): JevMode | Inherit => config.jev?.all ?? INHERIT;

export function jevGeneralPatch(choice: JevMode | Inherit): AccountConfigPatch {
	return { jev: { all: choice === INHERIT ? null : choice } };
}

/** "Herdar" de um recurso: do geral da conta, quando definido; senão do servidor ou da conta. */
export function jevFeatureOptions(
	config: AccountConfigV1,
	resolved: Resolved<JevMode>,
): SettingsPickerOption<JevMode | Inherit>[] {
	const general = config.jev?.all;
	const label = general
		? `Herdar (geral: ${JEV_MODE_LABELS[general]})`
		: (inheritLabel(resolved.source, JEV_MODE_LABELS[resolved.value]) ?? "Herdar");
	return jevOptions(label);
}

export const jevFeatureChoice = (config: AccountConfigV1, feature: JevFeature): JevMode | Inherit =>
	config.jev?.features?.[feature] ?? INHERIT;

export function jevFeaturePatch(feature: JevFeature, choice: JevMode | Inherit): AccountConfigPatch {
	return { jev: { features: { [feature]: choice === INHERIT ? null : choice } } };
}

// ---------------------------------------------------------------- Execução

export const TIMEOUT_PRESET_LABELS: Record<LlmTimeoutPreset, string> = {
	short: "Curto",
	default: "Padrão",
	extended: "Estendido",
};

const TIMEOUT_PRESET_DESCRIPTIONS: Record<LlmTimeoutPreset, string> = {
	short: "Desiste cedo de um modelo lento e tenta outro.",
	default: "Equilibrado, o padrão de fábrica.",
	extended: "Espera mais, para modelos lentos ou raciocínio longo.",
};

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

export function timeoutOptions(timeouts: Resolved<LlmTimeouts>): SettingsPickerOption<LlmTimeoutPreset | Inherit>[] {
	const preset = timeoutPresetOf(timeouts.value);
	const label = preset ? TIMEOUT_PRESET_LABELS[preset].toLowerCase() : "personalizado";
	return [
		{ value: INHERIT, label: inheritLabel(timeouts.source, label) ?? "Herdar" },
		...LLM_TIMEOUT_PRESETS.map((value) => ({
			value,
			label: TIMEOUT_PRESET_LABELS[value],
			description: TIMEOUT_PRESET_DESCRIPTIONS[value],
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

export const formatOutputTokens = (tokens: number): string => `${tokens / 1024}k tokens`;
export const formatSteps = (steps: number): string => `${steps} passos`;
export function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes} min`;
	return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}
export const formatCostUsd = (cost: number): string => `US$ ${cost.toFixed(2)}`;
export const formatCostUsdNone = "Sem limite";

export type NumberSettingSpec = {
	/** Presets do contrato; um valor salvo fora da lista (via API) continua aparecendo. */
	presets: readonly number[];
	format: (value: number) => string;
	/** Valor do código quando ninguém definiu nada. */
	codeDefault?: number;
};

export const MAX_OUTPUT_SPEC: NumberSettingSpec = {
	presets: MAX_OUTPUT_TOKEN_PRESETS,
	format: formatOutputTokens,
};
export const formatToolResultChars = (chars: number): string => `${chars / 1000} mil caracteres`;
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
): SettingsPickerOption<string>[] {
	const inheritedValue = resolved.value ?? spec.codeDefault;
	const shown = inheritedValue === undefined ? noneLabel : spec.format(inheritedValue);
	// Com valor do usuário, o herdado não é conhecido aqui: "Herdar" simples.
	const inherit = resolved.source === "user" ? "Herdar do servidor" : (inheritLabel(resolved.source, shown) ?? "Herdar");
	const stored = resolved.source === "user" ? resolved.value : undefined;
	const values = stored !== undefined && !spec.presets.includes(stored) ? [...spec.presets, stored].sort((a, b) => a - b) : spec.presets;
	return [
		{ value: INHERIT, label: inherit },
		...values.map((value) => ({ value: String(value), label: spec.format(value) })),
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

export const CONTEXT_MEMORY_LABELS: Record<ContextMemory, string> = {
	standard: "Padrão",
	economy: "Econômico",
};

export const CONTEXT_MEMORY_DESCRIPTIONS: Record<ContextMemory, string> = {
	standard: "Mantém a conversa inteira até perto do limite do modelo e resume quando precisa. Melhor qualidade; conversas longas custam mais.",
	economy: "Enxuga cedo para gastar menos. Pode esquecer detalhes de conversas longas.",
};

/** Uma linha sob o rótulo; o texto inteiro fica só nos itens do menu. */
export const CONTEXT_MEMORY_SHORT: Record<ContextMemory, string> = {
	standard: "Resume perto do limite do modelo",
	economy: "Enxuga cedo para gastar menos",
};

export function contextMemoryOptions(): SettingsPickerOption<ContextMemory>[] {
	return CONTEXT_MEMORIES.map((value) => ({
		value,
		label: CONTEXT_MEMORY_LABELS[value],
		description: CONTEXT_MEMORY_DESCRIPTIONS[value],
	}));
}

export function contextMemoryPatch(choice: ContextMemory): AccountConfigPatch {
	return { execution: { contextMemory: choice } };
}

export function timeoutPatch(choice: LlmTimeoutPreset | Inherit): AccountConfigPatch {
	return { execution: { llmTimeoutPreset: choice === INHERIT ? null : choice } };
}

/** Estado herdado de um switch ("Padrão do servidor: ligado"); `null` quando o valor é do usuário. */
export function switchInheritNote(resolved: Resolved<boolean>): string | null {
	if (resolved.source === "user") return null;
	const origin = resolved.source === "env" ? "Padrão do servidor" : "Padrão da conta";
	return `${origin}: ${resolved.value ? "ligado" : "desligado"}`;
}
