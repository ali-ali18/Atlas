import { COMPOSIO_CATALOG_ID, isComposioReadToolName } from "./composio.js";
import { getMcpCatalogEntry } from "./mcp-catalog.js";
import type { McpToolInfo } from "./mcp.js";
import type { ActionClass, AutonomyToolMeta } from "./autonomy.js";
import type { ToolMark } from "./tool-marks.js";

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
	// pt/es: mesmo critério do inglês (nunca viram leitura, nem por marcação do dono).
	"enviar",
	"excluir",
	"apagar",
	"deletar",
	"remover",
	"emitir",
	"cancelar",
	"transmitir",
	"pagar",
	"transferir",
	"publicar",
	"mesclar",
	"descartar",
	"eliminar",
	"borrar",
] as const;
/**
 * Só casam o token inteiro (evita `payload`, `posture`, `listRefunds`, `signal`). Verbos de efeito fiscal, financeiro
 * ou externo que o prefixo pegaria em substantivos de consulta: autorizar/faturar/estornar/reembolsar/cobrar/baixar/
 * aprovar/assinar (pt/es), authorize/refund/charge/approve/sign/void/capture/settle/submit/dispatch/transmit/revoke.
 * `baixar` também pega "baixar arquivo" (download): o erro é para o lado seguro (pede cartão). `close`/`fechar` ficam
 * de fora de propósito: continuam escrita (cartão) mas fechar uma tela/lista seria falso positivo comum.
 */
const IRREVERSIBLE_EXACT = new Set([
	"post",
	"pay",
	"drop",
	"authorize",
	"authorise",
	"autorizar",
	"submit",
	"submeter",
	"dispatch",
	"despachar",
	"refund",
	"estornar",
	"reembolsar",
	"reembolsa",
	"charge",
	"cobrar",
	"baixar",
	"faturar",
	"facturar",
	"approve",
	"aprovar",
	"aprobar",
	"sign",
	"assinar",
	"firmar",
	"void",
	"anular",
	"capture",
	"settle",
	"liquidar",
	"transmit",
	"revoke",
	"revogar",
]);
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
	// NFKD: largura total (ｅnviar) vira ASCII e acento (excluír) separa da letra; depois some o acento e o
	// caractere invisível. Sem isso `excluír_pedido` escapava do detector de verbo irreversível.
	return name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff\u00ad]/g, "")
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

/** O nome da tool tem verbo irreversível (en/pt/es): nunca pode ser marcada como leitura. */
export function hasIrreversibleToolName(name: string): boolean {
	return hasIrreversibleVerb(toolNameTokens(name));
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
	/** Marcação confirmada pelo dono. Só vale sem anotação do servidor e nunca desfaz verbo irreversível no nome. */
	ownerMark?: ToolMark;
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
	if (unannotated && input.ownerMark === "read") return "read";
	return "write";
}

/** Conveniência: classe + chaves de conector para o `decideAction`. */
export function mcpAutonomyMeta(input: {
	tool: McpToolInfo;
	exposedName: string;
	slug: string;
	catalogId?: string | null;
	ownerMark?: ToolMark;
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
			ownerMark: input.ownerMark,
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
