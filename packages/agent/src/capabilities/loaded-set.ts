import { z } from "zod";
import type { LlmToolSpec } from "../ports/llm.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { USE_CAPABILITY_TOOL, type CapabilityRegistry } from "./registry.js";

/**
 * Estado das capacidades carregadas num run. Só de acréscimo: o núcleo entra no início, cada
 * `use_capability` acrescenta as tools no FIM, nada sai nem muda de posição. Assim o prefixo
 * enviado ao modelo é idêntico entre passos e o cache do provedor vale.
 */
export interface LoadedSet {
	/** Ids carregados, em ordem de carga (núcleo primeiro). Serializável para o checkpoint. */
	loadedIds(): readonly string[];
	has(id: string): boolean;
	/** Carrega (idempotente). `added` lista as tools novas, vazia se já estava carregada. */
	load(id: string): { ok: true; added: readonly string[] } | { ok: false; error: string };
	/** `use_capability` primeiro, depois as tools na ordem de carga. */
	toolsForModel(): readonly Tool[];
	specsForModel(): LlmToolSpec[];
	readonly useCapabilityTool: Tool;
}

export function createLoadedSet(registry: CapabilityRegistry, restoreIds: readonly string[] = []): LoadedSet {
	const loaded: string[] = [];
	const tools: Tool[] = [];

	const append = (id: string): readonly string[] => {
		const capability = registry.get(id);
		if (!capability || loaded.includes(id)) return [];
		loaded.push(id);
		tools.push(...capability.tools);
		return capability.tools.map((tool) => tool.name);
	};

	for (const capability of registry.core()) append(capability.id);
	for (const id of restoreIds) append(id);

	const useCapabilityTool = defineTool({
		name: USE_CAPABILITY_TOOL,
		description:
			"Load a capability listed in the capability index so its tools become available from the next step. Use it when the task needs a capability that is not loaded yet. Loading twice is harmless.",
		inputSchema: z.object({ id: z.string().describe("Capability id from the index.") }),
		effect: "read",
		execute: ({ id }) => {
			const result = set.load(id);
			if (!result.ok) return { ok: false, error: result.error, hint: `Valid ids: ${registry.ids().join(", ")}.` };
			const title = registry.get(id)?.title ?? id;
			return {
				ok: true,
				summary: result.added.length > 0 ? `Loaded "${title}". New tools: ${result.added.join(", ")}.` : `"${title}" was already loaded.`,
			};
		},
	});

	const set: LoadedSet = {
		loadedIds: () => [...loaded],
		has: (id) => loaded.includes(id),
		load(id) {
			if (!registry.get(id)) return { ok: false, error: `Unknown capability "${id}". Valid ids: ${registry.ids().join(", ")}.` };
			return { ok: true, added: append(id) };
		},
		toolsForModel: () => [useCapabilityTool, ...tools],
		specsForModel: () => [useCapabilityTool, ...tools].map((tool) => tool.toLlmToolSpec()),
		useCapabilityTool,
	};
	return set;
}
