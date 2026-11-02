// Hook do chat: monta o `ChatController` (lógica sem React, em `chat-controller.ts`) com a sessão, o cache e o
// `AppState`, e entrega o que a tela desenha. Toda chamada passa por `apiFetch`/`openRunStream` da sessão.
import * as React from "react";
import { AppState } from "react-native";
import * as chatApi from "./chat-api";
import { chatCacheKey, createChatCacheWriter, loadChatCache } from "./chat-cache";
import { ChatController, deriveView, type ChatApi, type ChatDeps } from "./chat-controller";
import type { ChatItem } from "./chat-types";
import { useAtlasSession } from "./atlas-session";
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
	loadOlder: () => void;
	send: (text: string) => void;
	stop: () => void;
	decide: (item: Extract<ChatItem, { kind: "confirm" }>, approve: boolean) => void;
	answer: ChatController["answer"];
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
			createRunInput: (runId, content, key) => chatApi.createRunInput(latest.current.apiFetch, runId, content, key),
			cancelRun: (runId) => chatApi.cancelRun(latest.current.apiFetch, runId),
			getRunStatus: (runId) => chatApi.getRunStatus(latest.current.apiFetch, runId),
			listActiveRuns: (conversationId) => chatApi.listActiveRuns(latest.current.apiFetch, conversationId),
			submitQuestionnaire: (input) => chatApi.submitQuestionnaire(latest.current.apiFetch, input),
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
	return {
		...view,
		phase: snapshot.live.phase,
		paused: snapshot.live.paused,
		notice: snapshot.live.notice,
		error: snapshot.error,
		hasMore: snapshot.hasMore,
		loadingOlder: snapshot.loadingOlder,
		ready: snapshot.ready,
		loadOlder: () => void controller.loadOlder(),
		send: (text) => controller.send(text),
		stop: () => controller.stop(),
		decide: (item, approve) => controller.decide(item, approve),
		answer: (item, answers) => controller.answer(item, answers),
		retry: () => void controller.retry(),
		dismissError: () => controller.dismissError(),
	};
}
