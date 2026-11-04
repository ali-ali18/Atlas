import * as React from "react";
import { cacheKey, loadHomeCache, saveHomeCache } from "@/lib/home-cache";
import { homeStorage } from "@/lib/home-storage";
import { HomeSyncController, type SyncDeps } from "@/lib/home-sync-controller";
import { routinesStore } from "@/lib/routines-store";
import { PendingBotPatches } from "@/lib/home-patches";
import type { HomeBot, SectionRef } from "@/lib/home-types";
import { snapshotWithoutSection } from "@/lib/section-actions";
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
	/** `fresh`: descarta a atualização em voo e busca de novo (use depois de criar algo no servidor). */
	refresh: (options?: { fresh?: boolean }) => Promise<void>;
	/** Aplica na lista (e no cache do aparelho) o que acabou de ser salvo no servidor, sem esperar a próxima atualização. */
	applyBotUpdate: (botId: string, patch: Partial<Pick<HomeBot, "name" | "color" | "shape" | "language" | "pinned" | "pinOrder" | "sectionId" | "unread">>) => void;
	/**
	 * Insere no topo da lista (e no cache do aparelho) um bot que acabou de ser criado no servidor. Uma atualização que já
	 * estava em voo não o conhece e não o apaga (ver `PendingBotPatches.addBot`).
	 */
	addBot: (bot: HomeBot) => void;
	/** Renomeia ou reordena uma seção na lista (e no cache) antes da resposta do servidor. */
	applySectionUpdate: (sectionId: string, patch: Partial<Pick<SectionRef, "name" | "order">>) => void;
	/** Troca o `order` de duas seções de uma vez (mover para cima/baixo). */
	applySectionsReplace: (sections: SectionRef[]) => void;
	/** Apaga a seção e solta os bots (`sectionId` -> null), como no web. */
	applySectionRemoved: (sectionId: string) => void;
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
	const pendingPatches = React.useRef(new PendingBotPatches());
	const keyRef = React.useRef(key);
	keyRef.current = key;

	// O controlador é um só; as dependências mudam a cada render e ele lê sempre as de agora.
	const depsRef = React.useRef<SyncDeps | null>(null);
	depsRef.current = {
		fetch: async (signal) => {
			// Edição salva durante a atualização não pode ser desfeita por ela: reaplica o que for mais novo que o início.
			const marker = pendingPatches.current.mark();
			const result = await fetchHome(apiFetch, signal);
			return result.ok ? { ...result, snapshot: pendingPatches.current.applyOver(result.snapshot, marker) } : result;
		},
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
		pendingPatches.current.clear();
		routinesStore.reset();
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

	const refresh = React.useCallback(async (options?: { fresh?: boolean }) => {
		if (!key) return;
		setRefreshing(true);
		try {
			await controller.run(key, options?.fresh === true);
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

	const snapshotRef = React.useRef(snapshot);
	snapshotRef.current = snapshot;
	const persistSnapshot = React.useCallback((next: HomeSnapshot) => {
		snapshotRef.current = next;
		setSnapshot(next);
		const cacheKeyNow = keyRef.current;
		if (cacheKeyNow) void saveHomeCache(homeStorage, cacheKeyNow, next, Date.now());
	}, []);

	const addBot = React.useCallback<HomeData["addBot"]>((created) => {
		pendingPatches.current.addBot(created);
		const current = snapshotRef.current;
		if (!current) return;
		persistSnapshot({ ...current, bots: [created, ...current.bots.filter((bot) => bot.id !== created.id)] });
	}, [persistSnapshot]);

	const applyBotUpdate = React.useCallback<HomeData["applyBotUpdate"]>((botId, patch) => {
		const current = snapshotRef.current;
		if (!current) return;
		pendingPatches.current.add(botId, patch);
		persistSnapshot({ ...current, bots: current.bots.map((bot) => (bot.id === botId ? { ...bot, ...patch } : bot)) });
	}, [persistSnapshot]);

	const applySectionUpdate = React.useCallback<HomeData["applySectionUpdate"]>((sectionId, patch) => {
		const current = snapshotRef.current;
		if (!current) return;
		persistSnapshot({
			...current,
			sections: current.sections.map((section) => (section.id === sectionId ? { ...section, ...patch } : section)),
		});
	}, [persistSnapshot]);

	const applySectionsReplace = React.useCallback<HomeData["applySectionsReplace"]>((sections) => {
		const current = snapshotRef.current;
		if (!current) return;
		persistSnapshot({ ...current, sections: [...sections] });
	}, [persistSnapshot]);

	const applySectionRemoved = React.useCallback<HomeData["applySectionRemoved"]>((sectionId) => {
		const current = snapshotRef.current;
		if (!current) return;
		const { sections, bots } = snapshotWithoutSection(current, sectionId);
		persistSnapshot({ ...current, sections, bots: bots as HomeBot[] });
	}, [persistSnapshot]);

	const value = React.useMemo<HomeData>(
		() => ({ snapshot, refreshing, error, prepare, refresh, applyBotUpdate, addBot, applySectionUpdate, applySectionsReplace, applySectionRemoved }),
		[snapshot, refreshing, error, prepare, refresh, applyBotUpdate, addBot, applySectionUpdate, applySectionsReplace, applySectionRemoved],
	);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}
