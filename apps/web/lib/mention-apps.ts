import {
	customMcpIconPath,
	foldText,
	type ComposioConnectedAppView,
	type ComposioToolkitView,
	type McpConnectionView,
} from "@workspace/shared";

/**
 * Apps do `@` do composer: os conectores do usuário (catálogo nativo, MCP
 * personalizado e apps do Composio). Puro: a busca de dados fica no hook.
 */

export type MentionApp = {
	/** `catalog:<id>`, `custom:<id>` ou `composio:<slug>`. */
	id: string;
	name: string;
	/** Caminho do próprio app (`/connectors/x.svg`) ou URL https de logo; `null` = inicial do nome. */
	logo: string | null;
	description?: string | null;
	connected: boolean;
};

export type MentionAppSources = {
	catalog: ReadonlyArray<{ id: string; name: string; description?: string; icon: string; availability: string; status: string | null }>;
	connections: ReadonlyArray<Pick<McpConnectionView, "id" | "catalogId" | "name" | "url" | "status">>;
	composioConnections: readonly ComposioConnectedAppView[];
	composioToolkits: readonly ComposioToolkitView[];
};

function hostOf(url: string): string | null {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
	} catch {
		return null;
	}
}

/** Lista única (sem repetir nome); o conector conectado vence o que ainda pede login. */
export function buildMentionApps(sources: MentionAppSources): MentionApp[] {
	const byName = new Map<string, MentionApp>();
	const add = (app: MentionApp) => {
		const key = foldText(app.name.trim());
		if (!key) return;
		const current = byName.get(key);
		if (!current || (app.connected && !current.connected)) byName.set(key, app);
	};
	for (const entry of sources.catalog) {
		if (entry.availability !== "available") continue;
		add({ id: `catalog:${entry.id}`, name: entry.name, logo: entry.icon, description: entry.description, connected: entry.status === "connected" });
	}
	for (const connection of sources.connections) {
		if (connection.catalogId) continue;
		const host = hostOf(connection.url);
		add({ id: `custom:${connection.id}`, name: connection.name, logo: host ? customMcpIconPath(host) : null, connected: connection.status === "connected" });
	}
	const connectedSlugs = new Set(sources.composioConnections.map((item) => item.toolkit.toLowerCase()));
	const seen = new Set<string>();
	for (const toolkit of sources.composioToolkits) {
		// O conector nativo equivalente é o padrão: não duplica.
		if (toolkit.nativeCatalogId) continue;
		seen.add(toolkit.slug.toLowerCase());
		add({ id: `composio:${toolkit.slug}`, name: toolkit.name, logo: toolkit.logo, description: toolkit.description, connected: toolkit.connected || connectedSlugs.has(toolkit.slug.toLowerCase()) });
	}
	for (const connection of sources.composioConnections) {
		if (seen.has(connection.toolkit.toLowerCase())) continue;
		add({ id: `composio:${connection.toolkit}`, name: connection.toolkitName, logo: null, connected: true });
	}
	return [...byName.values()];
}

/**
 * Apps oferecidos para a consulta: sem consulta só os conectados; com consulta, os
 * que casam por nome (prefixo do nome ou de uma palavra), conectados ou não. O nome
 * de um bot do usuário vence o de um app igual.
 */
export function visibleMentionApps<T extends { name: string; connected?: boolean }>(apps: readonly T[], query: string, botNames: readonly string[] = []): T[] {
	const wanted = foldText(query.trim());
	const taken = new Set(botNames.map((name) => foldText(name.trim())));
	return apps.filter((app) => {
		const name = foldText(app.name.trim());
		if (taken.has(name)) return false;
		if (!wanted) return app.connected === true;
		return name.startsWith(wanted) || name.split(/\s+/).some((word) => word.startsWith(wanted));
	});
}
