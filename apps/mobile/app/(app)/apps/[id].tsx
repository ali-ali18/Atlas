import { useLocalSearchParams, useRouter } from "expo-router";
import * as React from "react";
import * as WebBrowser from "expo-web-browser";
import { AppDetailView, type AppDetailLoad } from "@/components/apps/app-detail-view";
import { type AppDetail, composioDetail, customDetail, isComposioConnected, isConnectionConnected, isNativeConnected, nativeDetail } from "@/lib/app-detail";
import { appsErrorText, connectComposio, connectNative, disconnectComposio, disconnectNative, fetchComposioConnections, fetchMcpConnections, reauthNative } from "@/lib/apps-api";
import { parseAppRef } from "@/lib/apps";
import { browserUrl, type ConnectResult } from "@/lib/apps-parse";
import { useAtlasSession } from "@/lib/atlas-session";
import { isUnauthorized } from "@/lib/chat-api";
import { runBrowserConnect } from "@/lib/connect-flow";
import { useAppsData } from "@/lib/use-apps-data";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Detalhe de um aplicativo (`native:<id>`, `composio:<slug>` ou `custom:<id>`). Só aqui o botão principal inicia a
 * conexão: OAuth abre o navegador no login do provedor (e o app confere a conexão a cada segundo, por até 90 s); conector
 * de chave conecta com a chave colada no campo.
 */
export default function AppDetailScreen() {
	const router = useRouter();
	const params = useLocalSearchParams<{ id: string; name?: string; description?: string; logo?: string }>();
	const ref = React.useMemo(() => parseAppRef(String(params.id ?? "")), [params.id]);
	const data = useAppsData();
	const { apiFetch, signOut } = useAtlasSession();
	const [apiKey, setApiKey] = React.useState("");
	const [busy, setBusy] = React.useState<"connect" | "disconnect" | null>(null);
	const [waiting, setWaiting] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [confirming, setConfirming] = React.useState(false);
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };
	const mounted = React.useRef(true);
	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const { reload } = data;
	React.useEffect(() => {
		void reload();
	}, [reload]);

	const name = params.name;
	const description = params.description;
	const logo = params.logo;
	const detail: AppDetail | null = React.useMemo(() => {
		if (!ref || data.status !== "ready") return null;
		if (ref.kind === "native") {
			const entry = data.entries.find((item) => item.id === ref.id);
			return entry ? nativeDetail(entry) : null;
		}
		if (ref.kind === "custom") {
			const connection = data.connections.find((item) => item.id === ref.id);
			return connection ? customDetail(connection) : null;
		}
		return composioDetail({ slug: ref.id, name: name || ref.id, description: description ?? "", logo: logo ?? null }, data.composioConnections, data.composioConfigured);
	}, [ref, data.status, data.entries, data.connections, data.composioConnections, data.composioConfigured, name, description, logo]);

	let load: AppDetailLoad;
	if (!ref) load = { status: "missing" };
	else if (data.status === "loading") load = { status: "loading" };
	else if (data.status === "error") load = { status: "error", message: data.error ?? "" };
	else load = detail ? { status: "ready", detail } : { status: "missing" };

	const fail = (reason: unknown, action: "connect" | "disconnect") => {
		if (isUnauthorized(reason)) void latest.current.signOut();
		if (mounted.current) setError(appsErrorText(reason, action));
	};

	const checkConnected = React.useCallback(
		async (target: AppDetail): Promise<boolean> => {
			const fetcher = latest.current.apiFetch;
			if (target.ref.kind === "composio") return isComposioConnected(await fetchComposioConnections(fetcher), target.ref.id);
			const connections = await fetchMcpConnections(fetcher);
			return target.ref.kind === "native" ? isNativeConnected(connections, target.ref.id) : isConnectionConnected(connections, target.ref.id);
		},
		[],
	);

	const start = async (target: AppDetail): Promise<ConnectResult> => {
		const fetcher = latest.current.apiFetch;
		if (target.ref.kind === "composio") return connectComposio(fetcher, target.ref.id);
		if (target.reauthId) return reauthNative(fetcher, target.reauthId);
		return connectNative(fetcher, target.ref.id, target.apiKey ? apiKey : undefined);
	};

	const connect = async () => {
		if (!detail || busy) return;
		setBusy("connect");
		setError(null);
		setNotice(null);
		try {
			const result = await start(detail);
			if (result.kind === "browser") {
				if (mounted.current) setWaiting(true);
				const outcome = await runBrowserConnect(result.url, {
					open: (url) => WebBrowser.openBrowserAsync(url),
					dismiss: () => void WebBrowser.dismissBrowser(),
					check: () => checkConnected(detail),
					now: Date.now,
					sleep,
				});
				if (mounted.current && outcome === "timeout") setNotice("Não consegui confirmar a conexão. Se você terminou o login, volte e confira em “Seus aplicativos”.");
			}
			if (mounted.current) setApiKey("");
			await reload();
		} catch (reason) {
			fail(reason, "connect");
		} finally {
			if (mounted.current) {
				setWaiting(false);
				setBusy(null);
			}
		}
	};

	const disconnect = async () => {
		if (!detail?.disconnectId || busy) return;
		setConfirming(false);
		setBusy("disconnect");
		setError(null);
		setNotice(null);
		try {
			if (detail.ref.kind === "composio") await disconnectComposio(latest.current.apiFetch, detail.disconnectId);
			else await disconnectNative(latest.current.apiFetch, detail.disconnectId);
			await reload();
		} catch (reason) {
			fail(reason, "disconnect");
		} finally {
			if (mounted.current) setBusy(null);
		}
	};

	const back = () => (router.canGoBack() ? router.back() : router.replace("/apps" as never));
	return (
		<AppDetailView
			load={load}
			busy={busy !== null}
			connecting={busy === "connect"}
			waiting={waiting}
			error={error}
			notice={notice}
			apiKey={apiKey}
			onApiKey={setApiKey}
			onPrimary={() => void connect()}
			confirmingDisconnect={confirming}
			onAskDisconnect={() => setConfirming(true)}
			onCancelDisconnect={() => setConfirming(false)}
			onDisconnect={() => void disconnect()}
			onOpenHelp={(url) => {
				// O endereço de ajuda vem do catálogo do servidor: só http(s) abre.
				const safe = browserUrl(url);
				if (safe) void WebBrowser.openBrowserAsync(safe);
			}}
			onBack={back}
			onRetry={() => void reload()}
		/>
	);
}
