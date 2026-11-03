import { useFocusEffect, useRouter } from "expo-router";
import * as React from "react";
import { AppsView } from "@/components/apps/apps-view";
import { type AppItem, appRouteParams, buildAppsRows, buildChips, composioCategoryOf, connectedItems } from "@/lib/apps";
import { useAppsData, useComposioList, useDebounced } from "@/lib/use-apps-data";
import { useInstalledSlugs } from "@/lib/use-installed-slugs";

/** Aplicativos (a grade da home): conectados, destaque, nativos por categoria, apps do Composio e bots, com busca e chips. */
export default function AppsScreen() {
	const router = useRouter();
	const data = useAppsData();
	const installed = useInstalledSlugs();
	const [query, setQuery] = React.useState("");
	const [chip, setChip] = React.useState("");
	// O filtro local responde na hora; o servidor (Composio) só é perguntado depois de uma pausa na digitação.
	const serverQuery = useDebounced(query.trim(), 350);
	const composio = useComposioList({ enabled: data.status === "ready" && data.composioConfigured, query: serverQuery, category: composioCategoryOf(chip) });

	const { reload } = data;
	// Ao abrir e ao voltar do detalhe (depois de conectar ou desconectar), o estado dos botões é relido em silêncio.
	useFocusEffect(
		React.useCallback(() => {
			void reload();
		}, [reload]),
	);

	const rows = React.useMemo(
		() => buildAppsRows({ entries: data.entries, connections: data.connections, composioConnections: data.composioConnections, composioLogos: composio.logos, composio: composio.state, bots: data.bots, query, chip }),
		[data.entries, data.connections, data.composioConnections, data.bots, composio.logos, composio.state, query, chip],
	);
	const chips = React.useMemo(() => buildChips(data.entries, data.composioCategories), [data.entries, data.composioCategories]);
	const connectedCount = React.useMemo(() => connectedItems({ entries: data.entries, connections: data.connections, composioConnections: data.composioConnections }).length, [data.entries, data.connections, data.composioConnections]);

	const close = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const openApp = React.useCallback(
(item: AppItem) => router.push({ pathname: "/apps/[id]", params: appRouteParams(item) } as never),
		[router],
	);
	const loadMore = composio.loadMore;
	const more = React.useCallback(
		(target: "composio" | "bots") => {
			if (target === "composio") loadMore();
			else setChip("bots");
		},
		[loadMore],
	);

	return (
		<AppsView
			load={data.status === "ready" ? { status: "ready" } : data.status === "error" ? { status: "error", message: data.error ?? "" } : { status: "loading" }}
			rows={rows}
			chips={chips}
			chip={chip}
			onChip={setChip}
			query={query}
			onQuery={setQuery}
			connectedCount={connectedCount}
			installed={installed}
			composioLoading={composio.state.status === "loading" && data.composioConfigured && (chip === "" || composioCategoryOf(chip) !== null)}
			onOpenConnected={() => router.push("/apps/connected" as never)}
			onClose={close}
			onOpenApp={openApp}
			onOpenBot={(slug) => router.push(`/catalog/${encodeURIComponent(slug)}` as never)}
			onMore={more}
			onRetry={() => (data.status === "error" ? void reload() : composio.retry())}
		/>
	);
}
