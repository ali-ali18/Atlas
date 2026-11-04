// Hook do chat: monta o `ChatController` (lógica sem React, em `chat-controller.ts`) com a sessão, o cache e o
// `AppState`, e entrega o que a tela desenha. Toda chamada passa por `apiFetch`/`openRunStream` da sessão.
import * as React from "react";
import { AppState } from "react-native";
import * as chatApi from "./chat-api";
import type { MobileAvatarState } from "./avatar-activity";
import { useAvatarLive } from "./use-avatar-live";
import { chatCacheKey, createChatCacheWriter, loadChatCache } from "./chat-cache";
import { ChatController, deriveView, type ChatApi, type ChatDeps, type ChatSnapshot } from "./chat-controller";
import type { ChatItem, ReplyQuote } from "./chat-types";
import { clearBotRun, setBotRun } from "./run-store";
import { useAtlasSession } from "./atlas-session";
import * as WebBrowser from "expo-web-browser";
import { connectApp } from "./connect-app";
import { clearRequestMemory } from "./request-memory";
import { homeStorage } from "./home-storage";
import type { HomeBot } from "./home-types";

const RESUME_MIN_GAP_MS = 1_500;
/** Um escritor para o app todo: sair da conta o invalida, e gravação em voo se desfaz sozinha. */
export const chatCacheWriter = createChatCacheWriter(homeStorage);

export type ChatHook = ReturnType<typeof deriveView> & {
	phase: ReturnType<ChatController["getSnapshot"]>["live"]["phase"];
	paused: boolean;
	notice: string | null;
	error: string | null;
	hasMore: boolean;
	loadingOlder: boolean;
	ready: boolean;
	/** Estado do avatar já governado (permanência mínima) e o que o bot está fazendo, em pt-BR (`null` em repouso). */
	avatar: { state: MobileAvatarState; label: string | null };
	loadOlder: () => void;
	send: (text: string, replyTo?: ReplyQuote) => void;
	stop: () => void;
	decide: ChatController["decide"];
	resumeLogin: ChatController["resumeLogin"];
	connectLogin: ChatController["connectLogin"];
	connects: ChatSnapshot["connects"];
	answer: ChatController["answer"];
	react: (messageId: string, emoji: string) => void;
	markUnread: () => Promise<boolean>;
	retry: () => void;
	dismissError: () => void;
};

export function useChat(bot: HomeBot | undefined): ChatHook {
	const { apiFetch, openRunStream, serverUrl, email, signOut, onSignOut } = useAtlasSession();
	// Dependências que mudam a cada render: o controlador (um só) lê sempre as de agora.
	const latest = React.useRef({ apiFetch, openRunStream, serverUrl, email, signOut });
	latest.current = { apiFetch, openRunStream, serverUrl, email, signOut };

	const controller = React.useMemo(() => {
		const api: ChatApi = {
			fetchPage: (conversationId, options) => chatApi.fetchMessagePage(latest.current.apiFetch, conversationId, options),
			createConversation: () => chatApi.createConversation(latest.current.apiFetch),
			createRun: (input) => chatApi.createRun(latest.current.apiFetch, input),
			createRunInput: (runId, content, key, replyToMessageId) => chatApi.createRunInput(latest.current.apiFetch, runId, content, key, replyToMessageId),
			cancelRun: (runId) => chatApi.cancelRun(latest.current.apiFetch, runId),
			getRunStatus: (runId) => chatApi.getRunStatus(latest.current.apiFetch, runId),
			listActiveRuns: (conversationId) => chatApi.listActiveRuns(latest.current.apiFetch, conversationId),
			submitQuestionnaire: (input) => chatApi.submitQuestionnaire(latest.current.apiFetch, input),
			setReaction: (messageId, emoji) => chatApi.setReaction(latest.current.apiFetch, messageId, emoji),
			clearReaction: (messageId) => chatApi.clearReaction(latest.current.apiFetch, messageId),
			markConversationUnread: (conversationId) => chatApi.markConversationUnread(latest.current.apiFetch, conversationId),
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
		hasMore: snapshot.hasMore,
		loadingOlder: snapshot.loadingOlder,
		ready: snapshot.ready,
		loadOlder: () => void controller.loadOlder(),
		send: (text, replyTo) => controller.send(text, replyTo),
		stop,
		decide: (item, approve) => controller.decide(item, approve),
		answer: (item, answers) => controller.answer(item, answers),
		resumeLogin: (item, options) => controller.resumeLogin(item, options),
		connectLogin: (item) => controller.connectLogin(item),
		connects: snapshot.connects,
		react: (messageId, emoji) => void controller.react(messageId, emoji),
		markUnread: () => controller.markUnread(),
		retry: () => void controller.retry(),
		dismissError: () => controller.dismissError(),
	};
}
