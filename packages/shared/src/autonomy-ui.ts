import type { AutonomyException, ActionClass } from "./autonomy.js";
import { HOST_TOOL_CLASSES, classifyMcpTool, mcpAutonomyMeta } from "./autonomy-tools.js";
import { mcpToolName, type McpConnectionView } from "./mcp.js";

/**
 * Apoio da tela de Autonomia: opções de exceção a partir das conexões e o
 * aviso de `never_ask` em ação irreversível. Puro (sem I/O).
 */

type ConnectionRef = Pick<McpConnectionView, "catalogId" | "slug" | "name" | "tools"> & Partial<Pick<McpConnectionView, "toolMarks">>;

export type AutonomyToolOption = {
	/** Nome exposto ao modelo (chave da exceção). */
	value: string;
	label: string;
	actionClass: ActionClass;
};

const HOST_TOOL_LABELS: Record<keyof typeof HOST_TOOL_CLASSES, string> = {
	propose_profile_update: "Atualizar o perfil do bot",
	propose_skill_delete: "Apagar uma habilidade",
};

/** Chave do conector numa exceção: catálogo quando existe, senão o slug. */
export function autonomyConnectorKey(connection: Pick<ConnectionRef, "catalogId" | "slug">): string {
	return connection.catalogId ?? connection.slug;
}

/** Nome amigável de uma chave de conector (catálogo ou slug). */
export function autonomyConnectorLabeler(
	connections: readonly ConnectionRef[],
): (key: string) => string | undefined {
	return (key) => {
		const found = connections.find((connection) => connection.catalogId === key || connection.slug === key);
		return found?.name;
	};
}

/** Tools que podem virar exceção: só as que escrevem (leitura nunca pergunta). */
export function autonomyToolOptions(connections: readonly ConnectionRef[]): AutonomyToolOption[] {
	const options: AutonomyToolOption[] = [];
	for (const connection of connections) {
		for (const tool of connection.tools) {
			const meta = mcpAutonomyMeta({
				tool,
				exposedName: mcpToolName(connection.slug, tool.name),
				slug: connection.slug,
				catalogId: connection.catalogId,
				ownerMark: connection.toolMarks?.[tool.name],
			});
			if (meta.actionClass === "read") continue;
			options.push({
				value: meta.tool,
				label: `${connection.name} · ${(tool.title || tool.name).replace(/_/g, " ")}`,
				actionClass: meta.actionClass,
			});
		}
	}
	for (const [tool, label] of Object.entries(HOST_TOOL_LABELS)) {
		options.push({ value: tool, label, actionClass: HOST_TOOL_CLASSES[tool as keyof typeof HOST_TOOL_CLASSES] });
	}
	return options;
}

/**
 * `never_ask` em algo que apaga/envia/não dá para desfazer precisa de aviso
 * explícito. Conector inteiro conta como arriscado se tiver ao menos uma
 * tool irreversível.
 */
export function neverAskIsRisky(
	exception: AutonomyException,
	connections: readonly ConnectionRef[],
): boolean {
	if (exception.mode !== "never_ask") return false;
	if (exception.tool) {
		const host = HOST_TOOL_CLASSES[exception.tool as keyof typeof HOST_TOOL_CLASSES];
		if (host) return host === "irreversible";
		return autonomyToolOptions(connections).some(
			(option) => option.value === exception.tool && option.actionClass === "irreversible",
		);
	}
	const connector = connections.find(
		(connection) => connection.catalogId === exception.connector || connection.slug === exception.connector,
	);
	if (!connector) return false;
	return connector.tools.some(
		(tool) => classifyMcpTool({ name: tool.name, annotations: tool.annotations }) === "irreversible",
	);
}
