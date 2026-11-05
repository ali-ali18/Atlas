import { isDefinedTool, type Tool } from "../tools/define-tool.js";
import type { CapabilityHooks } from "./hooks.js";

export type CapabilityDefinition = {
	/** snake_case ou kebab, único no registro. */
	id: string;
	/** Nome para o usuário (pt-BR). */
	title: string;
	/** Uma linha, até 160 caracteres, em inglês: vai para o índice do `[context]`. */
	summary: string;
	/** Núcleo: as tools já entram no início do run. */
	core?: boolean;
	tools: readonly Tool[];
	/** Caminho do skill.md; o texto só entra ao carregar a capacidade. */
	skill?: string;
	hooks?: CapabilityHooks;
	/** Tipos de card (definidos em shared). */
	cards?: readonly string[];
	/** Padrões de eval da capacidade. */
	evals?: readonly string[];
};

export type Capability = Readonly<Required<Pick<CapabilityDefinition, "id" | "title" | "summary" | "tools">>> & {
	readonly core: boolean;
	readonly skill?: string;
	readonly hooks: CapabilityHooks;
	readonly cards: readonly string[];
	readonly evals: readonly string[];
};

export const SUMMARY_MAX_LENGTH = 160;
const ID_FORMAT = /^[a-z][a-z0-9_-]*$/;

export function defineCapability(def: CapabilityDefinition): Capability {
	const where = `defineCapability(${def.id})`;
	if (!ID_FORMAT.test(def.id)) throw new Error(`${where}: invalid id (use lowercase letters, digits, "_" or "-").`);
	if (def.title.trim().length === 0) throw new Error(`${where}: empty title.`);
	if (def.summary.trim().length === 0) throw new Error(`${where}: empty summary.`);
	if (/[\r\n]/.test(def.summary)) throw new Error(`${where}: summary must be a single line.`);
	if (def.summary.length > SUMMARY_MAX_LENGTH) {
		throw new Error(`${where}: summary has ${def.summary.length} characters (max ${SUMMARY_MAX_LENGTH}).`);
	}
	const names = new Set<string>();
	for (const tool of def.tools) {
		if (!isDefinedTool(tool)) throw new Error(`${where}: every tool must come from defineTool.`);
		if (names.has(tool.name)) throw new Error(`${where}: duplicate tool "${tool.name}".`);
		names.add(tool.name);
	}
	const hooks = def.hooks ?? {};
	for (const kind of ["beforeTool", "afterTool"] as const) {
		for (const toolName of Object.keys(hooks[kind] ?? {})) {
			if (!names.has(toolName)) throw new Error(`${where}: ${kind} hook for "${toolName}", which is not a tool of this capability.`);
		}
	}
	return Object.freeze({
		id: def.id,
		title: def.title,
		summary: def.summary,
		core: def.core === true,
		tools: Object.freeze([...def.tools]),
		skill: def.skill,
		hooks,
		cards: Object.freeze([...(def.cards ?? [])]),
		evals: Object.freeze([...(def.evals ?? [])]),
	});
}
