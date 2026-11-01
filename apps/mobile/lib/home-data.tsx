import * as React from "react";
import { cacheKey, loadHomeCache, saveHomeCache } from "@/lib/home-cache";
import { homeStorage } from "@/lib/home-storage";
import { HomeSyncController, type SyncDeps } from "@/lib/home-sync-controller";
import { fetchHome, type HomeSnapshot, type SyncFailure } from "@/lib/home-sync";
import { useAtlasSession } from "@/lib/atlas-session";

export type HomeData = {
	snapshot: HomeSnapshot | null;
	/** Atualizando por cima do que já está na tela (puxar para atualizar ou segundo plano). */
	refreshing: boolean;
	/** Última falha da rede; `null` depois de uma atualização boa. Com `snapshot`, a tela mostra um aviso discreto. */
	error: SyncFailure | null;
	/**
	 * Carregamento inicial: abre pelo cache (e atualiza em segundo plano) ou, sem cache, espera a rede.
	 * Devolve `ready` quando há o que mostrar; `signed-out` quando o servidor recusou a sessão ou a conta saiu no meio.
	 */
	prepare: () => Promise<"ready" | "empty" | "signed-out">;
	refresh: () => Promise<void>;
};

const Context = React.createContext<HomeData | null>(null);

export function useHomeData(): HomeData {
	const value = React.useContext(Context);
	if (!value) throw new Error("useHomeData fora do HomeDataProvider");
	return value;
}

/** Guarda bots e seções da conta em memória e no cache do aparelho. Vive acima das telas: tudo troca de rota sem perder o estado. */
export function HomeDataProvider({ children }: { children: React.ReactNode }) {
	const { phase, apiFetch, email, serverUrl, signOut, onSignOut } = useAtlasSession();
	const [snapshot, setSnapshot] = React.useState<HomeSnapshot | null>(null);
	const [refreshing, setRefreshing] = React.useState(false);
	const [error, setError] = React.useState<SyncFailure | null>(null);
	const key = serverUrl && email ? cacheKey(serverUrl, email) : null;
	const keyRef = React.useRef(key);
	keyRef.current = key;

	// O controlador é um só; as dependências mudam a cada render e ele lê sempre as de agora.
	const depsRef = React.useRef<SyncDeps | null>(null);
	depsRef.current = {
		fetch: (signal) => fetchHome(apiFetch, signal),
		save: async (cacheKeyOfRun, value) => saveHomeCache(homeStorage, cacheKeyOfRun, value, Date.now()),
		onSnapshot: (value) => {
			setSnapshot(value);
			setError(null);
		},
		onError: setError,
		onUnauthorized: signOut,
	};
	const controller = React.useMemo(
		() =>
			new HomeSyncController(() => {
				if (!depsRef.current) throw new Error("HomeDataProvider sem dependências");
				return depsRef.current;
			}),
		[],
	);

	// Outra conta ou outro servidor: o que estava em voo morre e nada dele chega à tela nem ao disco.
	React.useEffect(() => {
		controller.invalidate();
		setRefreshing(false);
	}, [key, controller]);

	// Saída pedida pelo usuário: aborta antes de o cache ser apagado (o `signOut` da sessão avisa).
	React.useEffect(
		() =>
			onSignOut(() => {
				controller.invalidate();
				setSnapshot(null);
				setError(null);
				setRefreshing(false);
			}),
		[onSignOut, controller],
	);

	// Sessão que caiu por fora (expirou, revogada): some da memória; o cache é apagado por quem sai ou por `signOut`.
	React.useEffect(() => {
		if (phase !== "signed-out" && phase !== "no-server") return;
		controller.invalidate();
		setSnapshot(null);
		setError(null);
	}, [phase, controller]);

	const refresh = React.useCallback(async () => {
		if (!key) return;
		setRefreshing(true);
		try {
			await controller.run(key);
		} finally {
			setRefreshing(false);
		}
	}, [key, controller]);

	const prepare = React.useCallback(async () => {
		if (!key) return "signed-out" as const;
		const cached = await loadHomeCache(homeStorage, key, Date.now());
		// Saiu ou trocou de conta enquanto lia o disco: nada disto pode aparecer.
		if (keyRef.current !== key) return "signed-out" as const;
		if (cached) {
			setSnapshot(cached.snapshot);
			void refresh();
			return "ready" as const;
		}
		const outcome = await controller.run(key);
		if (outcome === "signed-out" || outcome === "cancelled") return "signed-out" as const;
		return outcome === "ok" ? ("ready" as const) : ("empty" as const);
	}, [key, refresh, controller]);

	const value = React.useMemo<HomeData>(() => ({ snapshot, refreshing, error, prepare, refresh }), [snapshot, refreshing, error, prepare, refresh]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
