import { isReadOnlyToolName } from "../../execution/run-governor.js";
import type { ChatTool } from "@workspace/llm";
import type { ToolContext, ToolHandler, ToolRegistration, ToolResult } from "./types.js";

/**
 * Registro de tools reutilizável: o laço atual (`runComputerUse`) e qualquer outro laço executam as
 * mesmas tools por aqui, com o mesmo `ToolContext`. Cada família de handlers (`handlers/*.ts`)
 * exporta um mapa `nome -> registro`; o mapa final é montado na primeira consulta (evita ciclos
 * de importação entre as famílias e o registro).
 */
export type ToolFamily = Record<string, ToolRegistration>;
/** Resolve famílias dinâmicas (tools MCP, sessão de código) que não têm um nome fixo. */
export type ToolResolver = (name: string) => ToolHandler | undefined;

/** `before` roda antes do mapa (a sessão de código ganha de nome igual); `after` só para o que o mapa não conhece (conector MCP). */
export type ToolResolvers = { before?: Array<() => ToolResolver>; after?: Array<() => ToolResolver> };

type RegistryState = { tools: Map<string, ToolRegistration>; before: ToolResolver[]; after: ToolResolver[] };

let state: RegistryState | undefined;
const families: Array<() => ToolFamily> = [];
let resolverFactories: ToolResolvers = {};

/** Usado pelo módulo `handlers/index.ts` para declarar as famílias. */
export function declareToolFamilies(familyLoaders: Array<() => ToolFamily>, resolvers: ToolResolvers = {}): void {
	families.length = 0;
	families.push(...familyLoaders);
	resolverFactories = resolvers;
	state = undefined;
}

function registry(): RegistryState {
	if (state) return state;
	const tools = new Map<string, ToolRegistration>();
	for (const load of families) {
		for (const [name, registration] of Object.entries(load())) {
			if (tools.has(name)) throw new Error(`Tool registrada duas vezes: ${name}`);
			tools.set(name, { ...registration, readOnly: registration.readOnly ?? isReadOnlyToolName(name, () => false), definition: registration.definition ?? definitions.get(name) });
		}
	}
	state = { tools, before: (resolverFactories.before ?? []).map((factory) => factory()), after: (resolverFactories.after ?? []).map((factory) => factory()) };
	return state;
}

export function getToolRegistration(name: string): ToolRegistration | undefined {
	return registry().tools.get(name);
}

/** Nomes das tools de nome fixo registradas (as dinâmicas, MCP e sessão de código, ficam nos resolvedores). */
export function listRegisteredToolNames(): string[] {
	return [...registry().tools.keys()];
}

const definitions = new Map<string, ChatTool>();

/**
 * Registra as definições (schemas enviados ao modelo) por nome. As definições continuam onde
 * nascem (`COMPUTER_USE_TOOLS` e os módulos de cada tool); aqui só ficam à mão de quem consulta o registro.
 */
export function attachToolDefinitions(list: readonly ChatTool[]): void {
	for (const definition of list) {
		definitions.set(definition.function.name, definition);
		const registration = state?.tools.get(definition.function.name);
		if (registration && !registration.definition) registration.definition = definition;
	}
}

export function hasRegisteredTool(name: string): boolean {
	const { tools, before, after } = registry();
	return tools.has(name) || [...before, ...after].some((resolve) => resolve(name) !== undefined);
}

/**
 * Executa uma tool pelo registro. Nome sem handler: erro honesto ("Ferramenta desconhecida"),
 * igual ao que o laço sempre devolveu ao modelo.
 */
export async function executeRegisteredTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const { tools, before, after } = registry();
	for (const resolve of before) {
		const handler = resolve(name);
		if (handler) return await handler(args, ctx);
	}
	const registration = tools.get(name);
	if (registration) return await registration.handler(args, ctx);
	for (const resolve of after) {
		const handler = resolve(name);
		if (handler) return await handler(args, ctx);
	}
	throw new Error(`Ferramenta desconhecida: ${name}`);
}
