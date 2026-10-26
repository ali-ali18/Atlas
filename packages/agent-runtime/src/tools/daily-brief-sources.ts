import { listApiConnections, listMcpConnections } from "@workspace/db";
import {
	COMPOSIO_CATALOG_ID,
	SOURCE_CATEGORIES,
	categorizeSource,
	composioToolkitOfTool,
	connectorAccountName,
	isBriefCategory,
	mcpAutonomyMeta,
	mcpToolName,
	type BriefSource,
	type McpToolInfo,
} from "@workspace/shared";
import { withoutNativeDuplicates } from "../mcp/composio/records.js";

/** Marca que `markMcpConnectionAuthFailed` grava no `lastError` quando o login expira (o conector sai dos runs). */
const AUTH_EXPIRED_MARK = "login expirou";

export type BriefSourcesDeps = {
	listMcp?: typeof listMcpConnections;
	listApi?: typeof listApiConnections;
};

type McpRecord = Awaited<ReturnType<typeof listMcpConnections>>[number];

/** Nome do toolkit do Composio como aparece na lista de fontes ("gmail" → "Gmail"). */
function toolkitLabel(toolkit: string): string {
	return toolkit ? `${toolkit.charAt(0).toUpperCase()}${toolkit.slice(1)}` : "Composio";
}

function readToolNames(record: McpRecord, tools: readonly McpToolInfo[]): string[] {
	const disabled = new Set(record.disabledTools);
	const names: string[] = [];
	for (const tool of tools) {
		if (disabled.has(tool.name)) continue;
		const exposedName = mcpToolName(record.slug, tool.name);
		const meta = mcpAutonomyMeta({ tool, exposedName, slug: record.slug, catalogId: record.catalogId });
		if (meta.actionClass === "read" && !names.includes(exposedName)) names.push(exposedName);
	}
	return names;
}

function fromMcpRecord(record: McpRecord): BriefSource[] {
	const name = connectorAccountName(record.name, record.accountLabel);
	if (record.catalogId === COMPOSIO_CATALOG_ID) {
		// Uma conexão do Composio traz vários apps: cada toolkit vira uma fonte, com a categoria dele.
		const byToolkit = new Map<string, McpToolInfo[]>();
		for (const tool of record.tools) {
			const toolkit = composioToolkitOfTool(tool.name);
			byToolkit.set(toolkit, [...(byToolkit.get(toolkit) ?? []), tool]);
		}
		return [...byToolkit].map(([toolkit, tools]) => ({
			kind: "composio" as const,
			name: toolkitLabel(toolkit),
			category: categorizeSource({ kind: "composio", toolkit }),
			readTools: readToolNames(record, tools),
		}));
	}
	return [
		{
			kind: "mcp" as const,
			name,
			category: categorizeSource({ kind: "mcp", catalogId: record.catalogId, name: record.name }),
			readTools: readToolNames(record, record.tools),
		},
	];
}

/**
 * Fontes que o brief "Seu dia" pode ler: só as conexões DO DONO (a consulta do db filtra por `userId`),
 * já com a categoria e SÓ as tools de leitura. Login expirado entra como `needsReconnect` (vira a linha
 * "Reconecte <fonte>" no painel). Conector de API (OpenAPI, só GET) vira a fonte "negócio".
 */
export async function listBriefSources(userId: string, deps: BriefSourcesDeps = {}): Promise<BriefSource[]> {
	if (!userId.trim() || userId === "default") return [];
	const [mcpRows, apiRows] = await Promise.all([
		(deps.listMcp ?? listMcpConnections)(userId).catch(() => []),
		(deps.listApi ?? listApiConnections)(userId).catch(() => []),
	]);
	const connected = withoutNativeDuplicates(mcpRows.filter((row) => row.status === "connected"));
	const sources: BriefSource[] = [];
	for (const record of connected) {
		for (const source of fromMcpRecord(record)) {
			if (isBriefCategory(source.category) && source.readTools.length > 0) sources.push(source);
		}
	}
	for (const record of mcpRows) {
		if (record.status !== "pending_auth" || !record.lastError?.includes(AUTH_EXPIRED_MARK)) continue;
		const category = categorizeSource({ kind: "mcp", catalogId: record.catalogId, name: record.name });
		if (isBriefCategory(category)) {
			sources.push({ kind: "mcp", name: connectorAccountName(record.name, record.accountLabel), category, readTools: [], needsReconnect: true });
		}
	}
	for (const record of apiRows) {
		if (record.status !== "connected") continue;
		sources.push({
			kind: "api",
			name: connectorAccountName(record.name, record.accountLabel),
			category: categorizeSource({ kind: "api", name: record.name }),
			readTools: ["api_search", "api_call"],
		});
	}
	// Painel por categoria: e-mail, agenda, mensagens, tarefas, negócio.
	return sources.sort((a, b) => SOURCE_CATEGORIES.indexOf(a.category) - SOURCE_CATEGORIES.indexOf(b.category));
}
