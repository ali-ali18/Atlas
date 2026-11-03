// Estado do seletor de modelo do chat: a escolha (salva por conversa), o catálogo (lido da API quando a folha abre) e
// os campos que o envio põe no corpo do run. A regra (corpo do run, chave, leitura inválida) é pura em `model-choice.ts`.
import * as React from "react";
import { isUnauthorized } from "./chat-api";
import { homeStorage } from "./home-storage";
import { useAtlasSession } from "./atlas-session";
import { fetchModelCatalog } from "./model-catalog-api";
import { findOption, type ModelCatalog } from "./model-catalog";
import { loadModelChoice, modelChoiceKey, runModelFields, saveModelChoice, type ModelChoice, type RunModelFields } from "./model-choice";

/** Catálogo mais velho que isto é relido ao abrir a folha (o resto do tempo vale o da tela). */
export const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

export type CatalogState = { status: "idle" | "loading" | "ready" | "error"; catalog: ModelCatalog | null };

export type ModelSelector = {
	choice: ModelChoice | null;
	setChoice: (choice: ModelChoice) => void;
	catalog: CatalogState;
	/** Abre a folha: lê o catálogo se ainda não tem, está velho ou falhou. */
	loadCatalog: () => void;
	/** Campos de modelo do próximo run, lidos na hora do envio. */
	fields: () => RunModelFields;
	/** Um envio criou a conversa deste chat novo: a escolha feita antes passa a valer (e ser salva) nela. */
	onConversationCreated: (conversationId: string) => void;
};

export function useModelSelector(botId: string | null, conversationId: string | null, onUnauthorized: () => void): ModelSelector {
	const { apiFetch, serverUrl, email } = useAtlasSession();
	const [choice, setChoiceState] = React.useState<ModelChoice | null>(null);
	const [catalog, setCatalog] = React.useState<CatalogState>({ status: "idle", catalog: null });
	// O que as chamadas assíncronas e o envio leem sempre vem daqui, nunca de um render antigo.
	const live = React.useRef({ choice, catalog, conversationId, serverUrl, email, apiFetch, onUnauthorized, loadedAt: 0 });
	live.current = { ...live.current, choice, catalog, conversationId, serverUrl, email, apiFetch, onUnauthorized };
	// Escolha feita num chat novo (sem conversa): vale para a conversa que o envio criar.
	const pending = React.useRef(false);

	// Outro bot = outro catálogo (o modelo fixo e o ✓ são do bot).
	// biome-ignore lint/correctness/useExhaustiveDependencies: só reinicia quando o bot muda
	React.useEffect(() => {
		live.current.loadedAt = 0;
		setCatalog({ status: "idle", catalog: null });
	}, [botId]);

	const keyFor = React.useCallback((id: string) => {
		const { serverUrl: server, email: account } = live.current;
		return server && account ? modelChoiceKey(server, account, id) : null;
	}, []);

	// Abriu (ou trocou de) conversa: lê a escolha salva dela. Chat novo sem conversa: escolha em memória até o envio.
	React.useEffect(() => {
		if (!conversationId) return;
		const key = keyFor(conversationId);
		if (!key) return;
		if (pending.current) {
			pending.current = false;
			void saveModelChoice(homeStorage, key, live.current.choice);
			return;
		}
		let cancelled = false;
		void loadModelChoice(homeStorage, key).then((saved) => {
			if (cancelled) return;
			setChoiceState(saved);
		});
		return () => {
			cancelled = true;
		};
	}, [conversationId, keyFor, serverUrl, email]);

	const setChoice = React.useCallback(
		(next: ModelChoice) => {
			live.current.choice = next;
			setChoiceState(next);
			const id = live.current.conversationId;
			const key = id ? keyFor(id) : null;
			if (id && key) void saveModelChoice(homeStorage, key, next);
			else pending.current = true;
		},
		[keyFor],
	);

	const loadCatalog = React.useCallback(() => {
		if (!botId) return;
		const { catalog: current, loadedAt } = live.current;
		if (current.status === "loading") return;
		if (current.status === "ready" && Date.now() - loadedAt < CATALOG_MAX_AGE_MS) return;
		setCatalog((previous) => ({ status: "loading", catalog: previous.catalog }));
		void fetchModelCatalog(live.current.apiFetch, botId).then(
			(next) => {
				live.current.loadedAt = Date.now();
				setCatalog({ status: "ready", catalog: next });
			},
			(reason) => {
				if (isUnauthorized(reason)) live.current.onUnauthorized();
				setCatalog((previous) => ({ status: "error", catalog: previous.catalog }));
			},
		);
	}, [botId]);

	const fields = React.useCallback(() => runModelFields(live.current.choice, (id) => findOption(live.current.catalog.catalog, id)?.info), []);

	const onConversationCreated = React.useCallback(
		(id: string) => {
			const key = keyFor(id);
			if (key && live.current.choice) void saveModelChoice(homeStorage, key, live.current.choice);
			pending.current = false;
		},
		[keyFor],
	);

	return React.useMemo(() => ({ choice, setChoice, catalog, loadCatalog, fields, onConversationCreated }), [choice, setChoice, catalog, loadCatalog, fields, onConversationCreated]);
}
