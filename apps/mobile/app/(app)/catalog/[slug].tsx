import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import { CatalogDetailView, type DetailDone, type DetailLoad } from "@/components/catalog/catalog-detail-view";
import { useAtlasSession } from "@/lib/atlas-session";
import { catalogErrorText, fetchCatalogBot, fetchModelNames, installCatalogBot } from "@/lib/catalog-api";
import { createCatalogInstaller, type InstallInput } from "@/lib/catalog-install";
import { installedSlugs, type InstalledMap } from "@/lib/catalog-installed";
import { loadInstalled, saveInstall } from "@/lib/catalog-installed-store";
import { isUnauthorized } from "@/lib/chat-api";
import { ensureHomeBot } from "@/lib/ensure-bot";
import { useHomeData } from "@/lib/home-data";
import { fetchHomeBot } from "@/lib/home-sync";
import { createRoutine } from "@/lib/routines-api";

/**
 * Detalhe e instalação de um bot do catálogo. Instalado sem avisos, a tela dá lugar ao chat do bot novo (onde já está a
 * primeira mensagem; voltar do chat leva à home). Com avisos (habilidade pulada, rotina que falhou), mostra o resultado
 * antes de abrir a conversa.
 */
export default function CatalogBotScreen() {
	const router = useRouter();
	const { slug } = useLocalSearchParams<{ slug: string }>();
	const { apiFetch, signOut } = useAtlasSession();
	const { snapshot, addBot, refresh } = useHomeData();
	const [load, setLoad] = React.useState<DetailLoad>({ status: "loading" });
	const [modelName, setModelName] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [done, setDone] = React.useState<DetailDone | null>(null);
	const [installedMap, setInstalledMap] = React.useState<InstalledMap>({});
	const latest = React.useRef({ apiFetch, signOut, addBot, refresh });
	latest.current = { apiFetch, signOut, addBot, refresh };
	const mounted = React.useRef(true);
	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const reload = React.useCallback(() => {
		setLoad({ status: "loading" });
		fetchCatalogBot(latest.current.apiFetch, slug).then(
			(detail) => {
				if (!mounted.current) return;
				setLoad({ status: "ready", detail });
				// O nome de exibição do modelo só enfeita a tela: sem nome, a opção some (o id interno nunca aparece).
				if (detail.suggestedModel) {
					const model = detail.suggestedModel;
					void fetchModelNames(latest.current.apiFetch).then((names) => mounted.current && setModelName(names[model] ?? null));
				}
			},
			(reason) => {
				if (isUnauthorized(reason)) void latest.current.signOut();
				if (mounted.current) setLoad({ status: "error", message: catalogErrorText(reason, "detail") });
			},
		);
	}, [slug]);
	React.useEffect(() => {
		reload();
		void loadInstalled().then(setInstalledMap);
	}, [reload]);

	// Um instalador por abertura da tela: o toque duplo e o "já instalado" valem para ele.
	const installer = React.useMemo(
		() =>
			createCatalogInstaller({
				install: (wanted, body) => installCatalogBot(latest.current.apiFetch, wanted, body),
				createRoutine: (botId, routine) => createRoutine(latest.current.apiFetch, botId, routine),
				ensureBot: (botId) => ensureHomeBot({ fetchBot: (wanted) => fetchHomeBot(latest.current.apiFetch, wanted), addBot: (bot) => latest.current.addBot(bot), refresh: (options) => latest.current.refresh(options) }, botId),
				remember: saveInstall,
				onUnauthorized: () => void latest.current.signOut(),
			}),
		[],
	);

	const openChat = React.useCallback(
		(botId: string) => {
			// Fecha o catálogo inteiro (lista e detalhe) e abre o chat: voltar do chat leva à home.
			router.dismissAll();
			router.push(`/chat/${encodeURIComponent(botId)}` as never);
		},
		[router],
	);
	const install = async (input: InstallInput) => {
		setBusy(true);
		setError(null);
		const outcome = await installer(slug, input);
		if (outcome === null || !mounted.current) return;
		if (!outcome.ok) {
			setBusy(false);
			setError(outcome.error);
			return;
		}
		if (outcome.warnings.length === 0) return openChat(outcome.botId);
		setBusy(false);
		setDone({ botId: outcome.botId, name: outcome.name, warnings: outcome.warnings });
	};

	const alreadyInstalled = installedSlugs(installedMap, (snapshot?.bots ?? []).map((bot) => bot.id)).has(slug);
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	return <CatalogDetailView load={load} modelName={modelName} alreadyInstalled={alreadyInstalled} busy={busy} error={error} done={done} onInstall={(input) => void install(input)} onOpenChat={() => done && openChat(done.botId)} onBack={back} onRetry={reload} />;
}
