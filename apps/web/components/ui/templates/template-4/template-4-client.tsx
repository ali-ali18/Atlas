"use client";

import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	Suspense,
} from "react";

import { Trash2Icon } from "lucide-react";
import dynamic from "next/dynamic";
import { listenForCustomMcp, listenForMarketplace, type CustomMcpDraft } from "@/lib/open-marketplace";
import { reduceAgentPointer, type AgentPointerState } from "@/lib/agent-pointer";
import { SandboxViewerDialog, viewerUrlIdentity } from "./sandbox-viewer-dialog";

import type {
	Bot,
	GithubRoutineTemplate,
	RoutineGroupRecord,
	RoutineRecord,
	RoutineRunRecord,
	Section,
} from "@workspace/shared";
import { authClient } from "@/lib/auth-client";
import { markAppReady } from "@/lib/boot-screen";
import { PrimaryBotIntroDialog, PrimaryBotPickerDialog } from "./primary-bot-dialogs";
import {
	primaryIntroKey,
	readPrimaryIntroDismissed,
	shouldShowPrimaryIntro,
	writePrimaryIntroDismissed,
} from "./primary-bot-logic";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import {
	SidebarInset,
	SidebarProvider,
} from "@workspace/ui/components/sidebar";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { useIsMobile } from "@workspace/ui/hooks/use-mobile";
import { useNotificationOpen } from "@/hooks/use-notification-open";
import { requestScrollToCard } from "@/lib/scroll-to-card";
import { clearConversationNotifications } from "@/lib/push-client";

import { closeActivity, hydrateDevSessionFromApi, openActivity, useActivitySelection } from "@/lib/dev-session/store";
import type { ActiveWorkItemResponse } from "@/lib/atlas-api";
import { DEGRADED_POLL_MS, currentPollMode, getSharedEventHub, shouldPollTick } from "@/lib/event-hub-client";
import { ChatContextPanel } from "./chat-context-panel/chat-context-panel";
import { isRoutineDraftValid } from "./chat-context-panel/routine-draft";
import { botAccentStyle } from "./chat-context-panel/bot-accent";
import { ChatSidebar } from "./chat-sidebar/chat-sidebar";
import { ChatThread } from "./chat-thread/chat-thread";
import { MobileCreateBot } from "./mobile-create-bot";
import { NewChatTo, groupCandidates } from "./new-group";
import { resolveGroupMembers } from "./group-avatar";
import { MobileChatList } from "./mobile-chat-list";
import { useSendersLocation } from "@/lib/email-senders-url";
import { closeMarketplacePage, openMarketplacePage, useMarketplaceLocation } from "@/lib/marketplace-url";
import { LazySettingsDialog } from "@/components/settings/lazy-settings-dialog";
import { listenForProviderSettings, openSettingsModal } from "@/components/settings/settings-url";
import { resolveNewBotLanguage } from "@/lib/new-bot-language";
import {
	createBot as createBotRequest,
	createGroup as createGroupRequest,
	postGroupMessage as postGroupMessageRequest,
	addGroupMember as addGroupMemberRequest,
	removeGroupMember as removeGroupMemberRequest,
	createSandboxSession,
	deleteBot as deleteBotRequest,
	getActiveSandboxSession,
	getConversationReadState,
	listBots,
	markConversationResultsSeen,
	markConversationRead as markConversationReadRequest,
	markConversationUnread as markConversationUnreadRequest,
	listBotRoutineRuns,
	listRoutineRuns,
	listRoutines as listRoutinesRequest,
	listRoutineGroups as listRoutineGroupsRequest,
	createRoutineGroup as createRoutineGroupRequest,
	updateRoutineGroup as updateRoutineGroupRequest,
	setRoutineGroupEnabled as setRoutineGroupEnabledRequest,
	deleteRoutineGroup as deleteRoutineGroupRequest,
	createRoutine as createRoutineRequest,
	updateRoutine as updateRoutineRequest,
	deleteRoutine as deleteRoutineRequest,
	rotateRoutineSecret as rotateRoutineSecretRequest,
	runRoutineNow,
	updateBot as updateBotRequest,
	createAgentRun as createAgentRunRequest,
	listSections as listSectionsRequest,
	createSection as createSectionRequest,
	updateSection as updateSectionRequest,
	deleteSection as deleteSectionRequest,
	AtlasApiError,
} from "@/lib/atlas-api";
import { setServerWorking } from "@/lib/bot-activity";
import { agentUnreadPatch, botHasUnread, previewWithSource, totalUnread, withUnreadTitle } from "@/lib/unread";
import {
	type ConfigSnapshot,
	planModelPersist,
	planConfigClose,
	realignSnapshotModel,
	stableStringify,
	toConfigSnapshot,
} from "@/lib/bot-config";
import {
	setStoredAgentModel,
	DEFAULT_OPENROUTER_MODEL,
} from "@/lib/openrouter-models";
import {
	type Agent,
	defaultBodyColor,
	type NewBotInput,
	type NewGroupInput,
	type Routine,
	type RoutineGithubUiConfig,
	randomAgentState,
} from "./data";
import { normalizeShape } from "@workspace/ui/lib/avatar/identity";
import { toast } from "@workspace/ui/lib/toast-store";
import {
	deleteBotFailureMessage,
	modelFailureMessage,
	notifyFailureMessage,
	pinChangeKind,
	pinFailureMessage,
	primaryFailureMessage,
	readFailureMessage,
	restoreAgentFields,
	sectionActionFailureMessage,
	sectionFailureMessage,
	settleOptimistic,
} from "./optimistic-actions";
import {
	diffRoutineUpdatePayload,
	formatRoutineRunTime,
	parsePrNumberInput,
	parseUsersInput,
	recordToUiRoutine,
	routineRunLabel,
	sameRoutineRuns,
	uiRoutineToPayload,
} from "./chat-context-panel/routine-map";
import type { TemplateCreateFields } from "./chat-context-panel/routine-create-chooser";
import type { OpenRoutinePayload } from "@/components/ai-elements/routines";

const LAST_ACTIVE_CHAT_COOKIE = "template4_last_active_chat";
const ANCHOR_WAIT_MS = 2000;

// Telas e modais que só existem quando abertos: fora do bundle inicial, baixados na primeira abertura.
const BotExchangeScreen = dynamic(
	() => import("@/components/ai-elements/bot-messages/bot-exchange-screen").then((mod) => mod.BotExchangeScreen),
	{ ssr: false },
);
const AutonomyDialog = dynamic(() => import("./autonomy/autonomy-dialog").then((mod) => mod.AutonomyDialog), { ssr: false });
const MarketplacePage = dynamic(() => import("./marketplace/marketplace-page").then((mod) => mod.MarketplacePage), { ssr: false });
const AllowedSendersPage = dynamic(
	() => import("./chat-context-panel/allowed-senders-page").then((mod) => mod.AllowedSendersPage),
	{ ssr: false },
);

function readLastActiveChatCookie() {
	const entry = document.cookie
		.split(";")
		.map((cookie) => cookie.trim())
		.find((cookie) => cookie.startsWith(`${LAST_ACTIVE_CHAT_COOKIE}=`));
	if (!entry) return null;
	try {
		return decodeURIComponent(entry.slice(LAST_ACTIVE_CHAT_COOKIE.length + 1));
	} catch {
		return null;
	}
}

// Forma salva no bot: id do motor ou valor antigo ("rond"...); desconhecido = sem forma.
function parseAgentShape(value: unknown): Agent["shape"] {
	return typeof value === "string" && normalizeShape(value) ? value : undefined;
}

function botToAgent(bot: Bot): Agent {
	const isGroup = bot.memberIds.length > 0;
	const base: Agent = {
		id: bot.id,
		name: bot.name,
		color: bot.color,
		shape: parseAgentShape(bot.shape),
		// Fixar e sessão são exclusivos: dado antigo com os dois, vence o fixado.
		sectionId: bot.pinned ? null : bot.sectionId,
		description: bot.description ?? undefined,
		openRouterModel: bot.openRouterModel ?? undefined,
		language: bot.language,
		pinned: bot.pinned,
		pinOrder: bot.pinOrder ?? undefined,
		isPrimary: bot.isPrimary,
		notify: bot.notify,
		members: isGroup ? bot.memberIds : undefined,
		conversationId: bot.conversationId ?? undefined,
		lastMessage: bot.lastMessage ? previewWithSource(bot.lastMessage.content, bot.lastMessage.source) : null,
		notifications: botHasUnread(bot) ? true : undefined,
		unreadCount: bot.unreadCount ?? 0,
		firstUnreadMessageId: bot.firstUnreadMessageId ?? null,
		manualUnread: bot.manualUnread ?? false,
		snippet:
			bot.snippet.trim() ||
			(isGroup ? `${bot.memberIds.length} bots no grupo` : "Bot"),
		lastMessageAt: bot.lastMessage?.createdAt ?? null,
		time: "",
		state: "neutre",
	};
	// policyJson vive no runtime mesmo sem campo tipado em Agent (data.ts
	// intocado): entra no diff do config-close via cast.
	return { ...base, policyJson: bot.policyJson ?? undefined } as Agent;
}

function buildBotCreatedSystem(botName: string): string {
	const name = botName.trim().slice(0, 80) || "bot";
	return (
		`Você é o assistente do bot recém-criado "${name}". Responda em PT-BR, simpático e direto. ` +
		`Apresente-se brevemente como "${name}" (1-2 frases + diga que vai fazer umas perguntas para ajudar na experiência dele) — nunca como Atlas, nunca como outro assistente. ` +
		`Fale SEMPRE em primeira pessoa como "${name}" (diga "vou", nunca "o ${name} vai..."). ` +
		`OBRIGATÓRIO: sua PRIMEIRA resposta já deve chamar propose_questionnaire (1 item) — nunca termine só com a apresentação. ` +
		`Faça UMA pergunta por vez via questionário (tool propose_questionnaire com 1 item) e aguarde a resposta antes da próxima; no máximo 3 perguntas objetivas sobre papel, tom e primeira tarefa. ` +
		`Antes de perguntar, consulte session_search e memory_search para aproveitar contexto de outras conversas do usuário. ` +
		`NUNCA mande as perguntas todas de uma vez. ` +
		`Se o briefing for durável (papel, preferências), salve com a tool memory. ` +
		`Ao concluir o onboarding (respostas suficientes ou usuário satisfeito), consolide briefing/snippet e chame propose_profile_update — nunca edite o perfil diretamente. Não use texto estático pronto.`
	);
}

function hashString(input: string): string {
	let hash = 5381;
	for (let index = 0; index < input.length; index += 1) {
		hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}

/** Espera curta antes de gravar as mudanças da config do bot (agrupa o que se digita em sequência). */
const CONFIG_AUTOSAVE_MS = 600;

export function Template4Client({
	initialPanelWidth,
}: {
	initialPanelWidth?: number;
}) {
	const [agents, setAgents] = useState<Agent[]>([]);
	const [sections, setSections] = useState<Section[]>([]);
	const [activeId, setActiveId] = useState<string>("");
	const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
	// Conversa (somente leitura) entre o bot aberto e outro; substitui o chat enquanto aberta.
	const [exchange, setExchange] = useState<{ peerId: string; focusKey: string | null } | null>(null);
	// Bot principal: apresentação (uma vez), seletor "Trocar" e criação já como principal.
	const [introDismissed, setIntroDismissed] = useState(true);
	const [replacePrimaryOpen, setReplacePrimaryOpen] = useState(false);
	const createAsPrimaryRef = useRef(false);
	const { data: authSession } = authClient.useSession();
	const primaryIntroStorageKey = primaryIntroKey(authSession?.user.id);
	useEffect(() => {
		let storage: Storage | null = null;
		try {
			storage = window.localStorage;
		} catch {
			storage = null;
		}
		setIntroDismissed(readPrimaryIntroDismissed(storage, primaryIntroStorageKey));
	}, [primaryIntroStorageKey]);
	const isMobile = useIsMobile();
	const [botsLoaded, setBotsLoaded] = useState(false);
	const [naming, setNaming] = useState(false);
	// "Novo grupo": diálogo no desktop, tela cheia no celular.
	const [groupCreating, setGroupCreating] = useState(false);
	const groupInitialMode = true;
	const [groupPanelError, setGroupPanelError] = useState<string | null>(null);
	const [panelOpen, setPanelOpen] = useState(true);
	// No celular o painel ocupa a tela toda: só abre quando a pessoa pedir.
	useEffect(() => {
		if (isMobile) setPanelOpen(false);
	}, [isMobile]);
	const [routines, setRoutines] = useState<Routine[]>([]);
	const [routineGroups, setRoutineGroups] = useState<RoutineGroupRecord[]>([]);
	const [editingRoutine, setEditingRoutine] = useState<Routine>();
	const [editingRuns, setEditingRuns] = useState<RoutineRunRecord[]>([]);
	const [botRoutineRuns, setBotRoutineRuns] = useState<
		{ id: string; name: string; time: string }[]
	>([]);
	const [routineRunning, setRoutineRunning] = useState(false);
	const [routineOneTimeSecret, setRoutineOneTimeSecret] = useState<
		string | null
	>(null);
	/** Prefill do composer (ex.: "Editar com o agente", chooser "Descreva no chat"). */
	const [composerPrefill, setComposerPrefill] = useState<
		{ text: string; nonce: number } | undefined
	>(undefined);
	const [panelView, setPanelView] = useState<
		"default" | "settings" | "routine" | "activity"
	>("default");
	// Cartão de sessão de código/subagente clicado no chat: abre o detalhe na 3ª coluna.
	const activitySelection = useActivitySelection();
	useEffect(() => {
		if (activitySelection) {
			setPanelOpen(true);
			setPanelView("activity");
		} else {
			setPanelView((view) => (view === "activity" ? "default" : view));
		}
	}, [activitySelection]);
	const [sandboxByConversation, setSandboxByConversation] = useState<
		Record<string, { sessionId: string; viewerUrl: string }>
	>({});
	const [sandboxBusy, setSandboxBusy] = useState(false);
	const [sandboxRestarting, setSandboxRestarting] = useState(false);
	const [sandboxError, setSandboxError] = useState<string | null>(null);
	// Cursor do agente no navegador do sandbox (efêmero; some sozinho após alguns segundos).
	const [agentPointer, setAgentPointer] = useState<AgentPointerState | null>(null);
	const [sandboxViewerOpen, setSandboxViewerOpen] = useState(false);
	const [sandboxViewerReload, setSandboxViewerReload] = useState(0);
	// Preenchido quando a VM foi aberta por um card de login: "Terminei" aparece na própria tela.
	const [sandboxViewerFinish, setSandboxViewerFinish] = useState<(() => void) | null>(null);
	// O Marketplace é uma página do shell, endereçada por `?marketplace=<seção>` (voltar retorna a onde o usuário estava).
	const marketplaceOpen = useMarketplaceLocation() !== null;
	// Página "Remetentes permitidos" do e-mail do bot (`?remetentes=<bot>`); a aba E-mail continua montada por baixo.
	const sendersBotId = useSendersLocation();
	const sendersOpen = sendersBotId !== null;
	const [customMcpDraft, setCustomMcpDraft] = useState<CustomMcpDraft | null>(null);
	// Autonomia da conta; `connector` chega do Marketplace (exceções já filtradas).
	const [autonomyDialog, setAutonomyDialog] = useState<{
		open: boolean;
		connector?: string;
	}>({ open: false });
	// O modal de Autonomia só é montado (e baixado) na primeira abertura; depois fica, para a animação de fechar.
	const [autonomyEverOpened, setAutonomyEverOpened] = useState(false);
	useEffect(() => {
		if (autonomyDialog.open) setAutonomyEverOpened(true);
	}, [autonomyDialog.open]);
	const [loadingBots, setLoadingBots] = useState(true);
	// Falha ao carregar/atualizar a lista de bots: nunca pode parecer "nenhuma conversa" (ver ListLoadError).
	const [listLoadError, setListLoadError] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const refreshBotsRef = useRef<(() => void) | null>(null);
	// A abertura do app termina quando a lista inicial de bots chegou (ou falhou).
	useEffect(() => {
		if (!loadingBots) markAppReady();
	}, [loadingBots]);
	const [hiddenIds, setHiddenIds] = useState<string[]>([]);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const composerFocusedAt = useRef(0);
	const lastPointerDownAt = useRef(0);
	const routineMutations = useRef(new Map<string, Promise<void>>());
	const persistedRoutineIds = useRef(new Set<string>());
	const creatingRoutineIds = useRef(new Set<string>());
	/**
	 * Último estado conhecido do servidor por rotina (id -> Routine). Baseline
	 * pra `diffRoutineUpdatePayload`: o autosave manda só o que mudou desde
	 * aqui, nunca o objeto inteiro — reenviar tudo arrisca reescrever um campo
	 * que o agente acabou de editar por fora com o valor antigo que o painel
	 * ainda tinha em tela.
	 */
	const serverRoutineSnapshots = useRef(new Map<string, Routine>());
	/** Após excluir: bloqueia save/debounce que ressuscitaria a rotina. */
	const suppressPersistIds = useRef(new Set<string>());
	/** Config (3ª coluna): snapshot before por bot + trava de flush em andamento. */
	const agentsRef = useRef<Agent[]>([]);
	const activeIdRef = useRef<string>("");
	const prevActiveIdRef = useRef<string>("");
	const configSnapshotRef = useRef<{
		botId: string;
		before: ConfigSnapshot;
	} | null>(null);
	const configFlushingRef = useRef(new Set<string>());
	const configAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Dedup do run de boas-vindas (`bot-created`); fechar a Config nunca cria run. */
	const configFlushedHashesRef = useRef(new Set<string>());
	/** Confirmação visual do salvamento ao fechar a Config. */
	const [configNotice, setConfigNotice] = useState<{
		tone: "saved" | "error";
		text: string;
	} | null>(null);
	const configNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Atualiza a baseline de `diffRoutineUpdatePayload` com dado fresco do servidor. */
	function snapshotRoutineRecords(records: RoutineRecord[]) {
		for (const record of records) {
			serverRoutineSnapshots.current.set(record.id, recordToUiRoutine(record));
		}
	}

	function snapshotRoutine(routine: Routine) {
		serverRoutineSnapshots.current.set(routine.id, routine);
	}

	useEffect(() => {
		agentsRef.current = agents;
	}, [agents]);

	useEffect(() => {
		activeIdRef.current = activeId;
	}, [activeId]);

	// Autofoco no input ao trocar de conversa.
	useEffect(() => {
		if (!activeId) return;
		if (window.matchMedia("(max-width: 767px)").matches) return;
		composerRef.current?.focus({ preventScroll: true });
	}, [activeId]);

	// O noVNC foca o canvas ao conectar e rouba o caret do composer.
	// Se o iframe pegar foco sem clique recente (roubo, não intenção),
	// devolve o foco para onde o usuário estava digitando.
	useEffect(() => {
		if (!sandboxViewerOpen) return;
		const onPointerDown = () => {
			lastPointerDownAt.current = Date.now();
		};
		const onFocusIn = (event: FocusEvent) => {
			const target = event.target as HTMLElement | null;
			if (target === composerRef.current) {
				composerFocusedAt.current = Date.now();
				return;
			}
			if (!(target instanceof HTMLIFrameElement)) return;
			const typedRecently = Date.now() - composerFocusedAt.current < 30_000;
			const clickedRecently = Date.now() - lastPointerDownAt.current < 500;
			if (typedRecently && !clickedRecently) {
				composerRef.current?.focus({ preventScroll: true });
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("focusin", onFocusIn);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("focusin", onFocusIn);
		};
	}, [sandboxViewerOpen]);

	const closeSandboxViewer = useCallback(() => {
		setSandboxViewerOpen(false);
		setSandboxViewerFinish(null);
	}, []);

	/** Card de login: abre a VM nesta página e guarda o "Terminei" que retoma o run. */
	const openSandboxViewerForLogin = useCallback((onFinish: () => void) => {
		setSandboxViewerFinish(() => onFinish);
		setSandboxViewerOpen(true);
	}, []);

	// Cards de conexão sem login de um clique pedem o Marketplace.
	useEffect(() => listenForMarketplace(() => openMarketplacePage()), []);
	// Card "Conectar {MCP}" do agente: abre o dialog de MCP personalizado já preenchido.
	useEffect(
		() =>
			listenForCustomMcp((draft) => {
				setCustomMcpDraft(draft);
				openMarketplacePage({ section: "conectores", item: "custom" });
			}),
		[],
	);

	const active = useMemo(
		() => agents.find((agent) => agent.id === activeId) ?? agents[0],
		[agents, activeId],
	);
	const activeConversationId = active?.conversationId ?? null;
	const exchangePeer = exchange ? agents.find((agent) => agent.id === exchange.peerId) : undefined;
	// Trocar de bot fecha a conversa entre bots.
	useEffect(() => {
		setExchange(null);
	}, [activeId]);
	useEffect(() => {
		setAgentPointer(null);
	}, [activeConversationId]);
	const sandboxSession = activeConversationId
		? sandboxByConversation[activeConversationId]
		: undefined;
	const sandboxSessionId = sandboxSession?.sessionId ?? null;
	const sandboxViewerUrl = sandboxSession?.viewerUrl ?? null;

	// O viewer acessa o container diretamente e não renova o tempo de uso.
	// Consulta a API enquanto a prévia está ativa para manter a sessão viva e
	// receber uma URL nova caso o container tenha sido reiniciado.
	useEffect(() => {
		const conversationId = activeConversationId;
		if (!conversationId || !sandboxViewerUrl) return;
		let cancelled = false;
		let failures = 0;
		let checking = false;
		const id = window.setInterval(() => {
			if (checking) return;
			checking = true;
			void getActiveSandboxSession(conversationId)
				.then(
					(session) => {
						if (cancelled) return;
						if (session) {
							failures = 0;
							setSandboxByConversation((previous) => {
								const current = previous[conversationId];
								if (
									current?.sessionId === session.sessionId &&
									viewerUrlIdentity(current.viewerUrl) === viewerUrlIdentity(session.viewerUrl)
								)
									return previous;
								return {
									...previous,
									[conversationId]: {
										sessionId: session.sessionId,
										viewerUrl: session.viewerUrl,
									},
								};
							});
							return;
						}
						failures += 1;
						if (failures >= 2) {
							setSandboxByConversation((previous) => {
								const next = { ...previous };
								delete next[conversationId];
								return next;
							});
							closeSandboxViewer();
						}
					},
					() => {
						// Falha transitória da API não prova que a sessão morreu.
					},
				)
				.finally(() => {
					checking = false;
				});
		}, 15_000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [activeConversationId, sandboxViewerUrl, closeSandboxViewer]);

	// Sessão anunciada antes de a conversa existir (1ª mensagem de conversa nova):
	// guarda e associa quando o conversationId aparecer.
	const pendingSandboxRef = useRef<{ sessionId: string; viewerUrl: string } | null>(null);
	const rememberSandbox = (
		conversationId: string | undefined,
		session: { sessionId: string; viewerUrl: string },
	) => {
		if (!conversationId) {
			pendingSandboxRef.current = session;
			return;
		}
		setSandboxByConversation((previous) => ({
			...previous,
			[conversationId]: session,
		}));
	};
	useEffect(() => {
		const conversationId = active?.conversationId;
		const pending = pendingSandboxRef.current;
		if (!conversationId || !pending) return;
		pendingSandboxRef.current = null;
		setSandboxByConversation((previous) => ({ ...previous, [conversationId]: pending }));
	}, [active?.conversationId]);
	// Evento `session` do run traz a URL crua do worker (sem o token das rotas REST):
	// troca na hora e depois renova pela API, que assina a URL do viewer.
	const followRunSandbox = (
		conversationId: string | undefined,
		session: { sessionId: string; viewerUrl: string },
	) => {
		rememberSandbox(conversationId, session);
		if (!conversationId) return;
		void getActiveSandboxSession(conversationId)
			.then((fresh) => {
				if (fresh && fresh.sessionId === session.sessionId) rememberSandbox(conversationId, { sessionId: fresh.sessionId, viewerUrl: fresh.viewerUrl });
			})
			.catch(() => undefined);
	};

	// Carrega os bots e as sessões persistidos no backend.
	useEffect(() => {
		let cancelled = false;
		Promise.all([listBots(), listSectionsRequest()])
			.then(([bots, loadedSections]) => {
				if (cancelled) return;
				const loaded = bots.map(botToAgent);
				setServerWorking(bots.filter((bot) => bot.working).map((bot) => bot.id));
				setAgents(loaded);
				setSections([...loadedSections].sort((a, b) => a.order - b.order));
				const savedId = readLastActiveChatCookie();
				setActiveId((previous) => {
					if (loaded.some((agent) => agent.id === previous)) return previous;
					return (
						loaded.find((agent) => agent.id === savedId)?.id ??
						loaded[0]?.id ??
						""
					);
				});
				setBotsLoaded(true);
				setListLoadError(false);
			})
			.catch((error) => {
				console.error("load bots failed", error);
				if (!cancelled) setListLoadError(true);
			})
			.finally(() => {
				if (!cancelled) setLoadingBots(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadAttempt]);

	// Sem lista ainda: tenta de novo sozinho ao voltar a conexão/foco da aba e a cada 20 s.
	useEffect(() => {
		if (!listLoadError || botsLoaded) return;
		const retry = () => {
			if (document.visibilityState !== "hidden") setLoadAttempt((attempt) => attempt + 1);
		};
		const timer = window.setInterval(retry, 20_000);
		window.addEventListener("online", retry);
		window.addEventListener("focus", retry);
		window.addEventListener("pageshow", retry);
		document.addEventListener("visibilitychange", retry);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("online", retry);
			window.removeEventListener("focus", retry);
			window.removeEventListener("pageshow", retry);
			document.removeEventListener("visibilitychange", retry);
		};
	}, [listLoadError, botsLoaded]);

	function retryLoadBots() {
		if (botsLoaded) {
			refreshBotsRef.current?.();
			return;
		}
		setLoadingBots(true);
		setLoadAttempt((attempt) => attempt + 1);
	}

	// O estado de leitura vive no servidor: a lista se atualiza sozinha (e ao voltar para a aba),
	// assim o que chegou em outro dispositivo ou em background aparece sem recarregar.
	// Resposta atrasada da lista não pode desfazer uma leitura feita depois que ela saiu (a bolinha voltava
	// a acender com a conversa aberta): leituras locais carimbam a hora e a lista só vale se começou depois.
	const readTouchRef = useRef(new Map<string, number>());
	useEffect(() => {
		if (!botsLoaded) return;
		let cancelled = false;
		let lastRefreshAt = Date.now();
		const refresh = () => {
			if (document.visibilityState === "hidden") return;
			const startedAt = Date.now();
			lastRefreshAt = startedAt;
			listBots()
				.then((bots) => {
					if (cancelled) return;
					setServerWorking(bots.filter((bot) => bot.working).map((bot) => bot.id));
					setAgents((previous) =>
						previous.map((agent) => {
							const bot = bots.find((item) => item.id === agent.id);
							if (!bot || (readTouchRef.current.get(agent.id) ?? 0) >= startedAt) return agent;
							return { ...agent, ...agentUnreadPatch(bot) };
						}),
					);
					setListLoadError(false);
				})
				.catch(() => {
					// Mantém a última lista conhecida e mostra a faixa "não deu para atualizar".
					if (!cancelled) setListLoadError(true);
				});
		};
		refreshBotsRef.current = refresh;
		// Com o hub conectado, a lista só muda por evento (mensagem, leitura, bot, run); sem ele, a consulta antiga
		// de 30 s; com o hub caindo/voltando, só uma consulta de segurança lenta (60 s).
		const timer = window.setInterval(() => {
			if (shouldPollTick(currentPollMode(), Date.now(), lastRefreshAt)) refresh();
		}, 30_000);
		const hub = getSharedEventHub();
		let hubTimer: ReturnType<typeof setTimeout> | null = null;
		const refreshSoon = () => {
			if (hubTimer !== null) return;
			hubTimer = setTimeout(() => {
				hubTimer = null;
				refresh();
			}, 250);
		};
		const offBots = hub?.subscribeBots(refreshSoon);
		const offResync = hub?.onResync(refreshSoon);
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("focus", refresh);
		window.addEventListener("pageshow", refresh);
		window.addEventListener("online", refresh);
		return () => {
			cancelled = true;
			refreshBotsRef.current = null;
			window.clearInterval(timer);
			offBots?.();
			offResync?.();
			if (hubTimer !== null) clearTimeout(hubTimer);
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("focus", refresh);
			window.removeEventListener("pageshow", refresh);
			window.removeEventListener("online", refresh);
		};
	}, [botsLoaded]);

	// Título da aba: "(N) …" com o total de não lidas.
	const unreadTotal = useMemo(() => totalUnread(agents), [agents]);
	useEffect(() => {
		document.title = withUnreadTitle(document.title, unreadTotal);
		return () => {
			document.title = withUnreadTitle(document.title, 0);
		};
	}, [unreadTotal]);

	useEffect(() => {
		if (!botsLoaded) return;
		// biome-ignore lint/suspicious/noDocumentCookie: persiste o último chat aberto
		document.cookie = `${LAST_ACTIVE_CHAT_COOKIE}=${encodeURIComponent(activeId)}; path=/; max-age=${activeId ? 31536000 : 0}; samesite=lax`;
	}, [activeId, botsLoaded]);

	useEffect(() => {
		if (!activeId) {
			setRoutines([]);
			setRoutineGroups([]);
			setBotRoutineRuns([]);
			persistedRoutineIds.current = new Set();
			return;
		}
		let cancelled = false;
		Promise.all([
			listRoutinesRequest(activeId),
			listBotRoutineRuns(activeId),
			listRoutineGroupsRequest(activeId).catch(() => [] as RoutineGroupRecord[]),
		])
			.then(([records, runs, groups]) => {
				if (cancelled) return;
				setRoutineGroups(groups);
				persistedRoutineIds.current = new Set(records.map((row) => row.id));
				snapshotRoutineRecords(records);
				setRoutines(records.map(recordToUiRoutine));
				setBotRoutineRuns(
					runs.map((run) => ({
						id: run.id,
						name: `${run.routineName} · ${routineRunLabel(run)}`,
						time: formatRoutineRunTime(run.createdAt),
					})),
				);
			})
			.catch((error) => console.error("load routines failed", error));
		return () => {
			cancelled = true;
		};
	}, [activeId]);

	// Execuções disparadas por evento (webhook) chegam sem ação do usuário:
	// sem isto o histórico só atualizava ao trocar de bot e parecia vazio.
	useEffect(() => {
		if (!activeId) return;
		let cancelled = false;
		let lastRefreshAt = Date.now();
		const refresh = () => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			lastRefreshAt = Date.now();
			listBotRoutineRuns(activeId)
				.then((runs) => {
					if (cancelled) return;
					const next = runs.map((run) => ({
						id: run.id,
						name: `${run.routineName} · ${routineRunLabel(run)}`,
						time: formatRoutineRunTime(run.createdAt),
					}));
					// Mesma lista: devolve a anterior e nada re-renderiza (a consulta roda a cada 15 s).
					setBotRoutineRuns((previous) => (sameRoutineRuns(previous, next) ? previous : next));
				})
				.catch(() => undefined);
		};
		// Sem hub: a consulta antiga de 15 s. Com hub: a execução de rotina vira run do bot e o evento traz a
		// lista na hora; fica só uma consulta de segurança lenta (execução sem run, hub caindo).
		const timer = window.setInterval(() => {
			const mode = currentPollMode();
			if (mode === "legacy" || Date.now() - lastRefreshAt >= DEGRADED_POLL_MS) refresh();
		}, 15_000);
		const hub = getSharedEventHub();
		let hubTimer: ReturnType<typeof setTimeout> | null = null;
		const refreshSoon = () => {
			if (hubTimer !== null) return;
			hubTimer = setTimeout(() => {
				hubTimer = null;
				refresh();
			}, 500);
		};
		const offRuns = hub?.subscribeBots((event) => {
			if (event.type === "run" && event.payload.botId === activeId) refreshSoon();
		});
		const offResync = hub?.onResync(refreshSoon);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
			offRuns?.();
			offResync?.();
			if (hubTimer !== null) clearTimeout(hubTimer);
		};
	}, [activeId]);

	useEffect(() => {
		if (!activeId || !editingRoutine?.id) {
			setEditingRuns([]);
			return;
		}
		if (!persistedRoutineIds.current.has(editingRoutine.id)) {
			setEditingRuns([]);
			return;
		}
		let cancelled = false;
		listRoutineRuns(activeId, editingRoutine.id)
			.then((runs) => {
				if (!cancelled) setEditingRuns(runs);
			})
			.catch((error) => console.error("load routine runs failed", error));
		return () => {
			cancelled = true;
		};
	}, [activeId, editingRoutine?.id]);

	// Reabre o viewer do sandbox ativo da conversa (sobrevive a reload/F5).
	useEffect(() => {
		const conversationId = active?.conversationId;
		if (!conversationId) {
			return;
		}
		let cancelled = false;
		getActiveSandboxSession(conversationId)
			.then((session) => {
				if (cancelled || !session) return;
				rememberSandbox(conversationId, {
					sessionId: session.sessionId,
					viewerUrl: session.viewerUrl,
				});
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [active?.conversationId]);

	// Repouso é sempre "neutre": o rosto só muda durante o trabalho
	// (WorkingIndicator). Abrir a conversa limpa o "não lido" e garante
	// o estado neutro.
	useEffect(() => {
		if (!activeId) return;
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === activeId
					? { ...agent, state: "neutre" }
					: agent.state === "neutre"
						? agent
						: { ...agent, state: "neutre" },
			),
		);
	}, [activeId]);

	// Abrir a conversa marca os resultados em background como vistos (badge e e-mail).
	useEffect(() => {
		const conversationId = active?.conversationId;
		if (!conversationId) return;
		void markConversationResultsSeen(conversationId).catch(() => undefined);
	}, [active?.conversationId]);

	// Agente criado pelo card do bot (propose_bot): entra na lista sem recarregar a página.
	function addBotsFromServer() {
		void listBots()
			.then((bots) =>
				setAgents((previous) => {
					const known = new Set(previous.map((agent) => agent.id));
					const added = bots.filter((bot) => !known.has(bot.id)).map(botToAgent);
					return added.length > 0 ? [...added, ...previous] : previous;
				}),
			)
			.catch(() => undefined);
	}

	async function createBot({
		name,
		description,
		color = defaultBodyColor,
		shape,
	}: NewBotInput & { description?: string }): Promise<boolean> {
		try {
			const briefing = description?.trim() ?? "";
			const language = await resolveNewBotLanguage();
			const bot = await createBotRequest({
				name,
				color,
				...(language ? { language } : {}),
				...(shape ? { shape } : {}),
				snippet: "Bot recém-criado",
				...(briefing ? { description: briefing } : {}),
			});

			const target: Bot = bot;
			setAgents((previous) => [botToAgent(bot), ...previous]);
			setActiveId(bot.id);

			// Welcome run agêntico (fire-and-forget): mesmo padrão do config-close,
			// origin "chat". Offline/fila fora = sem run na v1 (débito aceito).
			const welcomeHash = hashString(
				stableStringify({ botId: target.id, name: target.name, briefing }),
			);
			const welcomeKey = `bot-created:${target.id}:${welcomeHash}`;
			if (!configFlushedHashesRef.current.has(welcomeKey)) {
				configFlushedHashesRef.current.add(welcomeKey);
				const userJson = JSON.stringify({
					event: "bot-created",
					name: target.name,
					description: briefing,
				});
				void createAgentRunRequest({
					messages: [
						{ role: "system", content: buildBotCreatedSystem(target.name) },
						{ role: "user", content: userJson },
					],
					botId: target.id,
					...(target.conversationId
						? { conversationId: target.conversationId }
						: {}),
					origin: "chat",
					objective:
						`[bot-created] Perguntas de onboarding do ${target.name}`.slice(
							0,
							120,
						),
					clientKey: welcomeKey.slice(0, 128),
					silent: true,
				}).catch((error) => console.error("bot-created run failed", error));
			}
			setNaming(false);
			if (createAsPrimaryRef.current) {
				createAsPrimaryRef.current = false;
				void setPrimaryBot(bot.id).catch(() => {
					toast.error(primaryFailureMessage(bot.name, true));
				});
			}
			return true;
		} catch (error) {
			console.error("create bot failed", error);
			return false;
		}
	}

	/** "Novo grupo": cria no servidor, entra na lista e abre a conversa do grupo. */
	async function createGroup(input: NewGroupInput, firstMessage: string): Promise<boolean> {
		try {
			const group = await createGroupRequest({
				name: input.name,
				memberIds: input.memberIds,
				...(input.color ? { color: input.color } : {}),
			});
			// O grupo só existe quando a primeira mensagem sai (como o Grok Bot).
			try {
				await postGroupMessageRequest(group.id, firstMessage);
			} catch (error) {
				console.error("first group message failed", error);
			}
			setAgents((previous) => [botToAgent(group), ...previous]);
			setActiveId(group.id);
			setNaming(false);
			setGroupCreating(false);
			setMobileConversationOpen(true);
			return true;
		} catch (error) {
			console.error("create group failed", error);
			return false;
		}
	}

	function groupErrorText(error: unknown): string {
		return error instanceof AtlasApiError ? error.message : "Não foi possível alterar o grupo. Tente novamente.";
	}

	/** Troca nome/cor do grupo na hora (não passa pelo "fechar a Config" dos bots). */
	function patchGroup(id: string, patch: { name?: string; color?: string }) {
		setGroupPanelError(null);
		setAgents((previous) => previous.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
		void updateBotRequest(id, patch).catch((error) => {
			console.error("update group failed", error);
			setGroupPanelError(groupErrorText(error));
		});
	}

	async function changeGroupMember(groupId: string, botId: string, change: "add" | "remove") {
		setGroupPanelError(null);
		try {
			const updated =
				change === "add"
					? await addGroupMemberRequest(groupId, botId)
					: await removeGroupMemberRequest(groupId, botId);
			setAgents((previous) =>
				previous.map((agent) => (agent.id === groupId ? { ...agent, members: updated.memberIds, snippet: updated.snippet || agent.snippet } : agent)),
			);
		} catch (error) {
			console.error("change group member failed", error);
			setGroupPanelError(groupErrorText(error));
		}
	}

	function captureConfigSnapshot(botId: string) {
		if (!botId) return;
		const agent = agentsRef.current.find((item) => item.id === botId);
		if (!agent) return;
		configSnapshotRef.current = { botId, before: toConfigSnapshot(agent) };
	}

	/** Salva a config do bot ~0,6 s depois da última mudança (cada controle vale na hora, sem botão Salvar). */
	function scheduleConfigAutosave(botId: string) {
		if (configAutosaveTimerRef.current) clearTimeout(configAutosaveTimerRef.current);
		configAutosaveTimerRef.current = setTimeout(() => {
			configAutosaveTimerRef.current = null;
			void flushConfigClose(botId);
		}, CONFIG_AUTOSAVE_MS);
	}

	function showConfigNotice(tone: "saved" | "error", text: string) {
		if (configNoticeTimerRef.current) clearTimeout(configNoticeTimerRef.current);
		setConfigNotice({ tone, text });
		configNoticeTimerRef.current = setTimeout(() => setConfigNotice(null), 2500);
	}

	/**
	 * Fechar a Config só SALVA (inclusive a descrição): 1 PATCH com o diff, ou 0
	 * chamadas sem diff. Nunca inicia run do agente; ele usa a config nova na
	 * próxima mensagem do usuário.
	 */
	async function flushConfigClose(botId: string) {
		if (!botId) return;
		if (configFlushingRef.current.has(botId)) {
			// Já tem um PATCH em voo: tenta de novo logo depois, para não perder esta mudança.
			scheduleConfigAutosave(botId);
			return;
		}
		const snapshot = configSnapshotRef.current;
		if (!snapshot || snapshot.botId !== botId) return;
		const current = agentsRef.current.find((item) => item.id === botId);
		if (!current) {
			configSnapshotRef.current = null;
			return;
		}
		const plan = planConfigClose(snapshot.before, current);
		if (!plan) {
			configSnapshotRef.current = null;
			return;
		}
		configFlushingRef.current.add(botId);
		try {
			await updateBotRequest(botId, plan.patch);
			showConfigNotice("saved", "Configuração salva");
			// O que acabou de gravar vira a nova base: mudanças feitas durante o PATCH
			// (ou depois dele) ainda entram no próximo diff, sem reenviar este.
			if (configSnapshotRef.current?.botId === botId) {
				configSnapshotRef.current = { botId, before: toConfigSnapshot(current) };
			}
		} catch (error) {
			// Falhou: mantém a base antiga para o próximo salvamento tentar de novo.
			console.error("config close flush failed", error);
			showConfigNotice("error", "Não foi possível salvar a configuração");
		} finally {
			configFlushingRef.current.delete(botId);
		}
	}

	/**
	 * "Bot principal": um por conta. Persiste na hora (não espera fechar a Config) e o
	 * servidor desmarca o anterior. Rejeita se o PATCH falhar (e desfaz o otimismo).
	 */
	async function setPrimaryBot(id: string, value = true): Promise<void> {
		const before = agentsRef.current.map((agent) => ({ id: agent.id, isPrimary: agent.isPrimary }));
		setAgents((previous) =>
			previous.map((agent) => ({ ...agent, isPrimary: agent.id === id ? value : value ? false : agent.isPrimary })),
		);
		try {
			await updateBotRequest(id, { isPrimary: value });
		} catch (error) {
			console.error("update primary bot failed", error);
			setAgents((previous) =>
				previous.map((agent) => ({ ...agent, isPrimary: before.find((item) => item.id === agent.id)?.isPrimary })),
			);
			throw error;
		}
	}

	function setPrimaryBotNow(id: string, value: boolean) {
		const name = agentsRef.current.find((agent) => agent.id === id)?.name ?? "bot";
		void setPrimaryBot(id, value).catch(() => {
			toast.error(primaryFailureMessage(name, value));
		});
	}

	function dismissPrimaryIntro() {
		setIntroDismissed(true);
		try {
			writePrimaryIntroDismissed(window.localStorage, primaryIntroStorageKey);
		} catch {
			// storage indisponível: o modal volta na próxima carga.
		}
	}

	/** "Criar um Bot principal": abre o fluxo normal de criar bot; o novo vira o principal. */
	function startCreatePrimaryBot() {
		dismissPrimaryIntro();
		createAsPrimaryRef.current = true;
		setNaming(true);
		setMobileConversationOpen(true);
	}

	function updateAgent(patch: Partial<Agent> & { policyJson?: unknown }) {
		const id = activeIdRef.current;
		if (!id) return;
		// Cada mudança vale na hora: espelha local e agenda o PATCH com o diff
		// (flushConfigClose, debounce curto). Fechar a vista ou trocar de bot salva o
		// que ainda estiver pendente. Blocklist (pinned, pinOrder, sectionId,
		// memberIds, notifications) nunca entra no diff — notifications segue
		// local-only (débito documentado).
		if (configSnapshotRef.current?.botId !== id) captureConfigSnapshot(id);
		scheduleConfigAutosave(id);
		if (
			typeof patch.openRouterModel === "string" &&
			patch.openRouterModel.trim()
		) {
			setStoredAgentModel(id, patch.openRouterModel.trim());
		}
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === id ? { ...agent, ...patch } : agent,
			),
		);
		// Notificações push valem na hora no servidor (não passam pelo diff do fechar-config).
		if (typeof patch.notify === "boolean") {
			const previousNotify = agentsRef.current.find((agent) => agent.id === id)?.notify;
			void updateBotRequest(id, { notify: patch.notify }).catch(() => {
				setAgents((previous) => previous.map((agent) => (agent.id === id ? { ...agent, notify: previousNotify } : agent)));
				toast.error(notifyFailureMessage(agentsRef.current.find((agent) => agent.id === id)?.name ?? "bot"));
			});
		}
	}

	/** Modelo trocado pelo composer (fora da Config): persiste na hora. */
	function persistAgentModelNow(model: string) {
		const id = activeIdRef.current;
		if (!id) return;
		// Mesmo modelo já salvo: sem PATCH vazio nem evento duplicado.
		// Vazio (Automático) também persiste: limpa o modelo fixo do bot (PATCH null).
		const current = agentsRef.current.find((agent) => agent.id === id);
		const plan = planModelPersist(current?.openRouterModel, model);
		if (!plan) return;
		const trimmed = plan.model;
		const previousModel = current?.openRouterModel;
		setStoredAgentModel(id, trimmed);
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === id ? { ...agent, openRouterModel: trimmed } : agent,
			),
		);
		// Realinha o `before` (como applyBotProfilePatch): o fechamento da Config
		// não reenvia o modelo que acabou de ser persistido.
		configSnapshotRef.current = realignSnapshotModel(
			configSnapshotRef.current,
			id,
			trimmed,
		);
		void settleOptimistic({
			request: updateBotRequest(id, { openRouterModel: plan.apiValue }),
			log: (error) => console.error("update bot model failed", error),
			message: modelFailureMessage(current?.name ?? "bot"),
			notify: (message) => toast.error(message),
			revert: () => {
				setStoredAgentModel(id, previousModel ?? "");
				configSnapshotRef.current = realignSnapshotModel(configSnapshotRef.current, id, previousModel ?? "");
				setAgents((previous) => restoreAgentFields(previous, id, { openRouterModel: previousModel }));
			},
		});
	}

	/**
	 * Proposta de perfil aprovada na thread: espelha local (o PATCH já foi
	 * aplicado no servidor) e realinha o snapshot da Config para o flush não
	 * reenviar o mesmo diff ao fechar.
	 */
	function applyBotProfilePatch(
		botId: string,
		patch: {
			name?: string;
			snippet?: string;
			description?: string | null;
			openRouterModel?: string | null;
		},
	) {
		if (!botId) return;
		if (
			typeof patch.openRouterModel === "string" &&
			patch.openRouterModel.trim()
		) {
			setStoredAgentModel(botId, patch.openRouterModel.trim());
		}
		const clean: Partial<Agent> = {};
		if (patch.name !== undefined) clean.name = patch.name;
		if (patch.snippet !== undefined) clean.snippet = patch.snippet;
		if (patch.description !== undefined) {
			clean.description = patch.description ?? undefined;
		}
		if (patch.openRouterModel !== undefined) {
			clean.openRouterModel = patch.openRouterModel ?? undefined;
		}
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === botId ? { ...agent, ...clean } : agent,
			),
		);
		const snapshot = configSnapshotRef.current;
		if (snapshot && snapshot.botId === botId) {
			const current = agentsRef.current.find((item) => item.id === botId);
			if (current) {
				configSnapshotRef.current = {
					botId,
					before: toConfigSnapshot({ ...current, ...clean }),
				};
			}
		}
	}

	// Snapshot before ao abrir a Config (panelView vira "settings").
	useEffect(() => {
		if (panelView !== "settings") return;
		const id = activeId;
		if (!id) return;
		if (configSnapshotRef.current?.botId === id) return;
		captureConfigSnapshot(id);
	}, [panelView, activeId]);

	// Trocar de bot com o painel aberto: flush do anterior (não cruza diffs).
	useEffect(() => {
		const previous = prevActiveIdRef.current;
		if (previous && previous !== activeId) {
			void flushConfigClose(previous);
		}
		prevActiveIdRef.current = activeId;
	}, [activeId]);

	function serializeRoutineMutation<T>(
		routineId: string,
		mutate: () => Promise<T>,
	): Promise<T> {
		const previous =
			routineMutations.current.get(routineId) ?? Promise.resolve();
		const operation = previous.then(mutate);
		const completion = operation.then(
			() => undefined,
			() => undefined,
		);
		routineMutations.current.set(routineId, completion);
		void completion.then(() => {
			if (routineMutations.current.get(routineId) === completion) {
				routineMutations.current.delete(routineId);
			}
		});
		return operation;
	}

	/**
	 * Autosave de rotina JÁ CRIADA (o editor faz o debounce/flush). Rascunho
	 * nunca passa por aqui: só `createRoutine`, no clique em "Criar rotina".
	 */
	function saveRoutine(routine: Routine): Promise<void> | void {
		if (suppressPersistIds.current.has(routine.id)) return;
		if (!persistedRoutineIds.current.has(routine.id)) return;
		setRoutines((previous) =>
			previous.map((item) => (item.id === routine.id ? routine : item)),
		);
		setEditingRoutine((current) =>
			current?.id === routine.id ? routine : current,
		);
		if (!activeId) return;
		return serializeRoutineMutation(routine.id, () => persistRoutine(routine));
	}

	/** Cria o rascunho no servidor — só no clique, com guarda contra duplo clique. */
	async function createRoutine(routine: Routine): Promise<boolean> {
		if (!activeId) return false;
		if (persistedRoutineIds.current.has(routine.id)) return true;
		if (creatingRoutineIds.current.has(routine.id)) return true;
		if (
			!isRoutineDraftValid({
				name: routine.name,
				instruction: routine.instruction,
				triggers: routine.triggers,
			})
		) {
			return false;
		}
		creatingRoutineIds.current.add(routine.id);
		const botId = activeId;
		return serializeRoutineMutation(routine.id, async () => {
			try {
				const created = await createRoutineRequest(
					botId,
					uiRoutineToPayload(routine),
				);
				persistedRoutineIds.current.add(created.routine.id);
				const ui = recordToUiRoutine(created.routine);
				snapshotRoutine(ui);
				if (created.hook?.secret) {
					setRoutineOneTimeSecret(created.hook.secret);
				}
				setRoutines((previous) => [
					ui,
					...previous.filter(
						(item) => item.id !== routine.id && item.id !== ui.id,
					),
				]);
				// Troca o rascunho pela rotina do servidor: o editor remonta já
				// mostrando URL + secret (webhook).
				setEditingRoutine((current) =>
					current?.id === routine.id || current?.id === ui.id ? ui : current,
				);
				return true;
			} catch (error) {
				console.error("create routine failed", error);
				return false;
			} finally {
				creatingRoutineIds.current.delete(routine.id);
			}
		});
	}

	async function toggleRoutine(
		routine: Routine,
		enabled: boolean,
	): Promise<string | null> {
		if (!activeId || !persistedRoutineIds.current.has(routine.id)) {
			return "Salve a rotina antes de ativá-la.";
		}
		try {
			const botId = activeId;
			const updated = await serializeRoutineMutation(routine.id, () =>
				updateRoutineRequest(botId, routine.id, { enabled }),
			);
			const ui = recordToUiRoutine(updated.routine);
			snapshotRoutine(ui);
			setRoutines((previous) =>
				previous.map((item) =>
					item.id === ui.id ? { ...item, active: ui.active } : item,
				),
			);
			setEditingRoutine((current) =>
				current?.id === ui.id ? { ...current, active: ui.active } : current,
			);
			return null;
		} catch (error) {
			console.error("toggle routine failed", error);
			return error instanceof AtlasApiError
				? error.message
				: "Não foi possível alterar a rotina.";
		}
	}

	async function reloadBotRoutines(botId: string) {
		const [records, runs, groups] = await Promise.all([
			listRoutinesRequest(botId),
			listBotRoutineRuns(botId),
			listRoutineGroupsRequest(botId).catch(() => null),
		]);
		if (groups) setRoutineGroups(groups);
		persistedRoutineIds.current = new Set(records.map((row) => row.id));
		snapshotRoutineRecords(records);
		setRoutines(records.map(recordToUiRoutine));
		setBotRoutineRuns(
			runs.map((run) => ({
				id: run.id,
				name: `${run.routineName} · ${routineRunLabel(run)}`,
				time: formatRoutineRunTime(run.createdAt),
			})),
		);
		return records;
	}

	function routineGroupError(error: unknown, fallback: string): string {
		return error instanceof AtlasApiError ? error.message : fallback;
	}

	/** Cria um grupo pelo editor de rotina. */
	async function createRoutineGroupFor(
		name: string,
	): Promise<{ id: string; name: string } | { error: string }> {
		if (!activeId) return { error: "Selecione um bot." };
		try {
			const group = await createRoutineGroupRequest(activeId, { name });
			setRoutineGroups((previous) => [...previous, group]);
			return { id: group.id, name: group.name };
		} catch (error) {
			console.error("create routine group failed", error);
			return { error: routineGroupError(error, "Não foi possível criar o grupo.") };
		}
	}

	async function renameRoutineGroupFor(groupId: string, name: string): Promise<string | null> {
		if (!activeId) return "Selecione um bot.";
		try {
			const group = await updateRoutineGroupRequest(activeId, groupId, { name });
			setRoutineGroups((previous) => previous.map((item) => (item.id === group.id ? group : item)));
			return null;
		} catch (error) {
			console.error("rename routine group failed", error);
			return routineGroupError(error, "Não foi possível renomear o grupo.");
		}
	}

	async function setRoutineGroupEnabledFor(groupId: string, enabled: boolean): Promise<string | null> {
		if (!activeId) return "Selecione um bot.";
		try {
			await setRoutineGroupEnabledRequest(activeId, groupId, enabled);
			await reloadBotRoutines(activeId);
			return null;
		} catch (error) {
			console.error("toggle routine group failed", error);
			return routineGroupError(error, "Não foi possível alterar o grupo.");
		}
	}

	async function deleteRoutineGroupFor(groupId: string, deleteRoutines: boolean): Promise<string | null> {
		if (!activeId) return "Selecione um bot.";
		try {
			const editingWasSaved = Boolean(editingRoutine && persistedRoutineIds.current.has(editingRoutine.id));
			await deleteRoutineGroupRequest(activeId, groupId, deleteRoutines);
			setRoutineGroups((previous) => previous.filter((item) => item.id !== groupId));
			await reloadBotRoutines(activeId);
			if (deleteRoutines && editingRoutine && editingWasSaved && !persistedRoutineIds.current.has(editingRoutine.id)) {
				// Rotina aberta no editor foi apagada junto com o grupo: fecha o editor.
				setEditingRoutine(undefined);
				setEditingRuns([]);
				setPanelView("default");
			}
			return null;
		} catch (error) {
			console.error("delete routine group failed", error);
			return routineGroupError(error, "Não foi possível apagar o grupo.");
		}
	}

	/** PATCH de rotina já criada (só o diff). A criação é `createRoutine`. */
	async function persistRoutine(routine: Routine) {
		if (!activeId) return;
		if (suppressPersistIds.current.has(routine.id)) return;
		if (!persistedRoutineIds.current.has(routine.id)) return;
		const payload = uiRoutineToPayload(routine);
		try {
			// Manda só o que mudou desde o último estado conhecido do
			// servidor — nunca o payload inteiro (ver `diffRoutineUpdatePayload`:
			// um PATCH "cego" reescreveria por cima de uma edição concorrente,
			// ex.: o agente mudando o horário por fora enquanto o painel
			// autosava com o horário antigo ainda em tela).
			const previousUi = serverRoutineSnapshots.current.get(routine.id);
			const patch = diffRoutineUpdatePayload(
				payload,
				previousUi ? uiRoutineToPayload(previousUi) : undefined,
			);
			if (Object.keys(patch).length === 0) {
				return;
			}
			const updated = await updateRoutineRequest(activeId, routine.id, patch);
			const ui = recordToUiRoutine(updated.routine);
			snapshotRoutine(ui);
			setRoutines((previous) =>
				previous.map((item) => (item.id === ui.id ? ui : item)),
			);
			setEditingRoutine((current) =>
				current?.id === ui.id
					? { ...ui, hook: ui.hook ?? current.hook }
					: current,
			);
		} catch (error) {
			if (error instanceof AtlasApiError && error.status === 404) {
				// Id fantasma (rotina apagada): limpa e reidrata.
				persistedRoutineIds.current.delete(routine.id);
				await reloadBotRoutines(activeId);
				setEditingRoutine((current) => {
					if (!current || current.id !== routine.id) return current;
					return persistedRoutineIds.current.has(current.id) ? current : undefined;
				});
				if (!persistedRoutineIds.current.has(routine.id)) {
					setPanelView((view) => (view === "routine" ? "default" : view));
				}
				return;
			}
			console.error("persist routine failed", error);
			throw error;
		}
	}

	async function rotateRoutineSecretFor(routine: Routine) {
		if (!activeId) return;
		if (!persistedRoutineIds.current.has(routine.id)) return;
		try {
			const result = await rotateRoutineSecretRequest(activeId, routine.id);
			const ui = recordToUiRoutine(result.routine);
			snapshotRoutine(ui);
			if (result.hook?.secret) {
				setRoutineOneTimeSecret(result.hook.secret);
			}
			setRoutines((previous) =>
				previous.map((item) => (item.id === ui.id ? ui : item)),
			);
			setEditingRoutine((current) => (current?.id === ui.id ? ui : current));
		} catch (error) {
			console.error("rotate routine secret failed", error);
		}
	}

	/** Foca o composer com um texto pronto (ex.: "Editar com o agente", chooser "Descreva no chat"). */
	function prefillComposer(text: string) {
		setComposerPrefill({ text, nonce: Date.now() });
	}

	/** "Editar com o agente": prefill do composer + fecha o overlay da rotina. */
	function editRoutineWithAgent(routine: Routine) {
		prefillComposer(
			`Edite sua rotina: ${routine.name} (id ${routine.id}): `,
		);
		closeSettingsView();
	}

	/** Salva só o gatilho GitHub (botão explícito "Salvar gatilho" — nunca autosave). */
	async function saveGithubTrigger(
		github: RoutineGithubUiConfig,
	): Promise<RoutineGithubUiConfig | { error: string }> {
		if (!activeId || !editingRoutine) {
			return { error: "Rotina não encontrada" };
		}
		try {
			const updated = await updateRoutineRequest(activeId, editingRoutine.id, {
				githubTrigger: {
					repo: github.repo.trim(),
					events: github.events,
					prNumber: parsePrNumberInput(github.prNumber) ?? null,
					users: parseUsersInput(github.users) ?? null,
					ciBranch: github.ciBranch.trim() || null,
				},
			});
			const ui = recordToUiRoutine(updated.routine);
			snapshotRoutine(ui);
			setRoutines((previous) =>
				previous.map((item) => (item.id === ui.id ? ui : item)),
			);
			setEditingRoutine((current) => (current?.id === ui.id ? ui : current));
			return ui.github ?? github;
		} catch (error) {
			const message =
				error instanceof AtlasApiError
					? error.message
					: "Não foi possível salvar o gatilho";
			return { error: message };
		}
	}

	/** Cria uma rotina de uma vez (templates do chooser) — sempre create, nunca update. */
	async function createRoutineFromChooser(
		template: GithubRoutineTemplate,
		fields: TemplateCreateFields,
	): Promise<string | null> {
		if (!activeId) return "Selecione um bot primeiro";
		try {
			const created = await createRoutineRequest(activeId, {
				name: template.defaultName,
				prompt: template.defaultPrompt,
				model: active?.openRouterModel?.trim() || DEFAULT_OPENROUTER_MODEL,
				triggerType: "event",
				trigger: {
					kind: "github",
					repo: fields.repo,
					events: template.events,
					...(fields.prNumber !== undefined
						? { prNumber: fields.prNumber }
						: {}),
					...(fields.ciBranch ? { ciBranch: fields.ciBranch } : {}),
				},
			});
			persistedRoutineIds.current.add(created.routine.id);
			const ui = recordToUiRoutine(created.routine);
			setRoutines((previous) => [
				ui,
				...previous.filter((item) => item.id !== ui.id),
			]);
			setRoutineOneTimeSecret(null);
			setEditingRoutine(ui);
			setPanelOpen(true);
			setPanelView("routine");
			return null;
		} catch (error) {
			return error instanceof AtlasApiError
				? error.message
				: "Não foi possível criar a rotina";
		}
	}

	/** Chooser "Agendada": abre um rascunho cron vazio (mesmo fluxo de antes). */
	function openNewScheduledRoutineDraft() {
		if (!active) return;
		setRoutineOneTimeSecret(null);
		setEditingRoutine({
			id: crypto.randomUUID(),
			name: "",
			instruction: "",
			active: true,
			model: active.openRouterModel?.trim() || DEFAULT_OPENROUTER_MODEL,
			triggerKind: "cron",
			triggers: [],
		});
		setPanelOpen(true);
		setPanelView("routine");
	}

	/** Chooser "Webhook": abre um rascunho de webhook genérico. */
	function openNewWebhookRoutineDraft() {
		if (!active) return;
		setRoutineOneTimeSecret(null);
		setEditingRoutine({
			id: crypto.randomUUID(),
			name: "",
			instruction: "",
			active: true,
			model: active.openRouterModel?.trim() || DEFAULT_OPENROUTER_MODEL,
			triggerKind: "event",
			triggers: [{ id: "webhook", text: "Webhook" }],
		});
		setPanelOpen(true);
		setPanelView("routine");
	}

	async function deleteRoutineFor(routine: Routine) {
		if (!activeId) return;
		const routineId = routine.id;
		suppressPersistIds.current.add(routineId);
		creatingRoutineIds.current.delete(routineId);
		try {
			if (persistedRoutineIds.current.has(routineId)) {
				await deleteRoutineRequest(activeId, routineId);
				persistedRoutineIds.current.delete(routineId);
			}
			setRoutines((previous) =>
				previous.filter((item) => item.id !== routineId),
			);
			if (editingRoutine?.id === routineId) {
				setEditingRoutine(undefined);
				setEditingRuns([]);
				setPanelView("default");
			}
		} catch (error) {
			suppressPersistIds.current.delete(routineId);
			console.error("delete routine failed", error);
		}
	}

	/** Retorna `false` se não conseguiu iniciar a execução de teste. */
	async function runRoutineFor(routine: Routine): Promise<boolean> {
		if (!activeId) return false;
		if (!persistedRoutineIds.current.has(routine.id)) return false;
		setRoutineRunning(true);
		try {
			try {
				await runRoutineNow(activeId, routine.id);
			} catch (error) {
				console.error("run routine failed", error);
				return false;
			}
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const [runs, botRuns] = await Promise.all([
					listRoutineRuns(activeId, routine.id),
					listBotRoutineRuns(activeId),
				]);
				if (editingRoutine?.id === routine.id) setEditingRuns(runs);
				setBotRoutineRuns(
					botRuns.map((run) => ({
						id: run.id,
						name: `${run.routineName} · ${routineRunLabel(run)}`,
						time: formatRoutineRunTime(run.createdAt),
					})),
				);
				const latest = runs[0];
				if (
					latest &&
					latest.status !== "queued" &&
					latest.status !== "running"
				) {
					break;
				}
				await new Promise((resolve) => window.setTimeout(resolve, 1500));
			}
			return true;
		} catch (error) {
			console.error("poll routine runs failed", error);
			return true;
		} finally {
			setRoutineRunning(false);
		}
	}

	function persistPins(previous: Agent[], next: Agent[]) {
		for (const agent of next) {
			const before = previous.find((item) => item.id === agent.id);
			if (!before) continue;
			if (
				before.pinned === agent.pinned &&
				(before.pinOrder ?? null) === (agent.pinOrder ?? null)
			) {
				continue;
			}
			void settleOptimistic({
				request: updateBotRequest(agent.id, {
					pinned: Boolean(agent.pinned),
					pinOrder: agent.pinned ? (agent.pinOrder ?? null) : null,
				}),
				log: (error) => console.error("pin update failed", error),
				message: pinFailureMessage(agent.name, pinChangeKind(before, agent)),
				notify: (message) => toast.error(message),
				revert: () =>
					setAgents((current) =>
						restoreAgentFields(current, agent.id, { pinned: before.pinned, pinOrder: before.pinOrder }),
					),
			});
		}
	}

	function placePinned(id: string, target: number) {
		const order = agents
			.filter((agent) => agent.pinned)
			.sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0))
			.map((agent) => agent.id)
			.filter((pinnedId) => pinnedId !== id);
		const index = Math.max(0, Math.min(target, order.length));
		order.splice(index, 0, id);
		const ranks = new Map(
			order.map((pinnedId, position) => [pinnedId, position]),
		);
		const next = agents.map((agent) =>
			ranks.has(agent.id)
				? { ...agent, pinned: true, pinOrder: ranks.get(agent.id) }
				: agent,
		);
		setAgents(next);
		persistPins(agents, next);
	}

	function unpinAgent(id: string) {
		const next = agents.map((agent) =>
			agent.id === id ? { ...agent, pinned: false } : agent,
		);
		setAgents(next);
		const before = agents.find((agent) => agent.id === id);
		void settleOptimistic({
			request: updateBotRequest(id, { pinned: false, pinOrder: null }),
			log: (error) => console.error("unpin failed", error),
			message: pinFailureMessage(before?.name ?? "bot", "unpin"),
			notify: (message) => toast.error(message),
			revert: () =>
				setAgents((current) => restoreAgentFields(current, id, { pinned: before?.pinned, pinOrder: before?.pinOrder })),
		});
	}

	function pinAgent(id: string) {
		placePinned(id, agents.filter((agent) => agent.pinned).length);
	}

	function moveToSection(agentId: string, sectionId: string | null) {
		const before = agentsRef.current.find((agent) => agent.id === agentId);
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === agentId ? { ...agent, sectionId } : agent,
			),
		);
		void settleOptimistic({
			request: updateBotRequest(agentId, { sectionId }),
			log: (error) => console.error("move bot to section failed", error),
			message: sectionFailureMessage(before?.name ?? "bot"),
			notify: (message) => toast.error(message),
			revert: () => setAgents((current) => restoreAgentFields(current, agentId, { sectionId: before?.sectionId ?? null })),
		});
	}

	async function createSectionAndMove(agentId: string) {
		try {
			const section = await createSectionRequest({ name: "Nova sessão" });
			setSections((previous) =>
				[...previous, section].sort((a, b) => a.order - b.order),
			);
			moveToSection(agentId, section.id);
		} catch (error) {
			console.error("create section failed", error);
			toast.error(sectionActionFailureMessage("create"));
		}
	}

	async function renameSection(id: string, name: string) {
		const trimmed = name.trim();
		if (!trimmed) return;
		const previousName = sections.find((section) => section.id === id)?.name;
		setSections((previous) =>
			previous.map((section) =>
				section.id === id ? { ...section, name: trimmed } : section,
			),
		);
		try {
			const updated = await updateSectionRequest(id, { name: trimmed });
			setSections((previous) =>
				previous.map((section) => (section.id === id ? updated : section)),
			);
		} catch (error) {
			console.error("rename section failed", error);
			if (previousName !== undefined) {
				setSections((previous) =>
					previous.map((section) => (section.id === id ? { ...section, name: previousName } : section)),
				);
			}
			toast.error(sectionActionFailureMessage("rename"));
		}
	}

	async function moveSection(id: string, direction: "up" | "down") {
		const ordered = [...sections].sort((a, b) => a.order - b.order);
		const index = ordered.findIndex((section) => section.id === id);
		const swapIndex = direction === "up" ? index - 1 : index + 1;
		if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) return;
		const current = ordered[index]!;
		const other = ordered[swapIndex]!;
		setSections((previous) =>
			previous.map((section) =>
				section.id === current.id
					? { ...section, order: other.order }
					: section.id === other.id
						? { ...section, order: current.order }
						: section,
			),
		);
		try {
			await Promise.all([
				updateSectionRequest(current.id, { order: other.order }),
				updateSectionRequest(other.id, { order: current.order }),
			]);
		} catch (error) {
			console.error("move section failed", error);
			setSections((previous) =>
				previous.map((section) =>
					section.id === current.id
						? { ...section, order: current.order }
						: section.id === other.id
							? { ...section, order: other.order }
							: section,
				),
			);
			toast.error(sectionActionFailureMessage("reorder"));
		}
	}

	async function deleteSectionById(id: string) {
		try {
			await deleteSectionRequest(id);
		} catch (error) {
			console.error("delete section failed", error);
			toast.error(sectionActionFailureMessage("delete"));
			return;
		}
		setSections((previous) => previous.filter((section) => section.id !== id));
		// O backend solta os bots da sessão (sectionId -> null); espelha local.
		setAgents((previous) =>
			previous.map((agent) =>
				agent.sectionId === id ? { ...agent, sectionId: null } : agent,
			),
		);
	}

	function applyReadState(id: string, state: { unreadCount: number; firstUnreadMessageId: string | null; manualUnread: boolean }) {
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === id
					? {
							...agent,
							unreadCount: state.unreadCount,
							firstUnreadMessageId: state.firstUnreadMessageId,
							manualUnread: state.manualUnread,
							notifications: state.unreadCount > 0 || state.manualUnread,
						}
					: agent,
			),
		);
	}

	// "Marcar como lido/não lido" grava no servidor (vale em todos os dispositivos); otimista, volta se falhar.
	function markAgentUnread(id: string, unread: boolean) {
		const target = agents.find((agent) => agent.id === id);
		const before = target
			? { unreadCount: target.unreadCount ?? 0, firstUnreadMessageId: target.firstUnreadMessageId ?? null, manualUnread: target.manualUnread ?? false }
			: null;
		setAgents((previous) =>
			previous.map((agent) =>
				agent.id === id
					? { ...agent, notifications: unread, manualUnread: unread, ...(unread ? {} : { unreadCount: 0, firstUnreadMessageId: null }) }
					: agent,
			),
		);
		const conversationId = target?.conversationId;
		if (!conversationId) return;
		readTouchRef.current.set(id, Date.now());
		const request = unread ? markConversationUnreadRequest(conversationId) : markConversationReadRequest(conversationId);
		void request.then((state) => {
			readTouchRef.current.set(id, Date.now());
			applyReadState(id, state);
		}).catch(() => {
			if (before) applyReadState(id, before);
			toast.error(readFailureMessage(target?.name ?? "bot", unread));
		});
	}

	// A thread avisa que a última mensagem foi vista de verdade (visível + aba em foco).
	function markActiveRead(messageId: string) {
		const target = agents.find((agent) => agent.id === activeId);
		const conversationId = target?.conversationId;
		if (!target || !conversationId) return;
		const send = (id?: string) => markConversationReadRequest(conversationId, id);
		readTouchRef.current.set(target.id, Date.now());
		void send(messageId)
			.catch((error) => (error instanceof AtlasApiError && error.status === 404 ? send() : Promise.reject(error)))
			.then((state) => {
				readTouchRef.current.set(target.id, Date.now());
				applyReadState(target.id, state);
				void clearConversationNotifications(conversationId);
			})
			.catch(() => undefined);
	}

	// Âncora "Novas mensagens": fixada ao abrir a conversa e mantida até sair dela. Nasce do estado de leitura
	// FRESCO do servidor (a lista pode ter até 30s, ou já ter sido lida em outro aparelho); se a rede demorar,
	// vale o da lista depois de ANCHOR_WAIT_MS. A conversa só pousa e só marca como lida depois disso (ready).
	const [unreadAnchor, setUnreadAnchor] = useState<{ conversationId: string; messageId: string | null; ready: boolean } | null>(null);
	useEffect(() => {
		const conversationId = active?.conversationId;
		if (!botsLoaded || !conversationId || !active) return;
		const agentId = active.id;
		setUnreadAnchor((previous) => {
			if (previous?.conversationId === conversationId) return previous;
			return { conversationId, messageId: active.firstUnreadMessageId ?? null, ready: false };
		});
		const settle = (messageId: string | null | undefined) =>
			setUnreadAnchor((previous) =>
				previous && previous.conversationId === conversationId && !previous.ready
					? { conversationId, messageId: messageId === undefined ? previous.messageId : messageId, ready: true }
					: previous,
			);
		const timer = window.setTimeout(() => settle(undefined), ANCHOR_WAIT_MS);
		void getConversationReadState(conversationId)
			.then((state) => {
				applyReadState(agentId, state);
				settle(state.firstUnreadMessageId);
			})
			.catch(() => settle(undefined));
		return () => window.clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active?.conversationId, botsLoaded]);

	// Toque numa notificação (app fechado: ?bot=…; aberto: mensagem do service worker): abre a conversa e o cartão.
	useNotificationOpen(botsLoaded, ({ botId, cardId }) => {
		if (!agentsRef.current.some((item) => item.id === botId)) return;
		if (cardId) requestScrollToCard(cardId);
		setNaming(false);
		setActiveId(botId);
		setMobileConversationOpen(true);
	});

	function hideAgent(id: string) {
		setHiddenIds((previous) =>
			previous.includes(id) ? previous : [...previous, id],
		);
	}

	const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
	const [deleting, setDeleting] = useState(false);

	function requestDeleteAgent(id: string) {
		const target = agents.find((agent) => agent.id === id);
		if (target) setDeleteTarget(target);
	}

	async function confirmDeleteAgent() {
		if (!deleteTarget || deleting) return;
		setDeleting(true);
		try {
			await deleteBotRequest(deleteTarget.id);
		} catch (error) {
			console.error("delete bot failed", error);
			toast.error(deleteBotFailureMessage(deleteTarget.name));
			setDeleting(false);
			return;
		}
		const removedId = deleteTarget.id;
		setAgents((previous) =>
			previous
				.filter((agent) => agent.id !== removedId)
				.map((agent) =>
					agent.members?.includes(removedId)
						? { ...agent, members: agent.members.filter((memberId) => memberId !== removedId) }
						: agent,
				),
		);
		setHiddenIds((previous) =>
			previous.filter((hidden) => hidden !== removedId),
		);
		setActiveId((previous) => {
			if (previous !== removedId) return previous;
			const remaining = agents.filter((agent) => agent.id !== removedId);
			return remaining[0]?.id ?? "";
		});
		setDeleteTarget(null);
		setDeleting(false);
	}

	// Conversa entre bots: 2+ bots (grupos não contam); sem principal, a lista sugere escolher um.
	const botCount = agents.filter((agent) => !agent.members?.length).length;
	const hasMultipleBots = botCount >= 2;
	const showPrimaryIntro = shouldShowPrimaryIntro({
		agents,
		loading: loadingBots,
		dismissed: introDismissed,
		busy: naming,
	});
	const visibleAgents = useMemo(
		() => agents.filter((agent) => !hiddenIds.includes(agent.id)),
		[agents, hiddenIds],
	);

	const primaryMenuActions = {
		canPickPrimary: hasMultipleBots,
		onSetPrimary: (id: string) => setPrimaryBotNow(id, true),
		onReplacePrimary: () => setReplacePrimaryOpen(true),
	};

	// Estável: a conversa aberta chama isto durante o stream (com limite de frequência).
	const updateLatestMessage = useCallback((botId: string, text: string) => {
		setAgents((previous) => {
			if (!previous.some((agent) => agent.id === botId && agent.lastMessage !== text)) return previous;
			return previous.map((agent) => (agent.id === botId ? { ...agent, lastMessage: text } : agent));
		});
	}, []);

	function openSettings() {
		const id = activeIdRef.current;
		// Grupo: a terceira coluna já é o painel do grupo (membros e detalhes), sem tela de configuração.
		if (agentsRef.current.find((item) => item.id === id)?.members?.length) {
			setPanelOpen(true);
			return;
		}
		if (id && !configSnapshotRef.current) captureConfigSnapshot(id);
		setPanelOpen(true);
		setPanelView("settings");
	}

	useEffect(() => {
		// Provedores é da conta (não do bot): o evento abre o modal em ?settings=provedores.
		return listenForProviderSettings();
	}, []);

	function openRoutineFromChat(payload: OpenRoutinePayload) {
		void (async () => {
			if (!activeId) return;
			setRoutineOneTimeSecret(payload.hookSecret ?? null);
			setPanelOpen(true);
			try {
				const records = await reloadBotRoutines(activeId);
				const record = records.find((row) => row.id === payload.routineId);
				if (record) {
					const ui = recordToUiRoutine(record);
					setEditingRoutine({
						...ui,
						model:
							ui.model?.trim() ||
							active?.openRouterModel?.trim() ||
							DEFAULT_OPENROUTER_MODEL,
					});
					setPanelView("routine");
					return;
				}
			} catch (error) {
				console.error("reload routines for chat card failed", error);
			}
			// Não marca como persisted nem inventa draft — evita PATCH 404 + create duplicado.
			const local = routines.find((item) => item.id === payload.routineId);
			if (local) {
				setEditingRoutine({
					...local,
					model:
						local.model?.trim() ||
						active?.openRouterModel?.trim() ||
						DEFAULT_OPENROUTER_MODEL,
				});
				setPanelView("routine");
				return;
			}
			console.warn("routine from chat not found on server", payload.routineId);
		})();
	}

	/** "Em andamento": vai para a conversa do item e, sendo sessão de código, abre o painel dela. */
	function openActiveWork(item: ActiveWorkItemResponse, mobile = false) {
		if (item.botId) setActiveId(item.botId);
		if (mobile) {
			setNaming(false);
			setMobileConversationOpen(true);
		}
		if (item.kind !== "dev") return;
		hydrateDevSessionFromApi({
			id: item.id,
			status: item.status,
			repo: item.repo,
			branch: item.branch,
			startedAt: item.startedAt,
			lastActiveAt: item.lastActiveAt,
		});
		openActivity({ kind: "dev", sessionId: item.id });
	}

	function editAgent(id: string) {
		const previous = activeIdRef.current;
		if (previous && previous !== id) void flushConfigClose(previous);
		setActiveId(id);
		setPanelOpen(true);
		setPanelView(agentsRef.current.find((item) => item.id === id)?.members?.length ? "default" : "settings");
	}

	/** Fechamento central da 3ª coluna: 1 PATCH, ou 0 chamadas sem diff. Nunca cria run. */
	function closeSettingsView() {
		const target = configSnapshotRef.current?.botId ?? activeIdRef.current;
		setEditingRoutine(undefined);
		setRoutineOneTimeSecret(null);
		closeActivity();
		setPanelView("default");
		if (target) void flushConfigClose(target);
	}

	/** Fechar o painel (toggle/resize): flush pendente antes de esconder. */
	function closePanel() {
		const target = configSnapshotRef.current?.botId ?? activeIdRef.current;
		setPanelOpen(false);
		if (target) void flushConfigClose(target);
	}

	async function startSandbox() {
		setSandboxBusy(true);
		setSandboxError(null);
		setSandboxRestarting(false);
		try {
			// O servidor já refaz o start até 3 vezes com container novo; aqui 1 retry
			// cobre falha de rede/503 transitório e mostra "Reiniciando a VM…".
			let session;
			try {
				session = await createSandboxSession(active?.conversationId);
			} catch (firstError) {
				console.warn("sandbox start retrying after failure", firstError);
				setSandboxRestarting(true);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				session = await createSandboxSession(active?.conversationId);
			}
			rememberSandbox(active?.conversationId, {
				sessionId: session.sessionId,
				viewerUrl: session.viewerUrl,
			});
			setSandboxViewerOpen(true);
			setPanelOpen(true);
		} catch (error) {
			console.error("sandbox start failed", error);
			setSandboxError("A VM não quis ligar agora. Já tentei algumas vezes sozinho; tente de novo em instantes.");
		} finally {
			setSandboxRestarting(false);
			setSandboxBusy(false);
		}
	}

	return (
		<TooltipProvider>
			<SidebarProvider
				className="h-dvh overflow-hidden"
				defaultOpen
				style={
					{
						"--sidebar-width": "20rem",
						"--sidebar-width-icon": "4.5rem",
					} as CSSProperties
				}
			>
				{!mobileConversationOpen && !marketplaceOpen && !sendersOpen ? (
					<MobileChatList
						agents={visibleAgents}
						sections={sections}
						loading={loadingBots}
						loadError={listLoadError}
						onRetryLoad={retryLoadBots}
						onSelect={(id) => {
							setActiveId(id);
							setNaming(false);
							setMobileConversationOpen(true);
						}}
						onStartCreate={() => {
							setNaming(true);
							setMobileConversationOpen(true);
						}}
						onStartCreateGroup={() => {
							setGroupCreating(true);
							setMobileConversationOpen(true);
						}}
						onOpenMarketplace={() => openMarketplacePage()}
						onOpenSettings={() => openSettingsModal()}
						onOpenProviders={() => openSettingsModal("provedores")}
						onOpenAutonomy={() => openSettingsModal("bots")}
						onOpenWork={(item) => openActiveWork(item, true)}
						menuActions={{
							onEdit: (id) => {
								editAgent(id);
								setNaming(false);
								setMobileConversationOpen(true);
							},
							onPin: pinAgent,
							onUnpin: unpinAgent,
							onMarkUnread: markAgentUnread,
							onHide: hideAgent,
							onDelete: requestDeleteAgent,
							onMoveToSection: moveToSection,
							onCreateSectionFor: (id) => {
								void createSectionAndMove(id);
							},
							...primaryMenuActions,
						}}
						sectionActions={{
							onRenameSection: (id, name) => {
								void renameSection(id, name);
							},
							onDeleteSection: (id) => {
								void deleteSectionById(id);
							},
							onMoveSection: (id, direction) => {
								void moveSection(id, direction);
							},
						}}
					/>
				) : null}
				<ChatSidebar
					activeId={activeId}
					agents={visibleAgents}
					loading={loadingBots}
					loadError={listLoadError}
					onRetryLoad={retryLoadBots}
					menuActions={{
						onEdit: editAgent,
						onPin: pinAgent,
						onUnpin: unpinAgent,
						onMarkUnread: markAgentUnread,
						onHide: hideAgent,
						onDelete: requestDeleteAgent,
						onMoveToSection: moveToSection,
						onCreateSectionFor: (id) => {
							void createSectionAndMove(id);
						},
						...primaryMenuActions,
					}}
					sections={sections}
					sectionActions={{
						onRenameSection: (id, name) => {
							void renameSection(id, name);
						},
						onDeleteSection: (id) => {
							void deleteSectionById(id);
						},
						onMoveSection: (id, direction) => {
							void moveSection(id, direction);
						},
					}}
					onOpenMarketplace={() => openMarketplacePage()}
					onOpenSettings={() => openSettingsModal()}
					onOpenAutonomy={() => openSettingsModal("bots")}
					onPlacePinned={placePinned}
					onSelect={setActiveId}
					onOpenWork={(item) => openActiveWork(item)}
					onStartCreate={() => setNaming(true)}
					onStartCreateGroup={() => setGroupCreating(true)}
					onUnpin={unpinAgent}
				/>
				<SidebarInset
					className={
						marketplaceOpen || sendersOpen
							? "hidden"
							: mobileConversationOpen
								? "relative flex min-h-0 min-w-0 flex-row"
								: "relative hidden min-h-0 min-w-0 flex-row md:flex"
					}
					style={botAccentStyle(active?.color) as CSSProperties}
				>
					{groupCreating ? (
						<NewChatTo
							agents={visibleAgents}
							initialGroupMode={groupInitialMode}
							onCancel={() => {
								setGroupCreating(false);
								setMobileConversationOpen(false);
							}}
							onNewBot={() => {
								setGroupCreating(false);
								setNaming(true);
							}}
							onOpenBot={(id) => {
								setGroupCreating(false);
								setActiveId(id);
								setNaming(false);
								setMobileConversationOpen(true);
							}}
							onSend={createGroup}
						/>
					) : null}
					{naming && isMobile ? (
						<MobileCreateBot
							onCancel={() => {
								createAsPrimaryRef.current = false;
								setNaming(false);
								setMobileConversationOpen(false);
							}}
							onCreate={createBot}
						/>
					) : null}
					{exchange && active && exchangePeer ? (
						<BotExchangeScreen
							focusKey={exchange.focusKey}
							onBack={() => setExchange(null)}
							onOpenPeer={() => {
								const previous = activeIdRef.current;
								if (previous && previous !== exchangePeer.id) void flushConfigClose(previous);
								setExchange(null);
								setActiveId(exchangePeer.id);
								setNaming(false);
							}}
							peer={{ id: exchangePeer.id, name: exchangePeer.name, color: exchangePeer.color, shape: exchangePeer.shape }}
							self={{ id: active.id, name: active.name, color: active.color, shape: active.shape }}
						/>
					) : null}
					<ChatThread
						className={exchange && exchangePeer ? "hidden" : naming && isMobile ? "hidden md:flex" : groupCreating ? "hidden" : undefined}
						onOpenExchange={(peerId, focusKey) => setExchange({ peerId, focusKey })}
						onBack={() => {
							setMobileConversationOpen(false);
							setNaming(false);
						}}
						agent={active}
						agents={agents}
						unreadAnchorId={unreadAnchor && unreadAnchor.conversationId === active?.conversationId ? unreadAnchor.messageId : null}
						unreadAnchorReady={!active?.conversationId || Boolean(unreadAnchor && unreadAnchor.conversationId === active.conversationId && unreadAnchor.ready)}
						onMarkRead={markActiveRead}
						bootstrapping={loadingBots}
						composerInputRef={composerRef}
						naming={naming && !isMobile}
						onCancelCreate={() => {
							createAsPrimaryRef.current = false;
							setNaming(false);
						}}
						onCreateBot={createBot}
						onAgentPointer={(event) =>
							setAgentPointer((previous) => reduceAgentPointer(previous, event))
						}
						onSandboxSession={(session) => {
							followRunSandbox(active?.conversationId, session);
							// Não abre o modal sozinho: o preview fica no painel
							// lateral e o usuário abre quando quiser.
						}}
						onAgentModelChange={(model) => {
							persistAgentModelNow(model);
						}}
						onBotProfileApplied={(botId, patch) => {
							applyBotProfilePatch(botId, patch);
						}}
						onLatestMessageChange={updateLatestMessage}
						onOpenSettings={openSettings}
						onOpenRoutine={openRoutineFromChat}
						onBotCreated={addBotsFromServer}
						onRoutineEvent={(event) => {
							if (
								(event.action === "created" || event.action === "updated") &&
								activeId
							) {
								void reloadBotRoutines(activeId)
									.then((records) => {
										// Painel aberto na mesma rotina que o agente acabou de
										// editar: repõe o valor fresco do servidor (side panel
										// não fica preso na cópia de antes do reload).
										setEditingRoutine((current) => {
											if (!current) return current;
											const fresh = records.find(
												(row) => row.id === current.id,
											);
											if (!fresh) return current;
											const ui = recordToUiRoutine(fresh);
											return {
												...ui,
												model: ui.model?.trim() || current.model,
											};
										});
									})
									.catch((error) =>
										console.error(
											"reload routines after SSE event failed",
											error,
										),
									);
							}
						}}
						onStartCreate={() => setNaming(true)}
						onSelectAgent={(id) => {
							const previous = activeIdRef.current;
							if (previous && previous !== id) void flushConfigClose(previous);
							setActiveId(id);
							setNaming(false);
						}}
						onTogglePanel={() => {
							if (panelOpen) {
								closePanel();
							} else {
								setPanelOpen(true);
							}
						}}
						panelOpen={panelOpen}
						prefill={composerPrefill}
						onOpenSandboxViewerForLogin={openSandboxViewerForLogin}
						sandboxSessionId={sandboxSessionId}
						sandboxViewerUrl={sandboxViewerUrl}
					/>
					{active ? (
						<ChatContextPanel
							agent={active}
							agentPointer={agentPointer}
							editingRoutine={editingRoutine}
							initialWidth={initialPanelWidth}
							onClosePanel={closePanel}
							onOpenPanel={() => setPanelOpen(true)}
							onCloseView={closeSettingsView}
							onDescribeRoutineInChat={() => {
								prefillComposer("Crie uma rotina que ");
							}}
							onCreateRoutineTemplate={(template, fields) =>
								createRoutineFromChooser(template, fields)
							}
							onCreateScheduledRoutine={openNewScheduledRoutineDraft}
							onCreateWebhookRoutine={openNewWebhookRoutineDraft}
							onEditRoutineWithAgent={editRoutineWithAgent}
							defaultRoutineModel={
								active.openRouterModel?.trim() || DEFAULT_OPENROUTER_MODEL
							}
							onOpenSandboxViewer={() => setSandboxViewerOpen(true)}
							onCreateRoutine={createRoutine}
							onSaveRoutine={saveRoutine}
							onToggleRoutine={toggleRoutine}
							isRoutinePersisted={(routine) =>
								persistedRoutineIds.current.has(routine.id)
							}
							onSaveGithubTrigger={saveGithubTrigger}
							onDeleteRoutine={(routine) => {
								void deleteRoutineFor(routine);
							}}
							routineGroups={routineGroups}
							onCreateRoutineGroup={createRoutineGroupFor}
							onRenameRoutineGroup={renameRoutineGroupFor}
							onSetRoutineGroupEnabled={setRoutineGroupEnabledFor}
							onDeleteRoutineGroup={deleteRoutineGroupFor}
							onRunRoutine={(routine) => runRoutineFor(routine)}
							onRotateRoutineSecret={(routine) => rotateRoutineSecretFor(routine)}
							onOpenSettings={openSettings}
							routineOneTimeSecret={routineOneTimeSecret}
							onOpenMarketplace={() => openMarketplacePage()}
							onStartSandbox={() => {
								void startSandbox();
							}}
							onUpdate={updateAgent}
							group={
								active.members?.length
									? {
											members: resolveGroupMembers(active, agents),
											candidates: groupCandidates(agents).filter((candidate) => !active.members?.includes(candidate.id)),
											onRename: (name) => patchGroup(active.id, { name }),
											onOpenMember: (botId) => {
												setActiveId(botId);
												setNaming(false);
											},
											onAddMember: (botId) => changeGroupMember(active.id, botId, "add"),
											onRemoveMember: (botId) => changeGroupMember(active.id, botId, "remove"),
											onDelete: () => requestDeleteAgent(active.id),
											error: groupPanelError,
										}
									: undefined
							}
							open={panelOpen && !groupCreating}
							routines={routines}
							routineRuns={botRoutineRuns}
							routinePersisted={Boolean(
								editingRoutine &&
								persistedRoutineIds.current.has(editingRoutine.id),
							)}
							sandboxBusy={sandboxBusy}
							sandboxError={sandboxError}
							sandboxRestarting={sandboxRestarting}
							sandboxSessionId={sandboxSessionId}
							sandboxViewerUrl={sandboxViewerUrl}
							view={panelView}
						/>
					) : null}
					{sandboxViewerUrl && sandboxViewerOpen ? (
						<SandboxViewerDialog
							agentPointer={agentPointer}
							botColor={active?.color}
							botName={active?.name ?? "bot"}
							onClose={closeSandboxViewer}
							onFinish={
								sandboxViewerFinish
									? () => {
											const finish = sandboxViewerFinish;
											closeSandboxViewer();
											finish();
										}
									: undefined
							}
							onReload={() => setSandboxViewerReload((value) => value + 1)}
							reloadKey={sandboxViewerReload}
							viewerUrl={sandboxViewerUrl}
						/>
					) : null}
				</SidebarInset>
				{sendersBotId && !marketplaceOpen ? <AllowedSendersPage botId={sendersBotId} /> : null}
				{marketplaceOpen ? (
					<MarketplacePage
						customDraft={customMcpDraft}
						onBotInstalled={addBotsFromServer}
						onCustomDraftConsumed={() => setCustomMcpDraft(null)}
						onManageAutonomy={(connector) => setAutonomyDialog({ open: true, connector })}
						onOpenBot={(botId) => {
							addBotsFromServer();
							closeMarketplacePage();
							setActiveId(botId);
							setNaming(false);
							setMobileConversationOpen(true);
						}}
					/>
				) : null}
				<Suspense fallback={null}>
					<LazySettingsDialog
						onShortcut={(id) => {
							// Atalhos das Configurações levam à aba certa do Marketplace; "MCP personalizado" abre o formulário vazio.
							if (id === "mcp") {
								setCustomMcpDraft({ name: "", url: "", auth: "oauth" });
								openMarketplacePage({ section: "conectores", item: "custom" });
							} else if (id === "apps") openMarketplacePage({ section: "apps" });
							else openMarketplacePage({ section: "conectores" });
						}}
					/>
				</Suspense>
				{autonomyEverOpened || autonomyDialog.open ? (
					<AutonomyDialog
						connectorFilter={autonomyDialog.connector}
						onOpenChange={(open) =>
							setAutonomyDialog((previous) => ({ ...previous, open }))
						}
						open={autonomyDialog.open}
					/>
				) : null}
				<PrimaryBotIntroDialog
					agents={agents}
					onChoose={(id) => setPrimaryBot(id)}
					onCreate={startCreatePrimaryBot}
					onDismiss={dismissPrimaryIntro}
					open={showPrimaryIntro}
				/>
				<PrimaryBotPickerDialog
					agents={agents}
					onChoose={(id) => setPrimaryBot(id)}
					onClose={() => setReplacePrimaryOpen(false)}
					open={replacePrimaryOpen}
				/>
				<AlertDialog
					onOpenChange={(open) => {
						if (!open) setDeleteTarget(null);
					}}
					open={deleteTarget !== null}
				>
					<AlertDialogContent size="sm">
						<AlertDialogHeader>
							<AlertDialogMedia className="bg-destructive/10 text-destructive dark:bg-destructive/20">
								<Trash2Icon />
							</AlertDialogMedia>
							<AlertDialogTitle>
								{deleteTarget?.members?.length ? "Excluir grupo" : "Excluir"} “{deleteTarget?.name}”?
							</AlertDialogTitle>
							<AlertDialogDescription>
								{deleteTarget?.members?.length
									? "Isso exclui permanentemente o grupo e seu histórico de chat. Os bots que fazem parte dele não são excluídos e continuam disponíveis individualmente. Essa ação não pode ser desfeita."
									: "O agente e o histórico da conversa serão apagados. Essa ação não pode ser desfeita."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={deleting}>
								Cancelar
							</AlertDialogCancel>
							<AlertDialogAction
								disabled={deleting}
								onClick={() => void confirmDeleteAgent()}
								variant="destructive"
							>
								{deleting ? "Excluindo…" : "Excluir"}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</SidebarProvider>
			{configNotice ? (
				<div
					role="status"
					aria-live="polite"
					className={cn(
						"pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border bg-popover px-3 py-1.5 text-xs shadow-md",
						configNotice.tone === "error"
							? "text-destructive"
							: "text-muted-foreground",
					)}
				>
					{configNotice.text}
				</div>
			) : null}
		</TooltipProvider>
	);
}
