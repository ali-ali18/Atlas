// Política dos conectores MCP (F2.5): funções puras, sem I/O. Três coisas moram aqui para o motor v4 e o
// legado nunca divergirem: a classe de efeito de uma tool MCP, quais conectores guardam dado privado do dono e
// o `confirmWrites` do conector virando REGRA de política (o `decide` a aplica; não há `if` solto).
import { classifyMcpTool } from "../autonomy-tools.js";
import { getMcpCatalogEntry, type McpCatalogCategory } from "../mcp-catalog.js";
import type { McpToolInfo } from "../mcp.js";
import type { ToolMark } from "../tool-marks.js";
import type { EffectClass, PolicyRule } from "./types.js";

/** Classes de efeito que uma tool MCP pode ter. Envio/dinheiro/link público não saem do schema: só o dono ou o catálogo os declara. */
export type McpEffectClass = Extract<EffectClass, "read" | "write_external" | "destructive">;

/**
 * Classe de efeito de uma tool MCP, a partir das anotações do servidor (`readOnlyHint`, `destructiveHint`) e do nome.
 * Conservadora: sem anotação é `write_external`. Só leitura anotada (ou marcada pelo dono, sem anotação) vira `read`;
 * `destructiveHint` ou verbo irreversível no nome vira `destructive`. A descrição do servidor é dado não confiável e
 * nunca promove nada.
 */
export function classifyMcpEffect(tool: Pick<McpToolInfo, "name" | "annotations">, options: { ownerMark?: ToolMark; catalogReadOnly?: boolean } = {}): McpEffectClass {
	const action = classifyMcpTool({ name: tool.name, annotations: tool.annotations, ownerMark: options.ownerMark, catalogReadOnly: options.catalogReadOnly });
	if (action === "read") return "read";
	if (action === "irreversible") return "destructive";
	return "write_external";
}

/** Categorias de catálogo que não guardam dado do dono (busca na web, geração criativa). */
const PUBLIC_CATEGORIES: ReadonlySet<McpCatalogCategory> = new Set(["search", "creative"]);

/**
 * O conector guarda dado privado do dono (e-mail, drive, agenda, workspace, ERP…)? Padrão: sim. Só catálogo
 * conhecido de categoria pública é público; conector personalizado ou desconhecido conta como privado.
 */
export function isPrivateConnector(catalogId: string | null | undefined): boolean {
	if (!catalogId) return true;
	const entry = getMcpCatalogEntry(catalogId);
	return entry === undefined || !PUBLIC_CATEGORIES.has(entry.category);
}

/**
 * `confirmWrites` do conector vira regra `approve` sobre o nome da tool de escrita dele. O `decide` só aperta com
 * `approve` (nunca afrouxa), então a regra vale em qualquer autonomia e vem antes das regras do dono.
 */
export function confirmWritesRules(connectors: ReadonlyArray<{ confirmWrites: boolean; writeToolName: string }>): PolicyRule[] {
	return connectors.filter((c) => c.confirmWrites).map((c) => ({ match: c.writeToolName, verdict: "approve" as const }));
}
