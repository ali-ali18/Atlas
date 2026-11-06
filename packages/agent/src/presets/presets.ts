// Presets do motor v4 (03 §8): dados, não código. Dizem quais capacidades entram e se o contrato de trabalho
// vai no prompt estável. `minimal` é o preset do teste de fumaça e do eval; `full` cresce com as fases.
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { createCapabilityRegistry } from "../capabilities/registry.js";
import { createDeliverablesCapability } from "../capabilities-builtin/deliverables/index.js";
import { createResearchCapability } from "../capabilities-builtin/research/index.js";
import type { DeliverablePorts } from "../ports/deliverables.js";
import { createMemoryCapability } from "../capabilities/memory/index.js";
import { createSettingsCapability } from "../capabilities/settings/index.js";
import { createTasksCapability } from "../capabilities/tasks/index.js";
import type { FileStore } from "../ports/file-store.js";
import type { Helpers } from "../ports/helpers.js";
import type { Memory } from "../ports/memory.js";
import type { Search } from "../ports/search.js";
import type { Settings } from "../ports/settings.js";
import type { TaskListStore } from "../ports/task-list.js";
import { buildStablePrompt } from "../prompt/work-contract.js";
import { createDeliverablesLiteCapability } from "./deliverables-lite.js";
import { createWebCapability } from "./web.js";

export const PRESET_IDS = ["minimal", "full"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type CapabilityId = "web" | "deliverables-lite" | "memory" | "tasks" | "settings" | "research";

export type AgentPreset = {
	id: PresetId;
	/** Capacidades registradas. As não-núcleo (memory, tasks, settings) são lazy: só o índice vai no prompt. */
	capabilities: readonly CapabilityId[];
	/** O contrato de trabalho entra no prompt estável? */
	workContract: boolean;
};

export const PRESETS: Readonly<Record<PresetId, AgentPreset>> = Object.freeze({
	minimal: Object.freeze({ id: "minimal", capabilities: Object.freeze(["web", "deliverables-lite"] as const), workContract: false }),
	full: Object.freeze({ id: "full", capabilities: Object.freeze(["web", "deliverables-lite", "memory", "tasks", "settings", "research"] as const), workContract: true }),
});

/**
 * `memory`, `settings` e `taskLists` são opcionais: a capacidade cuja porta falta não entra (e `setupPreset` a lista em
 * `unavailable`). `deliverables` (F2.3): com as portas, a capacidade lazy `deliverables` (docx, pdf, xlsx, pptx, painel,
 * gráfico) entra no lugar da `deliverables-lite`; sem elas, segue a versão mínima de texto.
 */
export type PresetDeps = {
	search: Search;
	files: FileStore;
	deliverables?: DeliverablePorts;
	memory?: Memory;
	settings?: Settings;
	taskLists?: TaskListStore;
	/** Ajudantes (F3.1): runs filhos do próprio kernel. A capacidade `research` (frente R) os recebe aqui; o worker monta por run. */
	helpers?: Helpers;
};

export function isPresetId(value: unknown): value is PresetId {
	return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

type CapabilityFactory = (deps: PresetDeps) => ReturnType<typeof createWebCapability> | undefined;

const FACTORIES: Readonly<Record<CapabilityId, CapabilityFactory>> = {
	web: (deps) => createWebCapability(deps.search),
	"deliverables-lite": (deps) => (deps.deliverables ? createDeliverablesCapability(deps.deliverables) : createDeliverablesLiteCapability(deps.files)),
	memory: (deps) => deps.memory && createMemoryCapability(deps.memory),
	tasks: (deps) => deps.taskLists && createTasksCapability(deps.taskLists),
	settings: (deps) => deps.settings && createSettingsCapability(deps.settings),
	// F3.2: pesquisa em plano; só entra quando a porta dos ajudantes existe (a frente H a implementa).
	research: (deps) => deps.helpers && createResearchCapability(deps.helpers),
};

/** Capacidades do preset que não entram por falta da porta. */
export function unavailableCapabilities(preset: AgentPreset, deps: PresetDeps): CapabilityId[] {
	return preset.capabilities.filter((id) => FACTORIES[id](deps) === undefined);
}

export function buildPresetRegistry(preset: AgentPreset, deps: PresetDeps): CapabilityRegistry {
	const built = preset.capabilities.map((id) => FACTORIES[id](deps)).filter((capability): capability is NonNullable<typeof capability> => capability !== undefined);
	return createCapabilityRegistry(built);
}

/** Prompt estável do preset: sem contrato de trabalho no `minimal`. */
export function presetStablePrompt(preset: AgentPreset, registry: CapabilityRegistry): string {
	return buildStablePrompt(registry, { workContract: preset.workContract });
}

export type PresetSetup = { preset: AgentPreset; registry: CapabilityRegistry; stableSystem: string; unavailable: CapabilityId[] };

export function setupPreset(id: PresetId, deps: PresetDeps): PresetSetup {
	const preset = PRESETS[id];
	const registry = buildPresetRegistry(preset, deps);
	return { preset, registry, stableSystem: presetStablePrompt(preset, registry), unavailable: unavailableCapabilities(preset, deps) };
}
