import type { Tool } from "../tools/define-tool.js";
import type { Capability } from "./define-capability.js";

/** Nome reservado: a tool que carrega capacidades pertence ao motor, não a uma capacidade. */
export const USE_CAPABILITY_TOOL = "use_capability";

export interface CapabilityRegistry {
	/** Ordenadas por id: a ordem de registro de quem chama não muda o que o modelo vê. */
	readonly capabilities: readonly Capability[];
	get(id: string): Capability | undefined;
	ids(): readonly string[];
	core(): readonly Capability[];
	toolByName(name: string): Tool | undefined;
	/** Capacidade dona da tool (para achar os ganchos). */
	ownerOf(toolName: string): Capability | undefined;
}

export function createCapabilityRegistry(input: readonly Capability[]): CapabilityRegistry {
	const byId = new Map<string, Capability>();
	const toolOwner = new Map<string, Capability>();
	const toolsByName = new Map<string, Tool>();
	for (const capability of input) {
		if (byId.has(capability.id)) throw new Error(`Capability registry: duplicate id "${capability.id}".`);
		byId.set(capability.id, capability);
		for (const tool of capability.tools) {
			if (tool.name === USE_CAPABILITY_TOOL) throw new Error(`Capability registry: "${USE_CAPABILITY_TOOL}" is reserved (capability "${capability.id}").`);
			const owner = toolOwner.get(tool.name);
			if (owner) throw new Error(`Capability registry: tool "${tool.name}" is in both "${owner.id}" and "${capability.id}".`);
			toolOwner.set(tool.name, capability);
			toolsByName.set(tool.name, tool);
		}
	}
	const capabilities = Object.freeze([...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
	return {
		capabilities,
		get: (id) => byId.get(id),
		ids: () => capabilities.map((c) => c.id),
		core: () => capabilities.filter((c) => c.core),
		toolByName: (name) => toolsByName.get(name),
		ownerOf: (name) => toolOwner.get(name),
	};
}

/**
 * Índice do `[context]`: uma linha por capacidade carregável, ordenada por id. O núcleo fica de fora
 * (já vem carregado). O texto não depende do que já foi carregado no run, para o prefixo não mudar.
 */
export function capabilityIndex(registry: CapabilityRegistry): string {
	return registry.capabilities
		.filter((capability) => !capability.core)
		.map((capability) => `- ${capability.id}: ${capability.summary}`)
		.join("\n");
}
