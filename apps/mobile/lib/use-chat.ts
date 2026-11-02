// Estado do chat de um bot: abre pelo cache do aparelho, confere o servidor, segue o run ao vivo (SSE) e envia.
// Porta enxuta do `use-atlas-chat.ts` do web: o gravado (`persisted`) manda, o ao vivo (`live`) preenche o resto e
// `reconcile` junta os dois para a tela. Toda chamada passa por `apiFetch`/`openRunStream` da sessão.
import * as React from "react";
import { AppState } from "react-native";
import { cancelRun, createConversation, createRun, createRunInput, ChatApiError, fetchMessagePage, getRunStatus, isNetworkError, isUnauthorized, listActiveRuns, sendErrorText, submitQuestionnaire } from "./chat-api";
import { chatCacheKey, loadChatCache, saveChatCache } from "./chat-cache";
import { applyRunEvent, createLiveState, startLiveRun, type LiveState } from "./chat-live";
import { followRun } from "./chat-stream";
import { initialSync, syncLine, syncReducer } from "./chat-sync";
import { dockedTaskList, mergeTail, oldestCursor, PAGE_SIZE, prependOlder, reconcile, sessionMessageToItem, type PageCursor } from "./chat-thread";
import type { ChatItem } from "./chat-types";
import { useAtlasSession } from "./atlas-session";
import { homeStorage } from "./home-storage";
import type { HomeBot } from "./home-types";

const RESUME_MIN_GAP_MS = 1_500;
const ACTIVE_CONFLICT = "A conversa já tem uma tarefa em andamento";

const clientKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export type ChatController = {
	/** O que a tela desenha, do mais antigo para o mais novo (sem a lista de tarefas do run, que vive na doca). */
	items: ChatItem[];
	dock: Extract<ChatItem, { kind: "task-list" }> | null;
	line: ReturnType<typeof syncLine>;
	running: boolean;
	phase: LiveState["phase"];
	paused: boolean;
	notice: string | null;
	error: string | null;
	hasMore: boolean;
	loadingOlder: boolean;
	/** O cache já foi lido (ou não existe): a tela sabe se mostra o fio ou o vazio. */
	ready: boolean;
	loadOlder: () => void;
	send: (text: string) => void;
	stop: () => void;
	decide: (item: Extract<ChatItem, { kind: "confirm" }>, approve: boolean) => void;
	answer: (item: Extract<ChatItem, { kind: "questionnaire" }>, answers: Record<string, string | string[]>) => void;
	retry: () => void;
	dismissError: () => void;
};

export function useChat(bot: HomeBot | undefined): ChatController {
	const { apiFetch, openRunStream, serverUrl, email, signOut } = useAtlasSession();
	const botId = bot?.id ?? null;
	const [persisted, setPersisted] = React.useState<ChatItem[]>([]);
	const [live, setLive] = React.useState<LiveState>(createLiveState);
	const [hasMore, setHasMore] = React.useState(false);
	const [loadingOlder, setLoadingOlder] = React.useState(false);
	const [following, setFollowing] = React.useState(false);
	const [ready, setReady] = React.useState(false);
	const [sync, dispatchSync] = React.useReducer(syncReducer, initialSync);
	const [error, setError] = React.useState<string | null>(null);
	const [decisions, setDecisions] = React.useState<Record<string, "approved" | "rejected">>({});
	const [answered, setAnswered] = React.useState<Record<string, true>>({});

	const conversationId = React.useRef<string | null>(bot?.conversationId ?? null);
	const oldest = React.useRef<PageCursor | null>(null);
	const liveRef = React.useRef(live);
	liveRef.current = live;
	const persistedRef = React.useRef<ChatItem[]>([]);
	persistedRef.current = persisted;
	const runIdRef = React.useRef<string | null>(null);
	const controllerRef = React.useRef<AbortController | null>(null);
	const alive = React.useRef(true);
	const lastResync = React.useRef(0);
	const cacheKey = serverUrl && email && conversationId.current ? chatCacheKey(serverUrl, email, conversationId.current) : null;
	const cacheKeyRef = React.useRef(cacheKey);
	cacheKeyRef.current = cacheKey;
	// Dependências que mudam a cada render: as funções abaixo (estáveis) leem sempre as de agora.
	const deps = React.useRef({ apiFetch, openRunStream, signOut });
	deps.current = { apiFetch, openRunStream, signOut };

	const fail = React.useCallback((reason: unknown) => {
		if (isUnauthorized(reason)) void deps.current.signOut();
	}, []);

	const saveCache = React.useCallback((items: readonly ChatItem[]) => {
		const key = cacheKeyRef.current;
		if (key) void saveChatCache(homeStorage, key, items, Date.now());
	}, []);

	/** Confere o servidor. `replace`: a primeira conferência troca o que veio do cache pelo fim de verdade. */
	const syncTail = React.useCallback(
		async (replace: boolean): Promise<boolean> => {
			const convId = conversationId.current;
			if (!convId) return false;
			dispatchSync({ type: "start" });
			try {
				const page = await fetchMessagePage(deps.current.apiFetch, convId, { limit: PAGE_SIZE });
				if (!alive.current) return false;
				const tail = page.messages.map(sessionMessageToItem).filter((item): item is ChatItem => item !== null);
				const merged = replace ? { items: tail, gap: true } : mergeTail(persistedRef.current, tail);
				if (merged.gap) {
					oldest.current = oldestCursor(page.messages);
					setHasMore(page.hasMore);
				}
				persistedRef.current = merged.items;
				setPersisted(merged.items);
				saveCache(merged.items);
				dispatchSync({ type: "success" });
				return true;
			} catch (reason) {
				if (alive.current) dispatchSync({ type: isNetworkError(reason) ? "network-failure" : "failure" });
				fail(reason);
				return false;
			}
		},
		[fail, saveCache],
	);

	const finishRun = React.useCallback(
		async (terminal: boolean) => {
			await syncTail(false);
			if (!alive.current) return;
			setLive((state) => {
				// Parou esperando a pessoa (aprovação): o cartão ao vivo fica até o gravado confirmá-lo.
				if (!(state.ended || terminal)) return { ...state, phase: "idle" };
				// O gravado assumiu: só o que ainda não foi gravado (balão do usuário, erro do run) fica ao vivo.
				const keep = state.items.filter((item) => item.id === "cu-run-error" || (item.kind === "user" && item.id.startsWith("msg-")));
				return { ...state, items: keep, runId: null, phase: "idle" };
			});
		},
		[syncTail],
	);

	/** Segue o run ao vivo. Sempre do começo (`after=0`): o servidor reenvia os eventos e o guarda descarta o que já foi visto. */
	const follow = React.useCallback(
		async (runId: string) => {
			controllerRef.current?.abort();
			const controller = new AbortController();
			controllerRef.current = controller;
			runIdRef.current = runId;
			setFollowing(true);
			// O replay recria falas e cartões do run: o que vinha dele sai, o balão do usuário fica.
			setLive((state) => ({ ...startLiveRun(state, runId), items: state.items.filter((item) => item.kind === "user") }));
			let terminal = false;
			try {
				const result = await followRun({
					open: deps.current.openRunStream(runId),
					after: 0,
					signal: controller.signal,
					onEvent: (event) => setLive((state) => applyRunEvent(state, event)),
					runStatus: () => getRunStatus(deps.current.apiFetch, runId),
					subscribeResume: (wake) => {
						const subscription = AppState.addEventListener("change", (state) => state === "active" && wake());
						return () => subscription.remove();
					},
				});
				terminal = result === "terminal" || result === "gone";
			} catch (reason) {
				fail(reason);
				if (alive.current && !controller.signal.aborted) setError("Perdi a conexão com a resposta. Puxe de novo ou envie outra mensagem.");
			} finally {
				if (controllerRef.current === controller) {
					controllerRef.current = null;
					setFollowing(false);
				}
			}
			if (controller.signal.aborted || !alive.current) return;
			// Parou esperando a pessoa (aprovação): o run continua vivo no servidor e o `stop` ainda o alcança.
			if (!liveRef.current.paused || liveRef.current.ended) runIdRef.current = null;
			await finishRun(terminal);
		},
		[fail, finishRun],
	);

	/** Procura um run ainda em andamento (de outro aparelho, rotina ou da última vez que o app esteve aberto). */
	const resumeActiveRun = React.useCallback(async () => {
		const convId = conversationId.current;
		if (!convId || controllerRef.current) return;
		try {
			const runs = await listActiveRuns(deps.current.apiFetch, convId);
			const active = runs.find((run) => run.status !== "paused");
			if (active && alive.current && !controllerRef.current) void follow(active.id);
		} catch (reason) {
			fail(reason);
		}
	}, [fail, follow]);

	// Abre: cache na hora, depois confere o servidor e procura run em andamento.
	// biome-ignore lint/correctness/useExhaustiveDependencies: roda uma vez por bot (as dependências lidas são refs)
	React.useEffect(() => {
		alive.current = true;
		conversationId.current = bot?.conversationId ?? null;
		setReady(false);
		void (async () => {
			const key = cacheKeyRef.current;
			if (key) {
				const cached = await loadChatCache(homeStorage, key, Date.now());
				if (cached && alive.current && cached.items.length > 0) {
					persistedRef.current = cached.items;
					setPersisted(cached.items);
					oldest.current = cached.items[0] ? { createdAt: cached.items[0].createdAt ?? "", id: cached.items[0].id } : null;
				}
			}
			if (alive.current) setReady(true);
			if (await syncTail(true)) await resumeActiveRun();
		})();
		return () => {
			alive.current = false;
			controllerRef.current?.abort();
			controllerRef.current = null;
		};
	}, [botId]);

	// Voltou do segundo plano: confere de novo (o run pode ter terminado ou ter mensagem nova).
	React.useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active" || Date.now() - lastResync.current < RESUME_MIN_GAP_MS) return;
			lastResync.current = Date.now();
			void (async () => {
				if (controllerRef.current) return; // o stream em curso já reconecta sozinho
				if (await syncTail(false)) await resumeActiveRun();
			})();
		});
		return () => subscription.remove();
	}, [syncTail, resumeActiveRun]);

	const loadOlder = React.useCallback(() => {
		const convId = conversationId.current;
		const before = oldest.current;
		if (!convId || !before || loadingOlder || !hasMore) return;
		setLoadingOlder(true);
		void (async () => {
			try {
				const page = await fetchMessagePage(deps.current.apiFetch, convId, { limit: PAGE_SIZE, before });
				if (!alive.current) return;
				const older = page.messages.map(sessionMessageToItem).filter((item): item is ChatItem => item !== null);
				oldest.current = oldestCursor(page.messages) ?? oldest.current;
				persistedRef.current = prependOlder(persistedRef.current, older);
				setPersisted(persistedRef.current);
				setHasMore(page.hasMore && page.messages.length > 0);
			} catch (reason) {
				fail(reason);
			} finally {
				if (alive.current) setLoadingOlder(false);
			}
		})();
	}, [fail, hasMore, loadingOlder]);

	const ensureConversation = React.useCallback(async (): Promise<string> => {
		if (conversationId.current) return conversationId.current;
		const id = await createConversation(deps.current.apiFetch);
		conversationId.current = id;
		return id;
	}, []);

	/** Cria o run; se a conversa ainda tem um em andamento (409), espera um pouco e tenta de novo (como o web). */
	const startRun = React.useCallback(
		async (content: string, decisionConfirmId?: string) => {
			const convId = await ensureConversation();
			if (!botId) throw new ChatApiError("Bot não encontrado.", 404);
			const delays = [400, 1_000, 2_000];
			for (let attempt = 0; ; attempt += 1) {
				try {
					return await createRun(deps.current.apiFetch, { content, conversationId: convId, botId, ...(decisionConfirmId ? { decisionConfirmId } : {}), clientKey: clientKey() });
				} catch (reason) {
					const delay = delays[attempt];
					const conflict = reason instanceof ChatApiError && reason.status === 409 && reason.message.startsWith(ACTIVE_CONFLICT);
					if (!conflict || delay === undefined) throw reason;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		},
		[botId, ensureConversation],
	);

	const send = React.useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			setError(null);
			const optimistic: ChatItem = { id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, kind: "user", text: trimmed, createdAt: new Date().toISOString() };
			setLive((state) => ({ ...state, items: [...state.items, optimistic], phase: state.phase === "idle" ? "thinking" : state.phase }));
			const drop = () => setLive((state) => ({ ...state, items: state.items.filter((item) => item.id !== optimistic.id), phase: controllerRef.current ? state.phase : "idle" }));
			void (async () => {
				try {
					const liveRun = controllerRef.current ? runIdRef.current : null;
					if (liveRun) {
						try {
							await createRunInput(deps.current.apiFetch, liveRun, trimmed, clientKey());
							return;
						} catch (reason) {
							// O run terminou entre o toque e o envio: cai no fluxo de run novo.
							if (!(reason instanceof ChatApiError && reason.status === 409)) throw reason;
						}
					}
					const created = await startRun(trimmed);
					if (!created.runId) {
						// O bot só reagiu (ex.: "valeu!"): a mensagem foi gravada e não há run.
						await syncTail(false);
						setLive((state) => ({ ...state, phase: "idle" }));
						return;
					}
					void follow(created.runId);
				} catch (reason) {
					drop();
					fail(reason);
					if (alive.current) setError(sendErrorText(reason));
				}
			})();
		},
		[fail, follow, startRun, syncTail],
	);

	/** Clique de cartão: nunca vira fala nem input do run vivo; o servidor o resolve contra a intenção pendente. */
	const decide = React.useCallback(
		(item: Extract<ChatItem, { kind: "confirm" }>, approve: boolean) => {
			setError(null);
			setDecisions((previous) => ({ ...previous, [item.confirmId]: approve ? "approved" : "rejected" }));
			void (async () => {
				try {
					const created = await startRun(approve ? `confirmado: ${item.title}` : "cancela isso", item.confirmId);
					if (created.runId) void follow(created.runId);
					else await syncTail(false);
				} catch (reason) {
					setDecisions((previous) => {
						const { [item.confirmId]: _removed, ...rest } = previous;
						return rest;
					});
					fail(reason);
					if (alive.current) setError(sendErrorText(reason));
				}
			})();
		},
		[fail, follow, startRun, syncTail],
	);

	const answer = React.useCallback(
		(item: Extract<ChatItem, { kind: "questionnaire" }>, answers: Record<string, string | string[]>) => {
			const convId = conversationId.current;
			if (!convId || !botId) return;
			setError(null);
			setAnswered((previous) => ({ ...previous, [item.questionnaireId]: true }));
			void (async () => {
				try {
					const { runId } = await submitQuestionnaire(deps.current.apiFetch, { conversationId: convId, questionnaireId: item.questionnaireId, botId, answers });
					if (runId) void follow(runId);
					else await syncTail(false);
				} catch (reason) {
					setAnswered((previous) => {
						const { [item.questionnaireId]: _removed, ...rest } = previous;
						return rest;
					});
					fail(reason);
					if (alive.current) setError(sendErrorText(reason));
				}
			})();
		},
		[botId, fail, follow, syncTail],
	);

	const stop = React.useCallback(() => {
		const runId = runIdRef.current;
		if (!runId) return;
		void cancelRun(deps.current.apiFetch, runId).catch(() => {
			if (alive.current) setError("Não consegui parar agora. Tente de novo.");
		});
		// Run parado esperando a pessoa não tem stream para trazer o "cancelado": encerra aqui.
		if (!controllerRef.current) {
			runIdRef.current = null;
			setLive((state) => ({ ...state, paused: false, ended: true, phase: "idle" }));
		}
	}, []);

	const retry = React.useCallback(() => {
		void (async () => {
			if (await syncTail(false)) await resumeActiveRun();
		})();
	}, [syncTail, resumeActiveRun]);

	const merged = React.useMemo(() => {
		const withDecisions = persisted.map((item) => decide_(item, decisions, answered));
		const liveItems = live.items.map((item) => decide_(item, decisions, answered));
		return reconcile(withDecisions, liveItems);
	}, [persisted, live.items, decisions, answered]);

	const running = following || live.paused;
	const dock = React.useMemo(() => dockedTaskList(merged, running, live.runId), [merged, running, live.runId]);
	const items = React.useMemo(() => merged.filter((item) => item !== dock && item.id !== dock?.id), [merged, dock]);

	return {
		items,
		dock,
		line: syncLine(sync),
		running,
		phase: live.phase,
		paused: live.paused,
		notice: live.notice,
		error,
		hasMore,
		loadingOlder,
		ready,
		loadOlder,
		send,
		stop,
		decide,
		answer,
		retry,
		dismissError: () => setError(null),
	};
}

/** O toque no cartão vale na hora, antes de o servidor gravar o novo estado. */
function decide_(item: ChatItem, decisions: Record<string, "approved" | "rejected">, answered: Record<string, true>): ChatItem {
	if (item.kind === "confirm" && item.status === "pending" && decisions[item.confirmId]) return { ...item, status: decisions[item.confirmId]! };
	if (item.kind === "questionnaire" && item.status === "pending" && answered[item.questionnaireId]) return { ...item, status: "submitted" };
	return item;
}
