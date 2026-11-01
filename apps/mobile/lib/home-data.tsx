import AsyncStorage from "@react-native-async-storage/async-storage";
import * as React from "react";
import { cacheKey, clearHomeCache, loadHomeCache, saveHomeCache, type CacheStorage } from "@/lib/home-cache";
import { fetchHome, type HomeSnapshot, type SyncFailure } from "@/lib/home-sync";
import { useAtlasSession } from "@/lib/atlas-session";

const FETCH_TIMEOUT_MS = 10_000;
const storage: CacheStorage = AsyncStorage as unknown as CacheStorage;

export type HomeData = {
	snapshot: HomeSnapshot | null;
	/** Atualizando por cima do que já está na tela (puxar para atualizar ou segundo plano). */
	refreshing: boolean;
	/** Última falha da rede; `null` depois de uma atualização boa. Com `snapshot`, a tela mostra um aviso discreto. */
	error: SyncFailure | null;
	/**
	 * Carregamento inicial: abre pelo cache (e atualiza em segundo plano) ou, sem cache, espera a rede.
	 * Devolve `ready` quando há o que mostrar; `signed-out` quando o servidor recusou a sessão.
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
	const { phase, apiFetch, email, serverUrl, signOut } = useAtlasSession();
	const [snapshot, setSnapshot] = React.useState<HomeSnapshot | null>(null);
	const [refreshing, setRefreshing] = React.useState(false);
	const [error, setError] = React.useState<SyncFailure | null>(null);
	const inflight = React.useRef<Promise<"ok" | "failed" | "signed-out"> | null>(null);
	const key = serverUrl && email ? cacheKey(serverUrl, email) : null;

	// Saiu da conta ou trocou de servidor: some da memória e do aparelho (nada da conta anterior fica).
	React.useEffect(() => {
		if (phase !== "signed-out" && phase !== "no-server") return;
		setSnapshot(null);
		setError(null);
		void clearHomeCache(storage);
	}, [phase]);

	const sync = React.useCallback((): Promise<"ok" | "failed" | "signed-out"> => {
		if (inflight.current) return inflight.current;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const run = (async () => {
			const result = await fetchHome(apiFetch, controller.signal);
			if (result.ok) {
				setSnapshot(result.snapshot);
				setError(null);
				if (key) await saveHomeCache(storage, key, result.snapshot, Date.now());
				return "ok" as const;
			}
			if (result.reason === "unauthorized") {
				await signOut();
				return "signed-out" as const;
			}
			setError(result.reason);
			return "failed" as const;
		})().finally(() => {
			clearTimeout(timer);
			inflight.current = null;
		});
		inflight.current = run;
		return run;
	}, [apiFetch, key, signOut]);

	const refresh = React.useCallback(async () => {
		setRefreshing(true);
		try {
			await sync();
		} finally {
			setRefreshing(false);
		}
	}, [sync]);

	const prepare = React.useCallback(async () => {
		const cached = key ? await loadHomeCache(storage, key, Date.now()) : null;
		if (cached) {
			setSnapshot(cached.snapshot);
			void refresh();
			return "ready" as const;
		}
		const outcome = await sync();
		if (outcome === "signed-out") return "signed-out" as const;
		return outcome === "ok" ? ("ready" as const) : ("empty" as const);
	}, [key, refresh, sync]);

	const value = React.useMemo<HomeData>(() => ({ snapshot, refreshing, error, prepare, refresh }), [snapshot, refreshing, error, prepare, refresh]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
