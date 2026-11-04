import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useRouter } from "expo-router";
import * as React from "react";
import { View } from "react-native";
import { CopyIcon } from "@/components/icons";
import { ChromeButton } from "@/components/ui/chrome-button";
import { DraggableSheet } from "@/components/ui/draggable-sheet";
import { Text } from "@/components/ui/text";
import { AppsView } from "@/components/apps/apps-view";
import { type AppItem, type ComposioState, appRouteParams, buildAppsRows, buildChips, composioCategoryOf, composioWantsMore, connectedItems } from "@/lib/apps";
import { beginAppsDiagnostics, log, logRender } from "@/lib/apps-diagnostics";
import { createEndReachedGate } from "@/lib/composio-paging";
import { useAppsData, useComposioList, useDebounced } from "@/lib/use-apps-data";
import { useInstalledSlugs } from "@/lib/use-installed-slugs";

/** Aplicativos (a grade da home): conectados, destaque, nativos por categoria, apps do Composio e bots, com busca e chips. */
export default function AppsScreen() {
	const router = useRouter();
	// DIAGNÓSTICO TEMPORÁRIO: lê e guarda o registro da vez anterior ANTES de a carga nova começar a sobrescrevê-lo.
	const [previousLog] = React.useState(() => beginAppsDiagnostics());
	const [logOpen, setLogOpen] = React.useState(false);
	const [logText, setLogText] = React.useState<string | null>(null);
	const openLog = React.useCallback(() => {
		setLogOpen(true);
		void previousLog.then(setLogText);
	}, [previousLog]);
	const data = useAppsData();
	const installed = useInstalledSlugs();
	const [query, setQuery] = React.useState("");
	const [chip, setChip] = React.useState("");
	// O filtro local responde na hora; o servidor (Composio) só é perguntado depois de uma pausa na digitação.
	const serverQuery = useDebounced(query.trim(), 350);
	const composio = useComposioList({
		enabled: data.status === "ready" && !data.composioLoading && data.composioConfigured && !data.composioFailed,
		query: serverQuery,
		category: composioCategoryOf(chip),
	});

	const { reload } = data;
	// Ao abrir e ao voltar do detalhe (depois de conectar ou desconectar), o estado dos botões é relido em silêncio.
	useFocusEffect(
		React.useCallback(() => {
			log("foco: reload");
			void reload();
		}, [reload]),
	);

	// Estado do Composio que a tela mostra: falha ao ler o status/conexões é erro (com "Tentar de novo"), não "desligado".
	const composioState: ComposioState = React.useMemo(() => (data.composioLoading ? { status: "loading" } : data.composioFailed ? { status: "error" } : composio.state), [data.composioLoading, data.composioFailed, composio.state]);
	const rows = React.useMemo(
		() =>
			buildAppsRows({
				entries: data.entries,
				connections: data.connections,
				composioConnections: data.composioConnections,
				composioLogos: composio.logos,
				composio: composioState,
				bots: data.bots,
				query,
				chip,
			}),
		[data.entries, data.connections, data.composioConnections, data.bots, composio.logos, composioState, query, chip],
	);
	const chips = React.useMemo(() => buildChips(data.entries, data.composioCategories), [data.entries, data.composioCategories]);
	const connectedCount = React.useMemo(
		() =>
			connectedItems({
				entries: data.entries,
				connections: data.connections,
				composioConnections: data.composioConnections,
			}).length,
		[data.entries, data.connections, data.composioConnections],
	);

	logRender({
		status: data.status,
		linhas: rows.length,
		chips: chips.length,
		categorias: data.composioCategories.length,
		nativos: data.entries.length,
		conexoes: data.connections.length,
		conexoesComposio: data.composioConnections.length,
		bots: data.bots?.length ?? -1,
		composio: composioState.status,
		itensComposio: composioState.status === "ready" ? composioState.items.length : -1,
		logos: composio.logos.size,
	});

	const close = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const openApp = React.useCallback(
		(item: AppItem) =>
			router.push({
				pathname: "/apps/[id]",
				params: appRouteParams(item),
			} as never),
		[router],
	);
	const loadMore = composio.loadMore;
	// Uma página por gesto: sem o dedo a rolar, páginas todas filtradas não encadeiam o catálogo inteiro.
	const gate = React.useMemo(() => createEndReachedGate(), []);
	const onEndReached = React.useCallback(() => {
		const wants = composioWantsMore(composioState);
		log("onEndReached", { quer: wants ? 1 : 0 });
		if (wants && gate.take()) loadMore();
	}, [composioState, gate, loadMore]);
	const more = React.useCallback(
		(target: "composio" | "bots") => {
			if (target === "composio") loadMore();
			else setChip("bots");
		},
		[loadMore],
	);

	return (
		<>
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
				composioLoading={composioState.status === "loading" && (data.composioLoading || data.composioConfigured) && (chip === "" || composioCategoryOf(chip) !== null)}
				onOpenConnected={() => router.push("/apps/connected" as never)}
				onClose={close}
				onOpenApp={openApp}
				onOpenBot={(slug) => router.push(`/catalog/${encodeURIComponent(slug)}` as never)}
				onMore={more}
				onEndReached={onEndReached}
				onUserScroll={gate.arm}
				onRetry={() => (data.status === "error" || data.composioFailed ? void reload() : composio.retry())}
				onTitleLongPress={openLog}
			/>
			<DraggableSheet
				visible={logOpen}
				onClose={() => setLogOpen(false)}
				fullHeight
				header={
					<View className="flex-row items-center gap-3 px-4 pb-3">
						<Text variant="heading" className="flex-1">
							Registro da última vez
						</Text>
						<ChromeButton size="sm" label="Copiar registro" onPress={() => void Clipboard.setStringAsync(logText ?? "")}>
							<CopyIcon size={18} />
						</ChromeButton>
					</View>
				}
			>
				<Text selectable className="pb-8 font-mono text-caption">
					{logText === null ? "Lendo…" : logText || "Nenhum registro guardado ainda. Abra Aplicativos, saia e volte."}
				</Text>
			</DraggableSheet>
		</>
	);
}
