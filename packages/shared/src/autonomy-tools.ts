import { COMPOSIO_CATALOG_ID, isComposioReadToolName } from "./composio.js";
import { getMcpCatalogEntry } from "./mcp-catalog.js";
import type { McpToolInfo } from "./mcp.js";
import type { ActionClass, AutonomyToolMeta } from "./autonomy.js";

/**
 * Classe de ação de uma tool de conector (F10). Ordem de decisão:
 * 1. leitura: `readOnlyHint` sem `destructiveHint`, ou o catálogo diz que só lê;
 * 2. irreversível: `destructiveHint`, verbo do nome (apagar, enviar, mesclar…)
 *    ou `openWorldHint` explícito com verbo que atinge terceiros;
 * 3. o resto é escrita reversível. Sem anotação nenhuma também é escrita
 *    (nunca presumimos leitura).
 */

/** Verbos que nunca dá para desfazer ou que saem para terceiros. */
const IRREVERSIBLE_VERBS = [
	"delete",
	"remove",
	"destroy",
	"purge",
	"erase",
	"trash",
	"send",
	"merge",
	"publish",
	"transfer",
] as const;
/** Só casam o token inteiro (evita `payload`, `posture`). */
const IRREVERSIBLE_EXACT = new Set(["post", "pay", "drop"]);
/** Só contam como irreversíveis com `openWorldHint: true` explícito. */
const OUTWARD_VERBS = new Set([
	"comment",
	"reply",
	"invite",
	"share",
	"notify",
	"message",
	"email",
	"push",
	"submit",
	"tweet",
	"dispatch",
	"forward",
]);

/** `githubMergePR` / `merge-pull_request` → ["github", "merge", "pr", …]. */
export function toolNameTokens(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function hasIrreversibleVerb(tokens: readonly string[]): boolean {
	return tokens.some(
		(token) =>
			IRREVERSIBLE_EXACT.has(token) ||
			IRREVERSIBLE_VERBS.some((verb) => token === verb || token.startsWith(verb)),
	);
}

/** O nome tem verbo que atinge terceiros (responder, convidar, compartilhar…), mesmo sem `openWorldHint`. */
export function hasOutwardVerb(name: string): boolean {
	return toolNameTokens(name).some((token) => OUTWARD_VERBS.has(token));
}

export function classifyMcpTool(input: {
	name: string;
	annotations?: McpToolInfo["annotations"];
	/** O catálogo declara que essa tool só lê (servidor sem `readOnlyHint`). */
	catalogReadOnly?: boolean;
	/** Servidor sem anotações confiáveis (Composio): verbo de leitura no nome conta como leitura. */
	readByName?: boolean;
}): ActionClass {
	const hints = input.annotations;
	if (input.catalogReadOnly) return "read";
	if (hints?.readOnlyHint === true && hints.destructiveHint !== true) return "read";
	if (hints?.destructiveHint === true) return "irreversible";
	const unannotated = hints?.readOnlyHint === undefined && hints?.destructiveHint === undefined;
	if (input.readByName && unannotated && isComposioReadToolName(input.name)) return "read";
	const tokens = toolNameTokens(input.name);
	if (hasIrreversibleVerb(tokens)) return "irreversible";
	if (hints?.openWorldHint === true && tokens.some((token) => OUTWARD_VERBS.has(token))) {
		return "irreversible";
	}
	return "write";
}

/** Conveniência: classe + chaves de conector para o `decideAction`. */
export function mcpAutonomyMeta(input: {
	tool: McpToolInfo;
	exposedName: string;
	slug: string;
	catalogId?: string | null;
}): AutonomyToolMeta {
	const catalogReadOnly = input.catalogId
		? (getMcpCatalogEntry(input.catalogId)?.readOnlyTools ?? []).includes(input.tool.name)
		: false;
	return {
		actionClass: classifyMcpTool({
			name: input.tool.name,
			annotations: input.tool.annotations,
			catalogReadOnly,
			readByName: input.catalogId === COMPOSIO_CATALOG_ID,
		}),
		tool: input.exposedName,
		connectors: [input.slug, ...(input.catalogId ? [input.catalogId] : [])],
	};
}

/** Tools do próprio agente que passam pelo mesmo gate. */
export const HOST_TOOL_CLASSES = {
	propose_profile_update: "write",
	propose_skill_delete: "irreversible",
} as const satisfies Record<string, ActionClass>;

export type AutonomyHostTool = keyof typeof HOST_TOOL_CLASSES;

export function hostAutonomyMeta(tool: AutonomyHostTool): AutonomyToolMeta {
	return { actionClass: HOST_TOOL_CLASSES[tool], tool, host: true };
}
