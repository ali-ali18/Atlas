"use client";

import {
	ArrowLeftIcon,
	ChevronsLeftIcon,
	ChevronsRightIcon,
	PlusIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@workspace/ui/components/empty";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { cn } from "@workspace/ui/lib/utils";
import { buildTimeSeparators } from "@/lib/chat-time-separators";
import { exchangeFocusKey } from "@/lib/bot-exchange";
import { readBubbleBotColor } from "@/lib/bot-bubble";
import { planImageRuns, reuseImageRuns } from "@/lib/image-groups";
import { groupBotMessages, type BotPartner, type ThreadItem } from "@/lib/bot-thread";
// Módulos diretos (não o índice): o índice também exporta a tela da conversa entre bots, carregada sob demanda.
import type { BotRef } from "@/components/ai-elements/bot-messages/bot-chip";
import { BotAutoDecisionNote } from "@/components/ai-elements/bot-messages/bot-auto-decision-note";
import { BotLinkMarker } from "@/components/ai-elements/bot-messages/bot-link-marker";
import { BotNeedsUserCard } from "@/components/ai-elements/bot-messages/bot-needs-user-card";
import { BotThreadGroup } from "@/components/ai-elements/bot-messages/bot-thread-group";
import { pendingNeedsUser } from "@/lib/bot-needs-thread";
import { PLAN_ADJUST_DRAFT, botNeedsUserStatusLine, devApprovalRejectText } from "@workspace/shared";
import { beginCardDecision, cardDecisionKey, endCardDecision } from "@/lib/card-decision";
import { approvalMarkerFor, failedApprovalDetail, approvalShortLabel, isHiddenProtocolBubble, selectDockEntries } from "@/lib/approval-dock";
import { answerBotPending } from "@/lib/atlas-api";
import { ApprovalBar } from "./approval-bar";
import { keyReleasesFollow, stickAfterScroll, touchReleasesFollow, wheelReleasesFollow } from "@/lib/follow-bottom";
import { shouldKeepBottomOnResize } from "@/lib/keep-bottom-on-resize";
import { ApprovalMarker } from "./approval-marker";
import { needsBottomCorrection, transcriptBottomPadding } from "@/lib/scroll-bottom";
import { clearScrollToCard, pendingScrollCard, requestScrollToCard } from "@/lib/scroll-to-card";
import { AgentAvatar } from "../agent-avatar";
import { LiveAgentAvatar } from "../live-agent-avatar";
import { GroupAvatar, resolveGroupMembers } from "../group-avatar";
import { coordinationLabel, groupActivity, groupBubbleLayouts, groupRoutingLabel, orderMembers, typingLabel, withLiveAuthor } from "@/lib/group-thread";
import { GroupAssistantRow } from "./group-message";

import { isLiveStreamingBubble, type AgentPointerEvent } from "@workspace/shared";

import { useAtlasChat } from "@/hooks/use-atlas-chat";

import { type Agent, type Message, type MessageAuthor, type NewBotInput } from "../data";
import { AvatarStatus } from "../avatar-status";
import type { GroupPosition } from "./bubble-radius";
import { ChatComposer } from "./chat-composer";
import { CompactionNotice } from "./compaction-card";
import { CreateBotHeader } from "./create-bot-header";
import { MessageRow } from "./message-row";
import type { QuestionnaireAnswersMap, QuestionnaireCardMessage } from "./questionnaire-card";
import { ScrollToBottom } from "./scroll-to-bottom";
import { NewMessagesDivider } from "./new-messages-divider";
import { SourceMarker } from "./source-marker";
import { useMarkRead } from "@/hooks/use-mark-read";
import { useKnownSkillSlugs } from "@/hooks/use-known-skill-slugs";
import { useMentionApps } from "@/hooks/use-mention-apps";
import { useViewingHeartbeat } from "@/hooks/use-viewing-heartbeat";
import { useWindowAttention } from "@/hooks/use-window-attention";
import { messageBefore, newMessagesSince, previewWithSource, sourceMarkerIds } from "@/lib/unread";
import { LANDING_LOCK_MS, decideLanding, landingScrollTop, resolveDividerAnchor, resumeAnchorId, shouldReanchor } from "@/lib/thread-position";
import {
	submitQuestionnaire,
	resolveBotProfileProposal,
	resolveRoutineProposal,
	resolveBotProposal,
	resolveSkillProposal,
} from "@/lib/atlas-api";
import { hasModelTiers, readBotModelTiers, readProactiveSettings } from "@workspace/shared";
import { openSkillProposalInEditor, proposalErrorMessage } from "@/components/ai-elements/skills";
import { useDevFixtureWorking } from "@/lib/dev-session/fixture";
import { onChatMessageRequest } from "@/lib/dev-session/chat-send-request";
import { setBotWorking } from "@/lib/bot-activity";
import { emitSkillProposalResolved } from "@/lib/skill-draft-handoff";
import { ThreadSkeleton } from "./thread-skeleton";
import { useStableHandlers, useStructuralMemo } from "./stable-handlers";
import { createPreviewReporter } from "@/lib/preview-throttle";
import { createFrameCoalescer } from "@/lib/frame-coalescer";
import type { OpenRoutinePayload } from "@/components/ai-elements/routines";

/** Última mensagem que satisfaz o filtro, sem copiar e inverter a lista. */
function lastMessageWhere<T extends Message>(messages: readonly Message[], match: (message: Message) => message is T): T | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (match(message)) return message;
	}
	return undefined;
}

function itemKind(item: ThreadItem | undefined): Message["kind"] | null {
	return item?.type === "message" ? item.message.kind : null;
}

function groupPositionFor(
	items: ThreadItem[],
	index: number,
	separators: ReadonlyMap<string, string>,
): GroupPosition {
	const kind = itemKind(items[index]);
	if (kind !== "assistant" && kind !== "user") return "single";
	// Um separador de horário quebra o grupo de balões.
	const prevSame =
		itemKind(items[index - 1]) === kind && !separators.has(items[index]!.id);
	const nextSame =
		itemKind(items[index + 1]) === kind && !separators.has(items[index + 1]!.id);
	if (!prevSame && !nextSame) return "single";
	if (!prevSame) return "first";
	if (!nextSame) return "last";
	return "middle";
}
import { WorkingIndicator } from "./working-indicator";

export function ChatThread({
	agent,
	agents,
	bootstrapping = false,
	className,
	composerInputRef,
	naming = false,
	onCancelCreate,
	onCreateBot,
	onOpenSettings,
	onBack,
	onAgentModelChange,
	onBotProfileApplied,
	onLatestMessageChange,
	onSandboxSession,
	onAgentPointer,
	onStartCreate,
	onSelectAgent,
	onOpenExchange,
	onTogglePanel,
	onOpenRoutine,
	onRoutineEvent,
	onBotCreated,
	unreadAnchorId = null,
	unreadAnchorReady = true,
	onMarkRead,
	panelOpen = true,
	prefill,
	onOpenSandboxViewerForLogin,
	sandboxSessionId,
	sandboxViewerUrl,
}: {
	agent?: Agent;
	agents?: Agent[];
	bootstrapping?: boolean;
	className?: string;
	composerInputRef?: React.Ref<HTMLTextAreaElement>;
	naming?: boolean;
	onCancelCreate?: () => void;
	onCreateBot?: (input: NewBotInput) => void;
	onOpenSettings?: () => void;
	onBack?: () => void;
	onAgentModelChange?: (model: string) => void;
	onBotProfileApplied?: (
		botId: string,
		patch: {
			name?: string;
			snippet?: string;
			description?: string | null;
			openRouterModel?: string | null;
		},
	) => void;
	onLatestMessageChange?: (botId: string, text: string) => void;
	onSandboxSession?: (session: {
		sessionId: string;
		viewerUrl: string;
	}) => void;
	/** Cursor do agente no navegador do sandbox. */
	onAgentPointer?: (event: AgentPointerEvent) => void;
	onStartCreate?: () => void;
	/** Abre a conversa de outro bot (clique no avatar de uma mensagem entre bots). */
	onSelectAgent?: (botId: string) => void;
	/** Abre a conversa (somente leitura) entre este bot e outro; `focusKey` destaca uma fala. */
	onOpenExchange?: (peerBotId: string, focusKey: string | null) => void;
	onTogglePanel?: () => void;
	/** Primeira mensagem não lida ao abrir a conversa: a thread rola até ela e mostra "Novas mensagens". */
	unreadAnchorId?: string | null;
	/** O estado de leitura fresco já chegou: só então a conversa pousa (evita linha velha ou pouso duplo). */
	unreadAnchorReady?: boolean;
	/** A última mensagem foi vista de verdade (visível, aba em foco): marca a conversa como lida. */
	onMarkRead?: (messageId: string) => void;
	onOpenRoutine?: (payload: OpenRoutinePayload) => void;
	/** Abre a aba Memória do painel (chip "Memória atualizada · ver"; `changes` = direto no "O que mudou"). */
	/** SSE `routine` (agente criou/editou/listou uma rotina) — recarrega a lista no painel. */
	/** O card do bot criou um agente novo: a lista de conversas o inclui. */
	onBotCreated?: () => void;
	onRoutineEvent?: (event: {
		action: string;
		routineId?: string;
		title?: string;
		triggerType?: "cron" | "event" | "once" | "interval";
	}) => void;
	panelOpen?: boolean;
	/** Prefill do composer (ex.: "Editar com o agente") — {text, nonce} refoca/reseta a cada nonce novo. */
	prefill?: { text: string; nonce: number };
	sandboxSessionId?: string | null;
	/** Viewer noVNC da VM da conversa (botão "Abrir a VM" do card de login). */
	sandboxViewerUrl?: string | null;
	/** Abre a VM nesta mesma página, com o "Terminei" do login na própria tela. */
	onOpenSandboxViewerForLogin?: (onFinish: () => void) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [barHeight, setBarHeight] = useState(0);
	// "Ajustar" no cartão do plano: rascunho no composer. Um prefill novo vindo de fora passa na frente.
	const [adjustPrefill, setAdjustPrefill] = useState<{ text: string; nonce: number } | null>(null);
	useEffect(() => setAdjustPrefill(null), [prefill?.nonce]);
	// A barra só pode reagir ao observer depois da abertura na posição final (fim ou primeira não lida).
	const [opened, setOpened] = useState(false);
	// Cartões pendentes que a conversa já deixou para trás (fora da tela): só eles vão para a barra do composer.
	const [offscreen, setOffscreen] = useState<ReadonlySet<string>>(() => new Set());
	// Cartões de outro bot decididos daqui: saem do dock sem esperar o histórico recarregar.
	const [relayedDone, setRelayedDone] = useState<ReadonlySet<string>>(() => new Set());
	const pendingHistoryScrollRef = useRef<{
		height: number;
		top: number;
	} | null>(null);
	const historyRequestRef = useRef(false);
	const previewSourceRef = useRef<{
		key: string;
		staleMessages: Message[] | null;
	} | null>(null);
	// Prévia na lista de conversas: atualizar a lista re-renderiza o app inteiro, então durante o stream ela
	// sai no máximo uma vez por segundo (e na hora quando o run termina).
	const latestPreviewChangeRef = useRef(onLatestMessageChange);
	useEffect(() => {
		latestPreviewChangeRef.current = onLatestMessageChange;
	}, [onLatestMessageChange]);
	const [previewReporter] = useState(() =>
		createPreviewReporter({ report: (botId, text) => latestPreviewChangeRef.current?.(botId, text) }),
	);
	useEffect(() => () => previewReporter.cancel(), [previewReporter]);
	// "Grudado no fim?" — follow automático só quando o usuário já estava
	// no fim; nunca sequestra quem subiu para ler o histórico.
	const stickRef = useRef(true);
	// A área de rolagem só existe com agente: os ouvintes de rolagem precisam (re)ligar quando ela aparece,
	// senão ficam presos a um ref vazio e nada solta o acompanhamento.
	const hasThread = Boolean(agent);
	// Grupo: o hook fala com /v1/groups e o servidor escolhe quem responde.
	const isGroup = Boolean(agent?.members?.length);
	const {
		messages,
		hasMoreHistory,
		loadingOlder,
		loadOlderMessages,
		sending,
		loading,
		error,
		sendMessage,
		compact,
		compactState,
		setConfirmStatus,
		setLoginStatus,
		setQuestionnaireStatus,
		setBotProfileStatus,
		applySkillProposalState,
		applyRoutineProposalState,
		applyBotProposalState,
		cancelRun,
		resumeRun,
		model,
		setModel,
		runStatus,
		servedModel,
		activity,
		streamingMessageId,
		liveBotId,
		groupState,
		syncFromServer,
	} = useAtlasChat({
		agentId: agent?.id ?? "",
		groupId: isGroup ? agent?.id : undefined,
		conversationId: agent?.conversationId,
		// Bot com níveis próprios abre no Automático; sem eles, o modelo fixo do bot vale como sempre.
		agentModel: hasModelTiers(readBotModelTiers((agent as { policyJson?: unknown } | undefined)?.policyJson)) ? undefined : agent?.openRouterModel,
		sandboxSessionId,
		onSandboxSession,
		onAgentPointer,
		onRoutine: onRoutineEvent,
		// Bot principal com o modo proativo: o que ele escreve sozinho aparece sem recarregar.
		watchExternal: Boolean(agent?.isPrimary && !isGroup && readProactiveSettings((agent as { policyJson?: unknown } | undefined)?.policyJson).enabled),
	});
	// A lista de conversas (bolinha/última mensagem) é outra fonte do servidor: se mudou com a conversa aberta,
	// algo chegou (inclusive o fim de um run que este cliente não viu terminar). Busca o fim da conversa.
	const serverActivityKey = `${agent?.conversationId ?? ""}|${agent?.lastMessage ?? ""}|${agent?.unreadCount ?? 0}`;
	const seenActivityRef = useRef<string | null>(null);
	useEffect(() => {
		const previous = seenActivityRef.current;
		seenActivityRef.current = serverActivityKey;
		if (previous === null || previous === serverActivityKey || loading || !agent?.conversationId) return;
		if (previous.split("|")[0] !== serverActivityKey.split("|")[0]) return;
		void syncFromServer();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [serverActivityKey]);
	// Pedidos de outras partes da tela (painel da sessão: "Testar de novo") entram como mensagem do usuário.
	const sendMessageRef = useRef(sendMessage);
	sendMessageRef.current = sendMessage;
	// Uma passada por mudança da thread (antes eram duas por render: aqui e no dock).
	const allDockEntries = useMemo(() => selectDockEntries(messages), [messages]);
	const pendingCardKey = useMemo(() => allDockEntries.map((entry) => entry.id).join("|"), [allDockEntries]);
	useEffect(() => {
		const root = scrollRef.current;
		if (!root || !opened || !pendingCardKey || typeof IntersectionObserver === "undefined") {
			setOffscreen((current) => (current.size ? new Set() : current));
			return;
		}
		const ids = pendingCardKey.split("|");
		const visible = new Map<string, boolean>();
		const observer = new IntersectionObserver(
			(records) => {
				for (const record of records) visible.set(record.target.getAttribute("data-approval-card") ?? "", record.isIntersecting);
				const next = new Set(ids.filter((id) => visible.get(id) === false));
				setOffscreen((current) => (current.size === next.size && [...next].every((id) => current.has(id)) ? current : next));
			},
			{ root },
		);
		for (const id of ids) {
			const element = [...root.querySelectorAll<HTMLElement>("[data-approval-card]")].find((node) => node.getAttribute("data-approval-card") === id);
			if (element) observer.observe(element);
		}
		return () => observer.disconnect();
		// Só a lista de cartões pendentes (ids) importa: refazer o observer a cada token custava uma busca no DOM.
	}, [pendingCardKey, opened]);
	useEffect(
		() =>
			isGroup
				? undefined
				: onChatMessageRequest((text) => {
						stickRef.current = true;
						void sendMessageRef.current(text);
					}),
		[isGroup],
	);
	// Listas derivadas de `agents` mantêm a referência enquanto o conteúdo não muda: a lista de conversas
	// muda por qualquer prévia ou não lida, e uma referência nova redesenharia todas as linhas memoizadas.
	const skillBots = useStructuralMemo(useMemo(
		() => (agents ?? (agent ? [agent] : [])).map((item) => ({ id: item.id, name: item.name })),
		[agents, agent],
	));
	// Membros do grupo (principal primeiro): autocompletar, chips de menção e autoria dos balões.
	const groupMembers = useMemo(
		() => (agent && isGroup ? orderMembers(resolveGroupMembers(agent, agents ?? [])) : []),
		[agent, agents, isGroup],
	);
	const mentionMembers = useStructuralMemo(useMemo(
		() =>
			groupMembers.map((member) => ({
				id: member.id,
				name: member.name,
				color: member.color,
				shape: member.shape,
				description: member.description ?? member.snippet,
				isPrimary: member.isPrimary,
			})),
		[groupMembers],
	));
	// Chat 1:1: os outros bots (sem grupos nem o atual) que o `@` oferece, e as skills que o `/` reconhece nos balões.
	const otherBots = useMemo(
		() =>
			agent && !isGroup
				? (agents ?? [])
						.filter((item) => item.id !== agent.id && !item.members?.length)
						.map((item) => ({
							id: item.id,
							name: item.name,
							color: item.color,
							shape: item.shape,
							description: item.description ?? item.snippet,
						}))
				: [],
		[agent, agents, isGroup],
	);
	const knownSkills = useKnownSkillSlugs(Boolean(agent) && !isGroup);
	// Apps só carregam (uma vez por sessão) quando alguma fala do usuário tem "@": para desenhar o chip.
	const hasAtMention = useMemo(() => messages.some((item) => item.kind === "user" && item.text.includes("@")), [messages]);
	const mentionApps = useMentionApps(!isGroup && hasAtMention);
	const bubbleMembers = useStructuralMemo(useMemo(
		() => [
			...otherBots,
			...(mentionApps ?? []).map((app) => ({ id: app.id, name: app.name, kind: "app" as const, logo: app.logo })),
		],
		[otherBots, mentionApps],
	));
	const stampedAuthorsRef = useRef<{ groupId: string | undefined; map: Map<string, MessageAuthor> }>({ groupId: undefined, map: new Map() });
	const liveMember = isGroup && liveBotId ? groupMembers.find((member) => member.id === liveBotId) : undefined;
	// Gate humano da skill: trava o card, chama o resolve e mostra o estado final (ou o erro em pt-BR).
	async function decideSkillProposal(
		card: Extract<Message, { kind: "skill-proposal" }>,
		decision: "approved" | "rejected",
	) {
		const conversationId = agent?.conversationId;
		const proposalId = card.proposal.proposalId;
		if (!conversationId || card.isApplying) return;
		applySkillProposalState(proposalId, "applying");
		try {
			await resolveSkillProposal({ conversationId, proposalId, decision });
			applySkillProposalState(proposalId, decision);
			emitSkillProposalResolved({ proposalId, status: decision });
		} catch (cause) {
			applySkillProposalState(proposalId, { error: proposalErrorMessage(cause) });
		}
	}
	// Novo agente proposto pelo bot: Criar agente / Agora não. Nada existe antes do OK; aprovar duas vezes devolve o mesmo resultado.
	async function decideBotProposal(
		card: Extract<Message, { kind: "bot-proposal" }>,
		decision: "approved" | "rejected",
		edits?: { name?: string; description?: string },
	) {
		const conversationId = agent?.conversationId;
		const proposalId = card.proposal.proposalId;
		if (!conversationId || card.isApplying) return;
		applyBotProposalState(proposalId, "applying");
		try {
			const result = await resolveBotProposal({ conversationId, proposalId, decision, ...(edits ? { edits } : {}) });
			applyBotProposalState(
				proposalId,
				{ status: result.status, botId: result.botId, ...(edits ?? {}) },
				result.confirmation,
			);
			if (result.status === "approved" && !result.unchanged) onBotCreated?.();
		} catch (cause) {
			const status = typeof cause === "object" && cause !== null && "status" in cause ? Number(cause.status) : 0;
			applyBotProposalState(proposalId, {
				error: status === 404 ? "Esta proposta não existe mais." : status === 409 ? "Esta proposta já foi recusada." : "Não consegui criar o agente. Tente de novo.",
			});
		}
	}
	// Rotina proposta pelo bot: Criar/Manter e Agora não/Desfazer. Trava o card, chama a API e atualiza a lista de rotinas.
	async function decideRoutineProposal(
		card: Extract<Message, { kind: "routine-proposal" }>,
		decision: "accept" | "decline",
	) {
		if (card.isApplying) return;
		applyRoutineProposalState(card.id, "applying");
		try {
			const result = await resolveRoutineProposal({ messageId: card.id, decision });
			applyRoutineProposalState(card.id, { status: result.status === "pending" ? card.status : result.status });
			onRoutineEvent?.({ action: "updated", routineId: result.routineId ?? card.routineId });
		} catch (cause) {
			const status = typeof cause === "object" && cause !== null && "status" in cause ? Number(cause.status) : 0;
			applyRoutineProposalState(card.id, {
				error: status === 404 ? "Esta sugestão não existe mais." : "Não consegui concluir. Tente de novo.",
			});
		}
	}
	// Sinal "trabalhando" para os avatares vivos da sidebar e do painel.
	const botId = agent?.id;
	const devFixtureWorking = useDevFixtureWorking();
	const runningForAvatar = sending || runStatus === "paused" || runStatus === "pausing";
	useEffect(() => {
		if (!botId) return;
		setBotWorking(botId, runningForAvatar);
		return () => setBotWorking(botId, false);
	}, [botId, runningForAvatar]);
	// Grupo: quem trabalha é o membro dono do run em andamento.
	const liveMemberId = liveMember?.id;
	useEffect(() => {
		if (!liveMemberId) return;
		setBotWorking(liveMemberId, runningForAvatar);
		return () => setBotWorking(liveMemberId, false);
	}, [liveMemberId, runningForAvatar]);

	useEffect(() => {
		if (!agent || !onLatestMessageChange) return;
		const key = `${agent.id}:${agent.conversationId ?? ""}`;
		if (previewSourceRef.current?.key !== key) {
			const switchingConversation = previewSourceRef.current !== null;
			previewSourceRef.current = {
				key,
				staleMessages: switchingConversation ? messages : null,
			};
			if (switchingConversation) return;
		}
		const source = previewSourceRef.current;
		if (source?.staleMessages === messages) return;
		if (source) source.staleMessages = null;
		let text = "";
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.kind !== "user" && message?.kind !== "assistant") continue;
			text = message.text.trim();
			if (text) {
				if (message.kind === "assistant") text = previewWithSource(text, message.runSource);
				break;
			}
		}
		if (!text) return;
		previewReporter.update(key, agent.id, text, sending);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agent?.id, agent?.conversationId, messages, sending, Boolean(onLatestMessageChange), previewReporter]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		// Acompanhar o fim só enquanto a pessoa está de fato no fim. Qualquer sinal de que ela subiu (roda, dedo,
		// teclado, scrollTop que diminuiu sem a gente) solta na hora; só ela volta (chegando ao fim, seta, envio).
		let previousTop = element.scrollTop;
		let touchY = 0;
		const release = () => {
			stickRef.current = false;
		};
		const onScroll = () => {
			const top = element.scrollTop;
			stickRef.current = stickAfterScroll({
				stuck: stickRef.current,
				previousTop,
				top,
				distance: element.scrollHeight - top - element.clientHeight,
			});
			previousTop = top;
		};
		const onWheel = (event: WheelEvent) => {
			if (wheelReleasesFollow(event.deltaY)) release();
		};
		const onTouchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY ?? 0;
		};
		const onTouchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY ?? touchY;
			if (touchReleasesFollow(touchY, y)) release();
			touchY = y;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (keyReleasesFollow(event.key)) release();
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		element.addEventListener("wheel", onWheel, { passive: true });
		element.addEventListener("touchstart", onTouchStart, { passive: true });
		element.addEventListener("touchmove", onTouchMove, { passive: true });
		element.addEventListener("keydown", onKeyDown);
		return () => {
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("touchstart", onTouchStart);
			element.removeEventListener("touchmove", onTouchMove);
			element.removeEventListener("keydown", onKeyDown);
		};
	}, [hasThread]);

	// Teclado do celular abre/fecha: a área da conversa muda de altura; quem estava no fim continua vendo a
	// última mensagem (síncrono, antes do paint, sem salto). Cobre também o visualViewport (navegadores que
	// não redimensionam o layout com o teclado).
	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		let previousHeight = element.clientHeight;
		const onResize = () => {
			const nextHeight = element.clientHeight;
			if (shouldKeepBottomOnResize({ previousHeight, nextHeight, wasStuck: stickRef.current })) {
				element.scrollTop = element.scrollHeight;
			}
			previousHeight = nextHeight;
		};
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
		observer?.observe(element);
		const viewport = window.visualViewport;
		viewport?.addEventListener("resize", onResize);
		return () => {
			observer?.disconnect();
			viewport?.removeEventListener("resize", onResize);
		};
	}, [hasThread]);

	useLayoutEffect(() => {
		const pending = pendingHistoryScrollRef.current;
		const element = scrollRef.current;
		if (!pending || !element || loadingOlder) return;
		element.scrollTop = pending.top + element.scrollHeight - pending.height;
		pendingHistoryScrollRef.current = null;
		historyRequestRef.current = false;
	}, [messages, loadingOlder]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element || !hasMoreHistory || loading) return;
		const onScroll = () => {
			if (element.scrollTop > 120 || historyRequestRef.current) return;
			historyRequestRef.current = true;
			pendingHistoryScrollRef.current = {
				height: element.scrollHeight,
				top: element.scrollTop,
			};
			void loadOlderMessages().finally(() => {
				requestAnimationFrame(() => {
					const pending = pendingHistoryScrollRef.current;
					if (pending) {
						element.scrollTop =
							pending.top + element.scrollHeight - pending.height;
						pendingHistoryScrollRef.current = null;
					}
					historyRequestRef.current = false;
				});
			});
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		// Conversas curtas podem não criar barra de rolagem; carregue até haver conteúdo para rolar.
		if (element.scrollHeight <= element.clientHeight + 40) onScroll();
		return () => element.removeEventListener("scroll", onScroll);
	}, [hasMoreHistory, loading, loadOlderMessages, messages.length]);

	useEffect(() => {
		pendingHistoryScrollRef.current = null;
		historyRequestRef.current = false;
	}, [agent?.conversationId]);

	// Subagentes rodando aparecem no WorkingIndicator, não como bloco na lista.
	const activeSubagents = useMemo(
		() =>
			sending
				? lastMessageWhere(
						messages,
						(message): message is Extract<Message, { kind: "subagents" }> =>
							message.kind === "subagents" && message.tasks.some((task) => task.status === "running"),
					)
				: undefined,
		[messages, sending],
	);
	// Autor das falas ainda sem autor gravado: fixado na primeira vez (por grupo), nunca segue o membro ativo.
	if (stampedAuthorsRef.current.groupId !== agent?.id) stampedAuthorsRef.current = { groupId: agent?.id, map: new Map() };
	const stampedAuthors = stampedAuthorsRef.current.map;
	const liveAuthorId = liveMember?.id;
	const liveAuthorName = liveMember?.name;
	const visibleMessages = useMemo(
		() =>
			(isGroup
				? withLiveAuthor(messages, liveAuthorId && liveAuthorName ? { id: liveAuthorId, name: liveAuthorName } : null, stampedAuthors)
				: messages
			).filter(
				(message) =>
					message.kind !== "tool" &&
					!isHiddenProtocolBubble(message) &&
					!(message.kind === "assistant" && message.text.trim().length === 0),
			),
		[messages, isGroup, liveAuthorId, liveAuthorName, stampedAuthors],
	);
	// Conversa entre bots: o texto cru não vira balão (marcador ou linha "N mensagens com X").
	// Delegou e o outro bot parou esperando o usuário: a linha de status diz isso.
	const waitingOnBot = pendingNeedsUser(visibleMessages).at(-1) ?? null;
	// "Abrir conversa de X": rola até o card original assim que o fio do bot carregar.
	useEffect(() => {
		const cardId = pendingScrollCard();
		if (!cardId) return;
		const element = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${cardId}"]`);
		if (!element) return;
		clearScrollToCard();
		landingLockRef.current?.();
		const timer = window.setTimeout(() => {
			element.scrollIntoView({ block: "center", behavior: "smooth" });
			element.classList.add("rounded-2xl", "ring-2", "ring-ring/60");
			window.setTimeout(() => element.classList.remove("rounded-2xl", "ring-2", "ring-ring/60"), 2200);
		}, 120);
		return () => window.clearTimeout(timer);
	}, [messages, agent?.id]);

	const threadItems = useMemo(
		() => groupBotMessages(visibleMessages),
		[visibleMessages],
	);
	const timeSeparators = useMemo(
		() => buildTimeSeparators(threadItems),
		[threadItems],
	);
	// Imagens seguidas (ex.: screenshots) viram um só baralho; as demais mensagens da sequência somem.
	const previousImageRunsRef = useRef<ReturnType<typeof planImageRuns> | null>(null);
	const imageRuns = useMemo(() => reuseImageRuns(planImageRuns(threadItems, timeSeparators), previousImageRunsRef.current), [threadItems, timeSeparators]);
	useEffect(() => {
		previousImageRunsRef.current = imageRuns;
	}, [imageRuns]);
	// Balão do usuário na cor do bot: só no chat 1:1 e se a Config não desligou.
	const userBubbleColor = !isGroup && readBubbleBotColor((agent as { policyJson?: unknown } | undefined)?.policyJson) ? agent?.color : undefined;
	// Grupo: nome/avatar só no primeiro balão de cada trecho do mesmo membro.
	const groupLayouts = useMemo(
		() =>
			isGroup
				? groupBubbleLayouts(
						threadItems.flatMap((item) => (item.type === "message" ? [item.message] : [])),
						timeSeparators,
					)
				: null,
		[isGroup, threadItems, timeSeparators],
	);
	const resolveBot = (partner: BotPartner | { id?: string; name: string }): BotRef => {
		const known =
			(partner.id ? agents?.find((item) => item.id === partner.id) : undefined) ??
			agents?.find((item) => item.name === partner.name);
		return known
			? { id: known.id, name: known.name, color: known.color, shape: known.shape }
			: { name: partner.name };
	};
	// Só abre a conversa entre bots se o outro bot ainda existe.
	const openExchange = (
		partner: BotPartner | { id?: string; name: string },
		botMessageId: string | undefined,
		kind: "request" | "reply" | "answer" | "sent",
	): (() => void) | undefined => {
		const peerId = resolveBot(partner).id;
		if (!onOpenExchange || !peerId) return undefined;
		return () => onOpenExchange(peerId, exchangeFocusKey(botMessageId, kind));
	};

	const scrollToEnd = (immediate = false, done?: () => void) => {
		const element = scrollRef.current;
		if (!element) return;
		const jump = () => {
			// A pessoa pode ter subido nos dois quadros de espera: nada rola a conversa se ela soltou o fim.
			if (!stickRef.current) return;
			element.scrollTop = element.scrollHeight;
			done?.();
			// O layout ainda pode crescer (barra, markdown, fontes): confere uma vez mais e só corrige se ficou curto.
			requestAnimationFrame(() => {
				if (stickRef.current && needsBottomCorrection(element)) element.scrollTop = element.scrollHeight;
			});
		};
		if (immediate) {
			jump();
			return;
		}
		// rAF duplo: espera o layout assentar (markdown, fontes, imagens).
		requestAnimationFrame(() => requestAnimationFrame(jump));
	};

	// Enviar sempre leva ao fim e volta a acompanhar, mesmo de quem estava lendo mais acima.
	const sendFollowing = (...args: Parameters<typeof sendMessage>) => {
		stickRef.current = true;
		scrollToEnd();
		return sendMessage(...args);
	};

	// Pouso ao entrar: sem não lidas, no fim; com não lidas, na linha "Novas mensagens" (decideLanding).
	// Espera o estado de leitura fresco (unreadAnchorReady) e, depois de pousar, re-ancora enquanto o
	// layout assenta (histórico, markdown, imagens), até o primeiro toque do usuário na rolagem.
	const anchorRef = useRef(unreadAnchorId);
	anchorRef.current = unreadAnchorId;
	const landedRef = useRef<string | null>(null);
	const olderLoadsRef = useRef(0);
	const landingLockRef = useRef<(() => void) | null>(null);
	const landingConversationKey = agent?.conversationId ?? agent?.id ?? "";
	const [resumeAnchor, setResumeAnchor] = useState<{ key: string; id: string } | null>(null);
	const allMessageIds = useMemo(() => messages.map((message) => message.id), [messages]);
	const visibleMessageIds = useMemo(() => new Set(visibleMessages.map((message) => message.id)), [visibleMessages]);
	useEffect(() => {
		if (loading) {
			stickRef.current = true;
			setOpened(false);
			landedRef.current = null;
			olderLoadsRef.current = 0;
			landingLockRef.current?.();
			landingLockRef.current = null;
			return;
		}
		const element = scrollRef.current;
		if (!element || landedRef.current === landingConversationKey || !unreadAnchorReady || loadingOlder) return;
		const decision = decideLanding({
			anchorId: anchorRef.current,
			allIds: allMessageIds,
			visibleIds: visibleMessageIds,
			hasMoreHistory,
			olderLoads: olderLoadsRef.current,
		});
		if (decision.kind === "load-older") {
			olderLoadsRef.current += 1;
			void loadOlderMessages();
			return;
		}
		landedRef.current = landingConversationKey;
		stickRef.current = decision.kind === "bottom";
		const apply = () => {
			const divider =
				decision.kind === "divider"
					? (element.querySelector<HTMLElement>('[data-testid="new-messages-divider"]') ??
						element.querySelector<HTMLElement>(`[data-message-id="${decision.messageId}"]`))
					: null;
			const dividerTop = divider ? divider.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop : undefined;
			element.scrollTop = landingScrollTop({
				target: divider ? "divider" : "bottom",
				scrollHeight: element.scrollHeight,
				clientHeight: element.clientHeight,
				dividerTop,
			});
		};
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				if (landedRef.current !== landingConversationKey) return;
				apply();
				setOpened(true);
				const startedAt = Date.now();
				let interacted = false;
				const touch = () => {
					interacted = true;
				};
				const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
				for (const name of events) element.addEventListener(name, touch, { passive: true });
				const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
					if (shouldReanchor({ elapsedMs: Date.now() - startedAt, userInteracted: interacted })) apply();
				});
				for (const child of Array.from(element.children)) observer?.observe(child);
				const stop = window.setTimeout(() => landingLockRef.current?.(), LANDING_LOCK_MS);
				landingLockRef.current = () => {
					window.clearTimeout(stop);
					observer?.disconnect();
					for (const name of events) element.removeEventListener(name, touch);
					landingLockRef.current = null;
				};
			}),
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loading, landingConversationKey, unreadAnchorReady, unreadAnchorId, allMessageIds, loadingOlder, hasMoreHistory]);
	useEffect(() => () => landingLockRef.current?.(), []);

	// Linha "Novas mensagens": antes da primeira mensagem VISÍVEL não vista (a âncora do servidor pode estar escondida).
	const dividerAnchorId = useMemo(
		() =>
			resolveDividerAnchor(allMessageIds, visibleMessageIds, unreadAnchorId) ??
			(resumeAnchor && resumeAnchor.key === landingConversationKey && visibleMessageIds.has(resumeAnchor.id) ? resumeAnchor.id : null),
		[allMessageIds, visibleMessageIds, unreadAnchorId, resumeAnchor, landingConversationKey],
	);
	const dividerAnchorRef = useRef(dividerAnchorId);
	dividerAnchorRef.current = dividerAnchorId;

	// Voltou de segundo plano (ou de outra aba) com mensagens novas: marca onde começam, sem mexer na rolagem.
	const awayRef = useRef<{ tailId: string | null; hiddenAt: number; armedUntil: number } | null>(null);
	const visibleTailRef = useRef<string | null>(null);
	visibleTailRef.current = visibleMessages.at(-1)?.id ?? null;
	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				awayRef.current = { tailId: visibleTailRef.current, hiddenAt: Date.now(), armedUntil: 0 };
			} else if (awayRef.current && Date.now() - awayRef.current.hiddenAt >= 5000) {
				awayRef.current.armedUntil = Date.now() + 30_000;
			} else {
				awayRef.current = null;
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);
	const awayTail = visibleMessages.at(-1)?.id ?? null;
	useEffect(() => {
		const away = awayRef.current;
		if (!away || loading || !away.armedUntil || Date.now() > away.armedUntil) return;
		const id = resumeAnchorId(visibleMessages, away.tailId);
		if (!id) return;
		awayRef.current = null;
		setResumeAnchor((current) => (current && current.key === landingConversationKey ? current : { key: landingConversationKey, id }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [awayTail, loading]);

	// Mensagem nova no fim com o usuário já no fim: acompanha (e então conta como vista).
	const tailId = visibleMessages.at(-1)?.id ?? null;
	useEffect(() => {
		if (loading || sending || !stickRef.current) return;
		scrollToEnd();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tailId]);

	// Leitura: sentinela no fim da lista + aba visível/em foco -> marca como lida (debounce).
	const bottomRef = useRef<HTMLDivElement>(null);
	const [bottomVisible, setBottomVisible] = useState(false);
	useEffect(() => {
		const root = scrollRef.current;
		const sentinel = bottomRef.current;
		if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => setBottomVisible(entries.some((entry) => entry.isIntersecting)), { root, threshold: 0 });
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [loading, agent?.id]);
	const attentive = useWindowAttention();
	const conversationKey = agent?.conversationId ?? agent?.id ?? "";
	const openTailRef = useRef<{ key: string; id: string | null } | null>(null);
	if (openTailRef.current?.key !== conversationKey && !loading) openTailRef.current = { key: conversationKey, id: tailId };
	const tailMessage = visibleMessages.at(-1);
	// Qualquer coisa nova do bot (texto, cartão, evento de run) conta, não só balão de texto.
	const arrivedSinceOpen = Boolean(tailMessage && tailMessage.kind !== "user" && openTailRef.current?.id !== tailId);
	// A leitura vale até a mensagem mais nova da conversa, inclusive as escondidas (protocolo de cartão,
	// balão vazio, ferramenta): antes só a última VISÍVEL era enviada e as escondidas ficavam "não lidas".
	const readTailId = messages.at(-1)?.id ?? null;
	useViewingHeartbeat(agent?.conversationId, attentive && !loading);
	useMarkRead({
		conversationKey,
		bottomVisible,
		attentive: attentive && !loading && unreadAnchorReady,
		lastMessageId: readTailId,
		pending: Boolean(agent?.notifications) || arrivedSinceOpen,
		serverUnread: Boolean(agent?.notifications),
		onMarkRead,
	});
	// Pílula "↓ N novas": mensagens do assistente chegadas fora da tela.
	const [seenUpToId, setSeenUpToId] = useState<string | null>(null);
	const seenKeyRef = useRef("");
	useEffect(() => {
		if (loading || visibleMessages.length === 0) return;
		if (seenKeyRef.current !== conversationKey) {
			seenKeyRef.current = conversationKey;
			setSeenUpToId(messageBefore(visibleMessages, dividerAnchorRef.current));
			return;
		}
		if (bottomVisible) setSeenUpToId(tailId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loading, conversationKey, bottomVisible, tailId, visibleMessages.length]);
	const newCount = loading || seenKeyRef.current !== conversationKey ? 0 : newMessagesSince(visibleMessages, seenUpToId);
	const sourceIds = useMemo(() => sourceMarkerIds(visibleMessages), [visibleMessages]);

	// Durante o stream: acompanha só se o usuário já estava no fim. Uma rolagem por quadro, não por token: a
	// leitura do layout e a escrita do scrollTop acontecem uma vez, e só se o usuário continua no fim.
	const [streamFollow] = useState(() =>
		createFrameCoalescer(() => {
			const element = scrollRef.current;
			if (element && stickRef.current) element.scrollTop = element.scrollHeight;
		}),
	);
	useEffect(() => () => streamFollow.cancel(), [streamFollow]);
	useEffect(() => {
		if (!sending || !stickRef.current) return;
		streamFollow.request();
	}, [messages, sending, streamFollow]);
	// Fim do run: o layout ainda assenta (cursor some, markdown final); confere uma vez com a correção de sempre.
	const wasSendingRef = useRef(sending);
	useEffect(() => {
		const wasSending = wasSendingRef.current;
		wasSendingRef.current = sending;
		if (!wasSending || sending || !stickRef.current) return;
		scrollToEnd();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sending]);

	// Uma decisão por cartão: toque duplo, remontagem ou volta ao app não reenviam o mesmo "confirmado".
	const decideCard = (confirm: { id: string; confirmId?: string; status?: string }, status: "approved" | "rejected", text: string) => {
		if ((confirm.status ?? "pending") !== "pending") return;
		const key = cardDecisionKey(agent?.conversationId, confirm);
		if (!beginCardDecision(key)) return;
		setConfirmStatus(confirm.id, status);
		stickRef.current = true;
		void sendMessage(text, [], { confirmId: confirm.confirmId }).finally(() => endCardDecision(key));
	};
	// Handlers das linhas com identidade estável (chamam sempre a versão mais nova): sem isso cada render
	// criava ~20 funções novas por linha e o memo do MessageRow nunca acertava durante o stream.
	const rowHandlers = useStableHandlers({
		onOpenRoutine: (payload: OpenRoutinePayload) => onOpenRoutine?.(payload),
		onConfirm: (confirm: { id: string; confirmId?: string; title: string; status?: string }) => decideCard(confirm, "approved", `confirmado: ${confirm.title}`),
		onConfirmAlways: (confirm: { id: string; confirmId?: string; title: string; status?: string }) => decideCard(confirm, "approved", `confirmado sempre: ${confirm.title}`),
		onConfirmReject: (confirm: { id: string; confirmId?: string; status?: string }, feedback: string) => decideCard(confirm, "rejected", devApprovalRejectText(feedback)),
		onCancel: (confirm: { id: string; confirmId?: string; status?: string }) => decideCard(confirm, "rejected", "cancela isso"),
		onLoginOpenViewer: (login: Extract<Message, { kind: "login" }>) =>
			onOpenSandboxViewerForLogin?.(() => {
				setLoginStatus(login.id, "done");
				void resumeRun();
			}),
		onLoginUseVault: (login: Extract<Message, { kind: "login" }>) => {
			// "Entrar": o servidor marca o login do Cofre no checkpoint e o runtime preenche ao retomar.
			setLoginStatus(login.id, "done");
			void resumeRun({ via: "vault" });
		},
		onLoginCode: (login: Extract<Message, { kind: "login" }>, code: string) => {
			// O código vai direto ao servidor/runtime (selado), nunca ao modelo.
			setLoginStatus(login.id, "done");
			void resumeRun({ via: "code", code });
		},
		onLoginDone: (login: Extract<Message, { kind: "login" }>) => {
			// Retoma o mesmo run do checkpoint; o servidor marca o card como feito.
			setLoginStatus(login.id, "done");
			void resumeRun();
		},
		onAdjustPlan: () => setAdjustPrefill({ text: PLAN_ADJUST_DRAFT, nonce: Date.now() }),
		onBotProfileConfirm: (profile: Extract<Message, { kind: "bot-profile-confirm" }>) => {
			// Gate humano: otimista approved + resolve no servidor (aplica o PATCH no bot). Erro volta a pending.
			// Sem balão na thread.
			const proposalId = profile.proposal.proposalId;
			const conversationId = agent?.conversationId;
			if (!proposalId || !conversationId) return;
			setBotProfileStatus(profile.id, "approved");
			void resolveBotProfileProposal({ conversationId, proposalId, decision: "approved" })
				.then(() => {
					onBotProfileApplied?.(profile.proposal.botId, { ...profile.proposal.after });
				})
				.catch(() => setBotProfileStatus(profile.id, "pending"));
		},
		onBotProfileDismiss: (profile: Extract<Message, { kind: "bot-profile-confirm" }>) => {
			const proposalId = profile.proposal.proposalId;
			const conversationId = agent?.conversationId;
			setBotProfileStatus(profile.id, "rejected");
			if (!proposalId || !conversationId) return;
			void resolveBotProfileProposal({ conversationId, proposalId, decision: "rejected" }).catch(() =>
				setBotProfileStatus(profile.id, "pending"),
			);
		},
		onBotProposalApprove: (card: Extract<Message, { kind: "bot-proposal" }>, edits?: { name?: string; description?: string }) =>
			void decideBotProposal(card, "approved", edits),
		onBotProposalReject: (card: Extract<Message, { kind: "bot-proposal" }>) => void decideBotProposal(card, "rejected"),
		onRoutineProposalAccept: (card: Extract<Message, { kind: "routine-proposal" }>) => void decideRoutineProposal(card, "accept"),
		onRoutineProposalDecline: (card: Extract<Message, { kind: "routine-proposal" }>) => void decideRoutineProposal(card, "decline"),
		onSkillProposalApprove: (card: Extract<Message, { kind: "skill-proposal" }>) => void decideSkillProposal(card, "approved"),
		onSkillProposalReject: (card: Extract<Message, { kind: "skill-proposal" }>) => void decideSkillProposal(card, "rejected"),
		onSkillProposalEdit: (card: Extract<Message, { kind: "skill-proposal" }>) => {
			if (agent?.conversationId) openSkillProposalInEditor(card.proposal, agent.conversationId);
		},
		onQuestionnaireSubmit: (questionnaire: QuestionnaireCardMessage, answers: QuestionnaireAnswersMap) => {
			// Sem balão user: colapsa o card com as respostas e envia ao bot pelo endpoint silencioso (run sem
			// mensagem user na thread). Erro volta a pending.
			setQuestionnaireStatus(questionnaire.id, "submitted", answers);
			const conversationId = agent?.conversationId;
			if (!conversationId) return;
			void submitQuestionnaire({
				conversationId,
				questionnaireId: questionnaire.questionnaireId,
				botId: agent?.id,
				answers,
			}).catch(() => setQuestionnaireStatus(questionnaire.id, "pending"));
		},
		onQuestionnaireDismiss: (questionnaire: QuestionnaireCardMessage) => {
			// Dispensar não envia nada: só marca dismissed.
			setQuestionnaireStatus(questionnaire.id, "dismissed");
		},
	});

	const lastDevSessionId = useMemo(
		() => lastMessageWhere(messages, (message): message is Extract<Message, { kind: "devsession" }> => message.kind === "devsession")?.sessionId ?? null,
		[messages],
	);
	// O dock e a linha "Aguardando sua aprovação" leem a mesma lista: não há como um aparecer sem o outro.
	const dockEntries = useMemo(() => allDockEntries.filter((entry) => !relayedDone.has(entry.id)), [allDockEntries, relayedDone]);
	const dockIds = useMemo(() => new Set(dockEntries.map((entry) => entry.id)), [dockEntries]);
	const messageIndex = useMemo(() => new Map(messages.map((entry, position) => [entry.id, position] as const)), [messages]);

	if (!agent) {
		return (
			<div
				className={cn(
					"relative flex min-h-0 min-w-0 flex-1 flex-col",
					className,
				)}
			>
				{naming && onCancelCreate && onCreateBot ? (
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
						{onBack ? (
							<Button
								aria-label="Voltar para conversas"
								className="size-10 shrink-0 rounded-full md:hidden"
								onClick={onBack}
								size="icon"
								variant="ghost"
							>
								<ArrowLeftIcon className="size-5" />
							</Button>
						) : null}
						<CreateBotHeader
							onCancel={onCancelCreate}
							onCreate={onCreateBot}
						/>
					</header>
				) : null}

				{bootstrapping ? (
					<div className="min-h-0 flex-1 overflow-hidden">
						<ThreadSkeleton />
					</div>
				) : (
					<div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-12">
						<Empty className="border-0">
							<EmptyHeader>
								<EmptyMedia>
									<AgentAvatar
										bodyColor="#fafafa"
										size={72}
										mood={naming ? "curieux" : "confus"}
									/>
								</EmptyMedia>
								<EmptyTitle>
									{naming ? "Novo agente" : "Comece criando um agente"}
								</EmptyTitle>
							</EmptyHeader>
							<EmptyContent>
								<p className="text-sm text-muted-foreground">
									{naming
										? "Dê um nome ao seu agente e comece a conversar."
										: "Você ainda não tem agentes. Crie o primeiro para começar a conversar."}
								</p>
								{!naming && onStartCreate ? (
									<Button onClick={onStartCreate} size="sm">
										<PlusIcon />
										Criar agente
									</Button>
								) : null}
							</EmptyContent>
						</Empty>
					</div>
				)}
			</div>
		);
	}

	const pausedLike = runStatus === "paused" || runStatus === "pausing";
	const hasPendingApproval = dockEntries.length > 0;
	const barEntries = dockEntries.filter((entry) => offscreen.has(entry.id));
	const locateCard = (id: string) => {
		const element = [...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-approval-card]") ?? [])].find((node) => node.getAttribute("data-approval-card") === id);
		if (!element) return;
		element.scrollIntoView({ block: "center", behavior: "smooth" });
		element.classList.add("rounded-2xl", "ring-2", "ring-ring/60");
		window.setTimeout(() => element.classList.remove("rounded-2xl", "ring-2", "ring-ring/60"), 1800);
	};
	// Cartão repassado de outro bot: a barra responde o cartão original, como os botões do próprio cartão.
	const decideRelayed = (entry: { id: string; message: { need: { conversationId: string; cardId: string } } }, decision: "approve" | "reject") => {
		const key = `needs|${entry.message.need.conversationId}|${decision}`;
		if (!beginCardDecision(key)) return;
		void answerBotPending({ conversationId: entry.message.need.conversationId, cardId: entry.message.need.cardId, decision })
			.then(() => setRelayedDone((current) => new Set(current).add(entry.id)))
			.catch(() => undefined)
			.finally(() => endCardDecision(key));
	};
	const working = sending || pausedLike || devFixtureWorking;
	const runActive = sending || pausedLike;
	// Grupo, entre um run e outro: quem o servidor diz que está respondendo ou escolhendo.
	const groupRunning = isGroup && groupState ? groupActivity(groupState.replies, groupMembers) : { running: [], waiting: [] };
	const routingLabel = isGroup ? groupRoutingLabel(groupState) : "";
	const typingNames = groupRunning.running.length > 0 ? groupRunning.running : groupRunning.waiting.slice(0, 1);
	const coordinatingLabel = isGroup ? coordinationLabel(groupState, groupMembers) : "";
	const groupTyping = {
		names: coordinatingLabel ? [coordinatingLabel] : routingLabel && typingNames.length === 0 ? [routingLabel] : typingNames,
		agent: groupMembers.find((member) => member.name === typingNames[0]),
		label: coordinatingLabel || (routingLabel && typingNames.length === 0 ? routingLabel : typingLabel(typingNames)),
	};

	return (
		<div
			className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
		>
			<header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-2 bg-transparent px-3 md:h-12">
				{onBack ? (
					<Button
						aria-label="Voltar para conversas"
						className="pointer-events-auto size-11 shrink-0 rounded-full bg-card hover:bg-card/90 md:hidden"
						onClick={onBack}
						size="icon"
						variant="ghost"
					>
						<ArrowLeftIcon className="size-5" />
					</Button>
				) : null}
				{naming && onCancelCreate && onCreateBot ? (
					<div className="pointer-events-auto min-w-0 flex-1">
						<CreateBotHeader
							onCancel={onCancelCreate}
							onCreate={onCreateBot}
						/>
					</div>
				) : agent ? (
					<>
						<Button
							aria-label={isGroup ? "Informações do grupo" : "Configurações do bot"}
							className="pointer-events-auto absolute inset-y-0 left-1/2 my-auto h-11 max-w-[calc(100%-7.5rem)] min-w-0 -translate-x-1/2 gap-2 rounded-full border-border bg-card px-3 transition-opacity duration-200 hover:bg-card/90 md:h-10"
							onClick={onOpenSettings}
							variant="ghost"
						>
							{isGroup ? (
								<GroupAvatar members={groupMembers} ringClassName="ring-card" size={30} />
							) : (
								<AvatarStatus botId={agent.id} size={36} unread={agent.notifications}>
									<LiveAgentAvatar
										bodyColor={agent.color}
										botId={agent.id}
										breathe
										follow="always"
										pokeOnClick
										shape={agent.shape}
										size={36}
									/>
								</AvatarStatus>
							)}
							<span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
							{isGroup ? (
								<span
									className="hidden shrink-0 items-center -space-x-1.5 sm:flex"
									data-testid="group-header-members"
									title={groupMembers.map((member) => member.name).join(", ")}
								>
									{groupMembers.slice(0, 5).map((member) => (
										<span className="rounded-full ring-2 ring-card" key={member.id}>
											<AgentAvatar animated={false} bodyColor={member.color} id={member.id} shape={member.shape} size={20} />
										</span>
									))}
									<span className="pl-2.5 text-muted-foreground text-xs">{groupMembers.length}</span>
								</span>
							) : null}
						</Button>
						<div className="ml-auto flex items-center gap-0.5">
							<Button
								aria-expanded={panelOpen}
								aria-label="Alternar painel"
								className="pointer-events-auto size-11 rounded-full bg-card hover:bg-card/90 md:size-10"
								onClick={onTogglePanel}
								size="icon-sm"
								variant="ghost"
							>
								{panelOpen ? <ChevronsRightIcon /> : <ChevronsLeftIcon />}
							</Button>
						</div>
					</>
				) : null}
			</header>

			<div
				className="min-h-0 flex-1 overflow-x-clip overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				data-testid="chat-scroll"
				ref={scrollRef}
			>
				{loading && messages.length === 0 ? (
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-4 pt-22 pb-44 md:pt-20">
						<WorkingIndicator
							activity={activity}
							agent={agent}
							paused={pausedLike}
							status={runStatus}
						/>
					</div>
				) : (
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-4 pt-22 pb-44 md:pt-20" style={hasPendingApproval ? { paddingBottom: transcriptBottomPadding(true, barHeight) } : undefined}>
						{loadingOlder ? (
							<p className="text-center text-xs text-muted-foreground">
								Carregando mensagens anteriores…
							</p>
						) : null}
						{error ? (
							<p
								className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
								role="alert"
							>
								{error}
							</p>
						) : null}
						{visibleMessages.length === 0 ? (
							<p className="text-center text-sm text-muted-foreground">
								{isGroup
									? `Envie uma mensagem para o grupo ${agent.name}. Use @ para chamar um membro.`
									: `Envie uma mensagem para conversar com ${agent.name}.`}
							</p>
						) : null}
						{threadItems.map((item, index) => {
							const groupPosition = groupPositionFor(
								threadItems,
								index,
								timeSeparators,
							);
							const separatorLabel = timeSeparators.get(item.id);
							const holdsAnchor = Boolean(
								dividerAnchorId &&
									(item.id === dividerAnchorId ||
										(item.type === "bot-group" && item.messages.some((entry) => entry.id === dividerAnchorId))),
							);
							const separator = separatorLabel || holdsAnchor ? (
								<>
									{separatorLabel ? (
										<Marker
											className="my-2 text-xs"
											data-testid="time-separator"
											variant="separator"
										>
											<MarkerContent>{separatorLabel}</MarkerContent>
										</Marker>
									) : null}
									{holdsAnchor ? <NewMessagesDivider /> : null}
								</>
							) : null;
							const sourceMarker =
								item.type === "message" && item.message.kind === "assistant" && item.message.runSource && sourceIds.has(item.message.id) ? (
									<SourceMarker source={item.message.runSource} />
								) : null;
							if (item.type === "bot-group") {
								return (
									<div key={item.id}>
										{separator}
										<BotThreadGroup
											messages={item.messages}
											onOpen={
												item.partners[0]
													? openExchange(
															item.partners[0],
															item.messages[0]?.bot.botMessageId,
															item.messages[0]?.bot.kind ?? "request",
														)
													: undefined
											}
											partners={item.partners}
											resolveBot={resolveBot}
										/>
									</div>
								);
							}
							if (item.type === "bot-reply") {
								return (
									<div key={item.id}>
										{separator}
										<BotLinkMarker
											bot={resolveBot(item.partner)}
											direction="received"
											onOpen={openExchange(item.partner, item.message.bot.botMessageId, "reply")}
										/>
									</div>
								);
							}
							const message = item.message;
							const imageRun = message.kind === "images" ? imageRuns.get(item.id) : undefined;
							if (imageRun === null) return null;
							if (message.kind === "bot-link") {
								return (
									<div key={item.id}>
										{separator}
										<BotLinkMarker
											bot={resolveBot({ id: message.botId, name: message.botName })}
											direction="sent"
											overdue={message.overdue}
											onOpen={openExchange(
												{ id: message.botId, name: message.botName },
												message.botMessageId,
												"sent",
											)}
										/>
									</div>
								);
							}
							if (message.kind === "auto-decision") {
								return (
									<div data-message-id={message.id} key={item.id}>
										{separator}
										<BotAutoDecisionNote decision={message.decision} note={message.note} reason={message.reason} status={message.status} subject={message.subject} />
									</div>
								);
							}
							const markerSource = message.kind === "needs-user" && relayedDone.has(message.id) ? ({ ...message, status: "resolved" } as typeof message) : message;
							// Só cartões de aprovação têm marcador; a thread vai inteira com o índice (sem fatia por linha).
							const approvalMarker =
								message.kind === "confirm" || message.kind === "needs-user"
									? approvalMarkerFor(markerSource, dockIds, messages, (messageIndex.get(message.id) ?? messages.length) + 1)
									: null;
							// Pendente e acionável: o cartão inteiro fica onde nasceu. Só decidido ou expirado vira linha.
							const approvalCardAttr = dockIds.has(message.id) ? message.id : undefined;
							if (approvalMarker && approvalMarker.status !== "pending") {
								const detail =
									message.kind === "confirm"
										? message.devApproval
											? message.devApproval.kind === "command"
												? message.devApproval.command
												: `${message.devApproval.path}\n${message.devApproval.preview}`
											: message.status === "failed"
												? failedApprovalDetail(message.description, message.failureDetail)
												: message.description
										: message.kind === "needs-user"
											? (message.need.item?.devApproval?.kind === "command" ? message.need.item.devApproval.command : message.need.item?.preview)
											: undefined;
								return (
									<div data-message-id={message.kind === "needs-user" ? message.need.cardId : message.id} key={item.id}>
										{separator}
										<ApprovalMarker detail={detail ?? approvalShortLabel(message as never)} marker={approvalMarker} />
									</div>
								);
							}
							if (message.kind === "needs-user") {
									const needBot = resolveBot({ id: message.botId, name: message.botName });
									return (
										<div data-approval-card={approvalCardAttr} data-message-id={message.need.cardId} key={item.id}>
											{separator}
											<div className="my-2" data-testid="bot-needs-user-row">
												<BotNeedsUserCard
													bot={needBot}
													card={message}
													onOpenConversation={
														onSelectAgent && needBot.id
															? () => {
																	requestScrollToCard(message.need.cardId);
																	onSelectAgent(needBot.id!);
																}
															: undefined
													}
												/>
											</div>
										</div>
									);
								}
							// Grupo: fala de um membro, com avatar e nome no primeiro balão do trecho.
							const groupLayout = groupLayouts?.get(message.id);
							if (groupLayout && message.kind === "assistant") {
								const author = groupMembers.find((member) =>
									message.author?.id ? member.id === message.author.id : member.name === message.author?.name,
								);
								return (
									<div className={groupLayout.first && index > 0 && !separatorLabel ? "mt-4" : undefined} data-message-id={message.id} key={message.id}>
										{separator}
										{sourceMarker}
										<GroupAssistantRow
											author={author}
											layout={groupLayout}
											live={isLiveStreamingBubble({
												messageId: message.id,
												streamingMessageId,
												phase: activity.phase,
											})}
											members={mentionMembers}
											message={message}
										/>
									</div>
								);
							}
							// Respiro maior quando muda o autor (novo grupo).
							const newGroup =
								(groupPosition === "single" || groupPosition === "first") &&
								index > 0 &&
								!separatorLabel;
							return (
								<div className={newGroup ? "mt-4" : undefined} data-approval-card={approvalCardAttr} data-message-id={message.id} key={message.id}>
									{separator}
									{sourceMarker}
									<MessageRow
										botName={agent?.name}
										groupPosition={groupPosition}
										imageItems={imageRun?.items}
										userBubbleColor={userBubbleColor}
										knownSkills={isGroup ? undefined : knownSkills}
										mentionMembers={isGroup ? mentionMembers : bubbleMembers}
										live={isLiveStreamingBubble({
											messageId: message.id,
											streamingMessageId,
											phase: activity.phase,
										})}
										message={message}
										onOpenRoutine={onOpenRoutine ? rowHandlers.onOpenRoutine : undefined}
										onConfirm={rowHandlers.onConfirm}
										onConfirmAlways={rowHandlers.onConfirmAlways}
										onConfirmReject={rowHandlers.onConfirmReject}
										onLoginOpenViewer={sandboxViewerUrl && onOpenSandboxViewerForLogin ? rowHandlers.onLoginOpenViewer : undefined}
										onLoginUseVault={rowHandlers.onLoginUseVault}
										onLoginCode={rowHandlers.onLoginCode}
										onLoginDone={rowHandlers.onLoginDone}
										onCancel={rowHandlers.onCancel}
										onAdjustPlan={rowHandlers.onAdjustPlan}
										onBotProfileConfirm={rowHandlers.onBotProfileConfirm}
										skillBots={skillBots}
										onBotProposalApprove={rowHandlers.onBotProposalApprove}
										onBotProposalReject={rowHandlers.onBotProposalReject}
										onRoutineProposalAccept={rowHandlers.onRoutineProposalAccept}
										onRoutineProposalDecline={rowHandlers.onRoutineProposalDecline}
										onSkillProposalApprove={rowHandlers.onSkillProposalApprove}
										onSkillProposalReject={rowHandlers.onSkillProposalReject}
										onSkillProposalEdit={agent?.conversationId ? rowHandlers.onSkillProposalEdit : undefined}
										onBotProfileDismiss={rowHandlers.onBotProfileDismiss}
										onQuestionnaireSubmit={rowHandlers.onQuestionnaireSubmit}
										onQuestionnaireDismiss={rowHandlers.onQuestionnaireDismiss}
									/>
								</div>
							);
						})}
						{isGroup && !working && groupTyping.names.length > 0 ? (
							<WorkingIndicator
								activity={{ phase: "thinking" }}
								agent={groupTyping.agent ?? agent}
								label={groupTyping.label}
							/>
						) : null}
						{!working && waitingOnBot ? (
							<p
								className="px-1 text-xs text-muted-foreground"
								data-testid="awaiting-bot-needs-user"
								role="status"
							>
								{botNeedsUserStatusLine(waitingOnBot.botName)}
							</p>
						) : null}
						{compactState ? <CompactionNotice state={compactState} /> : null}
						{working ? (
							<WorkingIndicator
								activity={activity}
								agent={liveMember ?? agent}
								devSessionId={lastDevSessionId}
								pendingApproval={hasPendingApproval}
								label={
									isGroup && liveMember && activity.phase !== "tool" && !pausedLike
										? coordinatingLabel || `${liveMember.name} está digitando`
										: undefined
								}
								paused={pausedLike}
								status={runStatus}
								subagents={
									activeSubagents
										? { groupId: activeSubagents.groupId, tasks: activeSubagents.tasks }
										: null
								}
							/>
						) : null}
						<div aria-hidden className="h-px" data-testid="thread-bottom" ref={bottomRef} />
					</div>
				)}
			</div>

			<ScrollToBottom newCount={newCount} onJump={() => (stickRef.current = true)} targetRef={scrollRef} />

			<ChatComposer
				dock={
					<ApprovalBar
						entries={barEntries}
						onApprove={(entry) => (entry.type === "confirm" ? rowHandlers.onConfirm(entry.message) : decideRelayed(entry, "approve"))}
						onAlways={(entry) => (entry.type === "confirm" ? rowHandlers.onConfirmAlways(entry.message) : undefined)}
						onHeight={setBarHeight}
						onLocate={locateCard}
						onSkip={(entry) => (entry.type === "confirm" ? rowHandlers.onCancel(entry.message) : decideRelayed(entry, "reject"))}
					/>
				}
				mentionBots={isGroup ? undefined : otherBots}
				mentionMembers={isGroup ? mentionMembers : undefined}
				agentName={agent.name}
				conversationKey={agent.conversationId ?? agent.id}
				textareaRef={composerInputRef}
				language={agent.language}
				disabled={false}
				model={model}
				servedModel={servedModel}
				prefill={adjustPrefill ?? prefill}
				onModelChange={(next) => {
					setModel(next);
					onAgentModelChange?.(next);
				}}
				onSend={sendFollowing}
				onCompact={isGroup ? undefined : (focus) => void compact(focus)}
				onStop={() => void cancelRun()}
				runActive={runActive}
			/>
		</div>
	);
}
