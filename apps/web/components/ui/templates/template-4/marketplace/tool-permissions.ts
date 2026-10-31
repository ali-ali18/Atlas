import {
	DEFAULT_AUTONOMY_LEVEL,
	autonomyConnectorKey,
	decideAction,
	mcpAutonomyMeta,
	mcpToolName,
	upsertAutonomyException,
	type AutonomyException,
	type AutonomyExceptionMode,
	type EffectiveAutonomy,
	type McpConnectionView,
	type McpToolInfo,
} from "@workspace/shared";
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

/** Estado de uma tool na tela: as três exceções de Autonomia. */
export type ToolPermission = AutonomyExceptionMode;
export type ToolPermissionValue = ToolPermission | "mixed";

export const TOOL_PERMISSION_ORDER: readonly ToolPermission[] = ["never_ask", "always_ask", "blocked"];

export const TOOL_PERMISSION_LABEL_KEYS = {
	never_ask: "marketplace.perm.never_ask",
	always_ask: "marketplace.perm.always_ask",
	blocked: "marketplace.perm.blocked",
} as const satisfies Record<ToolPermission, MessageKey>;

export function toolPermissionLabel(mode: ToolPermission, { t }: Translator = defaultTranslator): string {
	return t(TOOL_PERMISSION_LABEL_KEYS[mode]);
}

export const DEFAULT_POLICY: EffectiveAutonomy = { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] };

type ConnectionRef = Pick<McpConnectionView, "catalogId" | "slug" | "tools" | "disabledTools" | "toolMarks">;

function toolMeta(connection: ConnectionRef, tool: McpToolInfo) {
	return mcpAutonomyMeta({
		tool,
		exposedName: mcpToolName(connection.slug, tool.name),
		slug: connection.slug,
		catalogId: connection.catalogId,
		ownerMark: connection.toolMarks?.[tool.name],
	});
}

/** A tool só lê? Anotação do servidor > marcação confirmada do dono > padrão (sem anotação = escrita). */
export function toolIsRead(connection: ConnectionRef, tool: McpToolInfo): boolean {
	return toolMeta(connection, tool).actionClass === "read";
}

/**
 * Estado real da tool: `disabledTools` tira a tool no runtime (vence), depois
 * exceção (tool > conector) e, sem exceção, o padrão do nível via `decideAction`.
 */
export function toolPermission(
	connection: ConnectionRef,
	tool: McpToolInfo,
	policy: EffectiveAutonomy,
): ToolPermission {
	if (connection.disabledTools.includes(tool.name)) return "blocked";
	const decision = decideAction(policy, toolMeta(connection, tool));
	return decision === "block" ? "blocked" : decision === "ask" ? "always_ask" : "never_ask";
}

/** Estado comum a todas as tools, ou `mixed` quando divergem. */
export function connectionPermission(
	connection: ConnectionRef,
	policy: EffectiveAutonomy,
): ToolPermissionValue {
	let common: ToolPermission | null = null;
	for (const tool of connection.tools) {
		const mode = toolPermission(connection, tool, policy);
		if (common && common !== mode) return "mixed";
		common = mode;
	}
	return common ?? "mixed";
}

/** Exceções depois de definir uma tool (a tool vence o conector). */
export function withToolPermission(
	exceptions: readonly AutonomyException[],
	connection: ConnectionRef,
	tool: McpToolInfo,
	mode: ToolPermission,
): AutonomyException[] {
	return upsertAutonomyException(exceptions, { tool: mcpToolName(connection.slug, tool.name), mode });
}

/** "Todas": uma exceção do conector e nenhuma por tool deste conector. */
export function withAllToolsPermission(
	exceptions: readonly AutonomyException[],
	connection: ConnectionRef,
	mode: ToolPermission,
): AutonomyException[] {
	const own = new Set(connection.tools.map((tool) => mcpToolName(connection.slug, tool.name)));
	return upsertAutonomyException(
		exceptions.filter((item) => !item.tool || !own.has(item.tool)),
		{ connector: autonomyConnectorKey(connection), mode },
	);
}

/** Alguma tool irreversível ficou em "Permitir sempre"? */
export function hasRiskyAllow(connection: ConnectionRef, policy: EffectiveAutonomy): boolean {
	return connection.tools.some(
		(tool) =>
			toolMeta(connection, tool).actionClass === "irreversible" &&
			toolPermission(connection, tool, policy) === "never_ask",
	);
}
