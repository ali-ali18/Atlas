// Presets do motor v4 (03 §8): dados, não código. Dizem quais capacidades entram e se o contrato de trabalho
// vai no prompt estável. `minimal` é o preset do teste de fumaça e do eval; `full` cresce com as fases.
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { createCapabilityRegistry } from "../capabilities/registry.js";
import type { FileStore } from "../ports/file-store.js";
import type { Search } from "../ports/search.js";
import { buildStablePrompt } from "../prompt/work-contract.js";
import { createDeliverablesLiteCapability } from "./deliverables-lite.js";
import { createWebCapability } from "./web.js";

export const PRESET_IDS = ["minimal", "full"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type CapabilityId = "web" | "deliverables-lite";

export type AgentPreset = {
	id: PresetId;
	/** Capacidades registradas (todas núcleo hoje; as demais entram na F2). */
	capabilities: readonly CapabilityId[];
	/** O contrato de trabalho entra no prompt estável? */
	workContract: boolean;
};

export const PRESETS: Readonly<Record<PresetId, AgentPreset>> = Object.freeze({
	minimal: Object.freeze({ id: "minimal", capabilities: Object.freeze(["web", "deliverables-lite"] as const), workContract: false }),
	full: Object.freeze({ id: "full", capabilities: Object.freeze(["web", "deliverables-lite"] as const), workContract: true }),
});

export type PresetDeps = { search: Search; files: FileStore };

export function isPresetId(value: unknown): value is PresetId {
	return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export function buildPresetRegistry(preset: AgentPreset, deps: PresetDeps): CapabilityRegistry {
	const factories: Record<CapabilityId, () => ReturnType<typeof createWebCapability>> = {
		web: () => createWebCapability(deps.search),
		"deliverables-lite": () => createDeliverablesLiteCapability(deps.files),
	};
	return createCapabilityRegistry(preset.capabilities.map((id) => factories[id]()));
}

/** Prompt estável do preset: sem contrato de trabalho no `minimal`. */
export function presetStablePrompt(preset: AgentPreset, registry: CapabilityRegistry): string {
	return buildStablePrompt(registry, { workContract: preset.workContract });
}

export type PresetSetup = { preset: AgentPreset; registry: CapabilityRegistry; stableSystem: string };

export function setupPreset(id: PresetId, deps: PresetDeps): PresetSetup {
	const preset = PRESETS[id];
	const registry = buildPresetRegistry(preset, deps);
	return { preset, registry, stableSystem: presetStablePrompt(preset, registry) };
}
