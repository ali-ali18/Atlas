import { COMPOSIO_CATALOG_ID, dropComposioMetaTools, dropNativeDuplicateTools, type McpToolInfo } from "@workspace/shared";

/**
 * O conector nativo vence: se o app já está conectado nativamente
 * (github, gmail…), as tools do mesmo toolkit no Composio saem do run, para
 * o agente não ver duas versões da mesma ferramenta. As meta-tools opacas do
 * Composio (REMOTE_BASH, MULTI_EXECUTE…) saem sempre, mesmo de linhas antigas.
 */
export function withoutNativeDuplicates<T extends { catalogId?: string | null; tools: McpToolInfo[] }>(
	records: readonly T[],
): T[] {
	const nativeIds = new Set(
		records
			.map((record) => record.catalogId)
			.filter((id): id is string => !!id && id !== COMPOSIO_CATALOG_ID),
	);
	return records.map((record) => {
		if (record.catalogId !== COMPOSIO_CATALOG_ID) return record;
		const tools = dropComposioMetaTools(record.tools);
		return { ...record, tools: nativeIds.size === 0 ? tools : dropNativeDuplicateTools(tools, nativeIds) };
	});
}
