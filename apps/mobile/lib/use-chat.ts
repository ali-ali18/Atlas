// Hook do chat: monta o `ChatController` (lógica sem React, em `chat-controller.ts`) com a sessão, o cache e o
// `AppState`, e entrega o que a tela desenha. Toda chamada passa por `apiFetch`/`openRunStream` da sessão.
import type { OutgoingAttachment } from "./attachments";
import * as React from "react";
import { AppState } from "react-native";
import { useIsFocused } from "expo-router";
import { CHAT_POLL_MS, startFallbackPoller } from "./event-hub-client";
import * as cardApi from "./card-api";
import * as chatApi from "./chat-api";
import type { MobileAvatarState } from "./avatar-activity";
import { useAvatarLive } from "./use-avatar-live";
import { chatCacheKey, createChatCacheWriter, loadChatCache } from "./chat-cache";
import { ChatController, deriveView, type ChatApi, type ChatDeps, type ChatSnapshot } from "./chat-controller";
import type { ChatItem, ReplyQuote } from "./chat-types";
import { clearBotRun, setBotRun } from "./run-store";
import { useAtlasSession } from "./atlas-session";
import { ensureHomeBot } from "./ensure-bot";
import { useHomeData } from "./home-data";
import { fetchHomeBot } from "./home-sync";
import * as WebBrowser from "expo-web-browser";
import { connectApp } from "./connect-app";
import { clearRequestMemory } from "./request-memory";
import { homeStorage } from "./home-storage";
import type { HomeBot } from "./home-types";
import { useModelSelector, type ModelSelector } from "./use-model-selector";

const RESUME_MIN_GAP_MS = 1_500;
/** Um escritor para o app todo: sair da conta o invalida, e gravação em voo se desfaz sozinha. */
export const chatCacheWriter = createChatCacheWriter(homeStorage);

export type ChatHook = ReturnType<typeof deriveView> & {
	phase: ReturnType<ChatController["getSnapshot"]>["live"]["phase"];
	paused: boolean;
	notice: string | null;
	error: string | null;
	/** Um `/compact` rodando: a tela mostra "Compactando a conversa…". */
	compacting: boolean;
	hasMore: boolean;
	loadingOlder: boolean;
	ready: boolean;
	/** Estado do avatar já governado (permanência mínima) e o que o bot está fazendo, em pt-BR (`null` em repouso). */
	avatar: { state: MobileAvatarState; label: string | null };
	loadOlder: () => void;
	send: (text: string, replyTo?: ReplyQuote, attachments?: readonly OutgoingAttachment[]) => void;
	stop: () => void;
	decide: ChatController["decide"];
	resumeLogin: ChatController["resumeLogin"];
	connectLogin: ChatController["connectLogin"];
	connects: ChatSnapshot["connects"];
	answer: ChatController["answer"];
	resolveProposal: ChatController["resolveProposal"];
	react: (messageId: string, emoji: string) => void;
	markUnread: () => Promise<boolean>;
	/** `/compact [foco]`: resume a conversa levada. */
	compact: (focus?: string) => Promise<boolean>;
	retry: () => void;
	dismissError: () => void;
	/** Seletor de modelo do composer (escolha salva por conversa + catálogo). */
	modelSelector: ModelSelector;
};

export function useChat(bot: HomeBot | undefined): ChatHook {
	const { apiFetch, openRunStream, serverUrl, email, signOut, onSignOut, eventHub } = useAtlasSession();
	// Dependências que mudam a cada render: o controlador (um só) lê sempre as de agora.
	const { addBot, applyBotUpdate, refresh } = useHomeData();
	const latest = React.useRef({ unread: bot?.unread === true, apiFetch, openRunStream, serverUrl, email, signOut, addBot, applyBotUpdate, refresh });
	latest.current = { unread: bot?.unread === true, apiFetch, openRunStream, serverUrl, email, signOut, addBot, applyBotUpdate, refresh };
	const modelSelector = useModelSelector(bot?.id ?? null, bot?.conversationId ?? null, () => void signOut());
	// O controlador (um só) lê o seletor de agora na hora do envio.
	const selectorRef = React.useRef(modelSelector);
	selectorRef.current = modelSelector;

	const controller = React.useMemo(() => {
		const api: ChatApi = {
			fetchPage: (conversationId, options) => chatApi.fetchMessagePage(latest.current.apiFetch, conversationId, options),
			createConversation: () => chatApi.createConversation(latest.current.apiFetch),
			createRun: (input) => chatApi.createRun(latest.current.apiFetch, input),
			createRunInput: (runId, content, key, replyToMessageId, attachments) => chatApi.createRunInput(latest.current.apiFetch, runId, content, key, replyToMessageId, attachments),
			cancelRun: (runId) => chatApi.cancelRun(latest.current.apiFetch, runId),
			getRunStatus: (runId) => chatApi.getRunStatus(latest.current.apiFetch, runId),
			listActiveRuns: (conversationId) => chatApi.listActiveRuns(latest.current.apiFetch, conversationId),
			submitQuestionnaire: (input) => chatApi.submitQuestionnaire(latest.current.apiFetch, input),
			setReaction: (messageId, emoji) => chatApi.setReaction(latest.current.apiFetch, messageId, emoji),
			clearReaction: (messageId) => chatApi.clearReaction(latest.current.apiFetch, messageId),
			markConversationUnread: (conversationId) => chatApi.markConversationUnread(latest.current.apiFetch, conversationId),
			compactConversation: (conversationId, focus) => chatApi.compactConversation(latest.current.apiFetch, conversationId, focus),
			resolveBotProposal: (input) => cardApi.resolveBotProposal(latest.current.apiFetch, input),
			resolveBotProfile: (input) => cardApi.resolveBotProfile(latest.current.apiFetch, input),
			resumeRun: (runId, options) => chatApi.resumeRun(latest.current.apiFetch, runId, options),
		};
		const deps: ChatDeps = {
			api,
			openRunStream: (runId) => latest.current.openRunStream(runId),
			subscribeResume: (wake) => {
				const subscription = AppState.addEventListener("change", (state) => state === "active" && wake());
				return () => subscription.remove();
			},
			cacheFor: (conversationId) => {
				const { serverUrl: server, email: account } = latest.current;
				if (!server || !account) return null;
				const key = chatCacheKey(server, account, conversationId);
				return {
					load: async () => (await loadChatCache(homeStorage, key, Date.now()))?.items ?? null,
					save: (items) => chatCacheWriter.write(key, items, Date.now()),
				};
			},
			onUnauthorized: () => void latest.current.signOut(),
			modelFields: () => selectorRef.current.fields(),
			onConversationCreated: (id) => selectorRef.current.onConversationCreated(id),
			onModelRejected: () => selectorRef.current.onModelRejected(),
			// O agente entra na home com a conversa de verdade (busca no servidor) e a atualização seguinte é nova.
			onBotCreated: async (created) => {
				await ensureHomeBot({ fetchBot: (botId) => fetchHomeBot(latest.current.apiFetch, botId), addBot: latest.current.addBot, refresh: latest.current.refresh }, created.id, created);
			},
			onProfileApplied: (botId, patch) => latest.current.applyBotUpdate(botId, patch),
			isUnread: () => latest.current.unread,
			// Leu: o marcador some da home na hora (e fica no cache); o servidor guarda para os outros aparelhos.
			onSeen: ({ botId: seenBotId, conversationId: seenConversationId, lastMessageId }) => {
				if (seenBotId) latest.current.applyBotUpdate(seenBotId, { unread: false });
				void chatApi.markConversationRead(latest.current.apiFetch, seenConversationId, lastMessageId).catch(() => undefined);
			},
			connect: (connector, signal) =>
				connectApp(
					{
						apiFetch: latest.current.apiFetch,
						serverUrl: latest.current.serverUrl,
						open: (url) => WebBrowser.openBrowserAsync(url),
						dismiss: () => WebBrowser.dismissBrowser(),
						appState: {
							subscribe: (listener) => {
								const subscription = AppState.addEventListener("change", listener);
								return () => subscription.remove();
							},
						},
						now: Date.now,
						sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
						onUnauthorized: () => void latest.current.signOut(),
					},
					connector,
					signal,
				),
		};
		return new ChatController(deps, { id: bot?.id ?? null, conversationId: bot?.conversationId ?? null });
		// biome-ignore lint/correctness/useExhaustiveDependencies: um controlador por tela; o bot entra por `update`
	}, []);

	const botId = bot?.id ?? null;
	const conversationId = bot?.conversationId ?? null;
	// Abre o fio e, se o bot mudar (ou ganhar a conversa depois), reabre.
	React.useEffect(() => {
		controller.update({ id: botId, conversationId });
	}, [controller, botId, conversationId]);
	React.useEffect(() => {
		void controller.open();
		return () => controller.dispose();
	}, [controller]);
	// Sair ou trocar de conta: nada do chat vai para o disco depois disso.
	React.useEffect(
		() =>
			onSignOut(() => {
				chatCacheWriter.invalidate();
				clearRequestMemory();
				controller.dispose();
			}),
		[onSignOut, controller],
	);
	// Voltou do segundo plano: confere de novo.
	React.useEffect(() => {
		let last = 0;
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active" || Date.now() - last < RESUME_MIN_GAP_MS) return;
			last = Date.now();
			void controller.resume();
		});
		return () => subscription.remove();
	}, [controller]);

	// Tempo real: avisos da conversa aberta (mensagem e run de outras origens) e `ready`/`resync` do canal. Sem canal
	// (servidor sem hub, caiu de vez) consulta a cada 12 s, só em primeiro plano e com esta tela em foco.
	const focused = useIsFocused();
	const focusedRef = React.useRef(focused);
	focusedRef.current = focused;
	React.useEffect(() => {
		if (!eventHub || !conversationId) return;
		const offConversation = eventHub.subscribeConversation(conversationId, (event) => controller.onHubEvent(event));
		const offResync = eventHub.onResync(() => void controller.onHubResync());
		return () => {
			offConversation();
			offResync();
		};
	}, [eventHub, conversationId, controller]);
	React.useEffect(() => {
		if (!conversationId) return;
		return startFallbackPoller({
			hub: eventHub,
			appState: {
				current: () => AppState.currentState ?? "active",
				subscribe: (listener) => {
					const subscription = AppState.addEventListener("change", listener);
					return () => subscription.remove();
				},
			},
			intervalMs: CHAT_POLL_MS,
			isFocused: () => focusedRef.current,
			tick: () => void controller.onHubResync(),
		});
	}, [eventHub, conversationId, controller]);

	const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	const view = React.useMemo(() => deriveView(snapshot), [snapshot]);
	const stop = React.useCallback(() => controller.stop(), [controller]);
	const owner = React.useRef(`chat-${Math.random().toString(36).slice(2)}`).current;
	// O perfil e a tela de Execuções leem o run ativo e os passos daqui; o chat segue montado por baixo, com o stream vivo.
	React.useEffect(() => {
		if (botId) setBotRun(botId, { running: view.running, tasks: view.runTasks?.items ?? null, last: view.lastTasks?.items ?? null, stop }, owner);
	}, [botId, view.running, view.runTasks, view.lastTasks, stop, owner]);
	React.useEffect(() => () => (botId ? clearBotRun(botId, owner) : undefined), [botId, owner]);
	const avatar = useAvatarLive({ activity: view.activity, running: view.running, paused: snapshot.live.paused, failures: view.failures, finishes: view.finishes });
	return {
		...view,
		avatar,
		phase: snapshot.live.phase,
		paused: snapshot.live.paused,
		notice: snapshot.live.notice,
		error: snapshot.error,
		compacting: snapshot.compacting,
		hasMore: snapshot.hasMore,
		loadingOlder: snapshot.loadingOlder,
		ready: snapshot.ready,
		loadOlder: () => void controller.loadOlder(),
		send: (text, replyTo, attachments) => controller.send(text, replyTo, attachments),
		stop,
		decide: (item, approve) => controller.decide(item, approve),
		answer: (item, answers) => controller.answer(item, answers),
		resolveProposal: (item, decision) => controller.resolveProposal(item, decision),
		resumeLogin: (item, options) => controller.resumeLogin(item, options),
		connectLogin: (item) => controller.connectLogin(item),
		connects: snapshot.connects,
		react: (messageId, emoji) => void controller.react(messageId, emoji),
		markUnread: () => controller.markUnread(),
		compact: (focus) => controller.compact(focus),
		retry: () => void controller.retry(),
		dismissError: () => controller.dismissError(),
		modelSelector,
	};
}
