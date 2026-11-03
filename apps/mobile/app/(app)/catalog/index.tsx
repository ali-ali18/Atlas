import { useRouter } from "expo-router";
import * as React from "react";
import { CatalogListView, type CatalogLoad } from "@/components/catalog/catalog-list-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { catalogErrorText, fetchCatalog } from "@/lib/catalog-api";
import { installedSlugs, type InstalledMap } from "@/lib/catalog-installed";
import { loadInstalled } from "@/lib/catalog-installed-store";
import { isUnauthorized } from "@/lib/chat-api";
import { useHomeData } from "@/lib/home-data";

/** Catálogo de bots prontos (a grade da home): a lista vem do servidor ao abrir; "Instalado" vem do que este aparelho instalou e ainda está na home. */
export default function CatalogScreen() {
	const router = useRouter();
	const { apiFetch, signOut } = useAtlasSession();
	const { snapshot } = useHomeData();
	const [load, setLoad] = React.useState<CatalogLoad>({ status: "loading" });
	const [query, setQuery] = React.useState("");
	const [category, setCategory] = React.useState("");
	const [installedMap, setInstalledMap] = React.useState<InstalledMap>({});
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };

	const reload = React.useCallback(() => {
		setLoad({ status: "loading" });
		fetchCatalog(latest.current.apiFetch).then(
			(bots) => setLoad({ status: "ready", bots }),
			(reason) => {
				if (isUnauthorized(reason)) void latest.current.signOut();
				setLoad({ status: "error", message: catalogErrorText(reason, "list") });
			},
		);
	}, []);
	React.useEffect(() => {
		reload();
		void loadInstalled().then(setInstalledMap);
	}, [reload]);

	const botIds = React.useMemo(() => (snapshot?.bots ?? []).map((bot) => bot.id), [snapshot]);
	const installed = React.useMemo(() => installedSlugs(installedMap, botIds), [installedMap, botIds]);
	const close = React.useCallback(() => (router.canGoBack() ? router.back() : router.replace("/")), [router]);
	const open = React.useCallback((slug: string) => router.push(`/catalog/${encodeURIComponent(slug)}` as never), [router]);
	return <CatalogListView load={load} installed={installed} query={query} onQuery={setQuery} category={category} onCategory={setCategory} onOpen={open} onRetry={reload} onClose={close} />;
}
