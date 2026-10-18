"use client";

import { useEffect, useState } from "react";

import { getComposioStatus, getMcpCatalog, listComposioConnections, listComposioToolkits, listMcpConnections } from "@/lib/atlas-api";
import { buildMentionApps, type MentionApp } from "@/lib/mention-apps";

let cache: Promise<MentionApp[]> | null = null;

/** Tamanho da 1ª página do catálogo do Composio (mais usados): o `@` busca só nela, sem pedir a cada tecla. */
const COMPOSIO_FIRST_PAGE = 60;

/** Uma busca por sessão (4 chamadas leves em paralelo); cada parte que falha vira lista vazia. */
function loadMentionApps(): Promise<MentionApp[]> {
	cache ??= (async () => {
		const [catalog, connections, status] = await Promise.allSettled([getMcpCatalog(), listMcpConnections(), getComposioStatus()]);
		const composioOn = status.status === "fulfilled" && status.value.configured;
		const [composioConnections, composioToolkits] = composioOn
			? await Promise.allSettled([listComposioConnections(), listComposioToolkits({ limit: COMPOSIO_FIRST_PAGE })])
			: [null, null];
		return buildMentionApps({
			catalog: (catalog.status === "fulfilled" && catalog.value.entries) || [],
			connections: (connections.status === "fulfilled" && connections.value) || [],
			composioConnections: (composioConnections?.status === "fulfilled" && composioConnections.value) || [],
			composioToolkits: (composioToolkits?.status === "fulfilled" && composioToolkits.value.items) || [],
		});
	})();
	return cache;
}

/** Apps do usuário (indefinido até carregar; só busca quando `enabled`, na 1ª vez). */
export function useMentionApps(enabled: boolean): MentionApp[] | undefined {
	const [apps, setApps] = useState<MentionApp[] | undefined>();
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		void loadMentionApps().then((next) => {
			if (alive) setApps(next);
		});
		return () => {
			alive = false;
		};
	}, [enabled]);
	return apps;
}
