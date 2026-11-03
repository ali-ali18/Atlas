// Estado do seletor de modelo do chat: a escolha (salva por conversa), o catálogo (lido da API quando a folha abre) e
// os campos que o envio põe no corpo do run. As decisões (corpo do run, chave, reconciliação ao ler, modelo que sumiu)
// são puras em `model-choice.ts`; aqui só há estado e efeitos.
import * as React from "react";
import { isUnauthorized } from "./chat-api";
import { homeStorage } from "./home-storage";
import { useAtlasSession } from "./atlas-session";
import { fetchModelCatalog } from "./model-catalog-api";
import { findOption, type ModelCatalog } from "./model-catalog";
import { loadModelChoice, modelChoiceKey, reconcileLoaded, reconcileWithCatalog, runModelFields, saveModelChoice, type ModelChoice, type RunModelFields } from "./model-choice";

/** Catálogo mais velho que isto é relido ao abrir a folha (o resto do tempo vale o da tela). */
export const CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

export const MODEL_GONE_NOTICE = "O modelo escolhido não está mais disponível; voltei ao modelo do bot.";

export type CatalogState = { status: "idle" | "loading" | "ready" | "error"; catalog: ModelCatalog | null };

export type ModelSelector = {
	choice: ModelChoice | null;
	setChoice: (choice: ModelChoice) => void;
	catalog: CatalogState;
	/** Aviso para a folha (ex.: a escolha salva sumiu do catálogo). */
	notice: string | null;
	/** Abre a folha: lê o catálogo se ainda não tem, está velho ou falhou. */
	loadCatalog: () => void;
	/** Campos de modelo do próximo run, lidos na hora do envio. */
	fields: () => RunModelFields;
	/** Um envio criou a conversa deste chat novo: a escolha feita antes passa a valer (e ser salva) nela. */
	onConversationCreated: (conversationId: string) => void;
	/** O servidor recusou o modelo enviado: apaga a escolha (volta ao modelo do bot). */
	onModelRejected: () => void;
};

export function useModelSelector(botId: string | null, conversationId: string | null, onUnauthorized: () => void): ModelSelector {
	const { apiFetch, serverUrl, email } = useAtlasSession();
	const [choice, setChoiceState] = React.useState<ModelChoice | null>(null);
	const [catalog, setCatalog] = React.useState<CatalogState>({ status: "idle", catalog: null });
	const [notice, setNotice] = React.useState<string | null>(null);
	// O que as chamadas assíncronas e o envio leem sempre vem daqui, nunca de um render antigo.
	const live = React.useRef({ choice, catalog, conversationId, botId, serverUrl, email, apiFetch, onUnauthorized, loadedAt: 0, edits: 0 });
	live.current = { ...live.current, choice, catalog, conversationId, botId, serverUrl, email, apiFetch, onUnauthorized };
	// Escolha feita num chat novo (sem conversa): vale para a conversa que o envio criar.
	const pending = React.useRef(false);
	const previousConversation = React.useRef<string | null>(null);

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

	const apply = React.useCallback((next: ModelChoice | null) => {
		live.current.choice = next;
		setChoiceState(next);
	}, []);

	// Abriu (ou trocou de) conversa: lê a escolha salva dela. Chat novo sem conversa: escolha em memória até o envio.
	React.useEffect(() => {
		const previousConversationId = previousConversation.current;
		previousConversation.current = conversationId;
		if (!conversationId) return;
		const key = keyFor(conversationId);
		if (!key) return;
		if (pending.current) {
			pending.current = false;
			void saveModelChoice(homeStorage, key, live.current.choice);
			return;
		}
		const editsAtStart = live.current.edits;
		let cancelled = false;
		void loadModelChoice(homeStorage, key).then((saved) => {
			if (cancelled) return;
			apply(reconcileLoaded({ saved, current: live.current.choice, previousConversationId, changedDuringLoad: live.current.edits !== editsAtStart }));
		});
		return () => {
			cancelled = true;
		};
	}, [conversationId, keyFor, serverUrl, email, apply]);

	const persist = React.useCallback(
		(next: ModelChoice | null) => {
			const id = live.current.conversationId;
			const key = id ? keyFor(id) : null;
			if (id && key) void saveModelChoice(homeStorage, key, next);
			else pending.current = next !== null;
		},
		[keyFor],
	);

	const setChoice = React.useCallback(
		(next: ModelChoice) => {
			live.current.edits += 1;
			apply(next);
			persist(next);
			setNotice(null);
		},
		[apply, persist],
	);

	const onModelRejected = React.useCallback(() => {
		live.current.edits += 1;
		apply(null);
		persist(null);
		setNotice(MODEL_GONE_NOTICE);
	}, [apply, persist]);

	const loadCatalog = React.useCallback(() => {
		const requestedFor = live.current.botId;
		if (!requestedFor) return;
		const { catalog: current, loadedAt } = live.current;
		if (current.status === "loading") return;
		if (current.status === "ready" && Date.now() - loadedAt < CATALOG_MAX_AGE_MS) return;
		setCatalog((previous) => ({ status: "loading", catalog: previous.catalog }));
		void fetchModelCatalog(live.current.apiFetch, requestedFor).then(
			(next) => {
				// Trocou de bot no meio da leitura: o catálogo é de outro bot, descarta.
				if (live.current.botId !== requestedFor) return;
				live.current.loadedAt = Date.now();
				setCatalog({ status: "ready", catalog: next });
				const kept = reconcileWithCatalog(live.current.choice, next);
				if (kept !== live.current.choice) {
					live.current.edits += 1;
					apply(kept);
					persist(kept);
					setNotice(MODEL_GONE_NOTICE);
				}
			},
			(reason) => {
				if (isUnauthorized(reason)) live.current.onUnauthorized();
				if (live.current.botId !== requestedFor) return;
				setCatalog((previous) => ({ status: "error", catalog: previous.catalog }));
			},
		);
	}, [apply, persist]);

	const fields = React.useCallback(() => runModelFields(live.current.choice, (id) => findOption(live.current.catalog.catalog, id)?.info), []);

	const onConversationCreated = React.useCallback(
		(id: string) => {
			const key = keyFor(id);
			if (key && live.current.choice) void saveModelChoice(homeStorage, key, live.current.choice);
			pending.current = false;
		},
		[keyFor],
	);

	return React.useMemo(
		() => ({ choice, setChoice, catalog, notice, loadCatalog, fields, onConversationCreated, onModelRejected }),
		[choice, setChoice, catalog, notice, loadCatalog, fields, onConversationCreated, onModelRejected],
	);
}
