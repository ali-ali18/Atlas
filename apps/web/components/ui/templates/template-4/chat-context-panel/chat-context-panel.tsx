"use client";

import { ChevronLeftIcon, Maximize2Icon, SettingsIcon, XIcon } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@workspace/ui/components/tabs";
import { cn } from "@workspace/ui/lib/utils";
import type { AgentPointerState } from "@/lib/agent-pointer";
import { AgentPointerOverlay } from "../agent-pointer-overlay";
import { AgentAvatar } from "../agent-avatar";
import { getAtlasApiBaseUrl, listRoutineRuns } from "@/lib/atlas-api";
import { useAccountCodingModel } from "@/hooks/use-account-coding-model";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { useAccountTimezone } from "@/hooks/use-account-timezone";
import { useBotFollowups } from "@/hooks/use-bot-followups";
import { readProactiveSettings } from "@workspace/shared";
import { FollowupDetail, FollowupsSection, followupKindLabel } from "./followups-section";
import { DevSessionDetail } from "@/components/ai-elements/dev-session/dev-session-detail";
import { SubagentDetail } from "@/components/ai-elements/subagents";
import { useActivitySelection } from "@/lib/dev-session/store";

import {
	type Agent,
	type Routine,
	type RoutineGithubUiConfig,
} from "../data";
import { AGENT_SETTINGS_TITLES, AgentSettings, type AgentSettingsPage } from "./agent-settings";
import { botAccentStyle } from "./bot-accent";
import { GroupPanelContent, type GroupPanelProps } from "./group-panel";
import { BotLibrary } from "./bot-library";
import { StopComputerButton } from "./stop-computer-button";
import { BotEmailTab } from "./bot-email-tab";
import { RoutineEditor } from "./routine-editor";
import {
	RoutineCreateChooser,
	type TemplateCreateFields,
} from "./routine-create-chooser";
import { RoutinesSectionBody } from "./routines-section";
import type { RoutineGroupHandlers } from "./routine-group-block";
import { GithubDialog, HistoryDialog, WebhookDialog } from "./routine-dialogs";
import { routinePrimaryTriggerKind } from "./routine-map";
import type { GithubRoutineTemplate } from "@workspace/shared";

const MIN_WIDTH = 260;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 320;
const REOPEN_DRAG_PX = 24;
const WIDTH_COOKIE = "template4_panel_width";
const useSafeLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

function clampWidth(width: number) {
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function readWidthCookie() {
	const match = document.cookie.match(
		new RegExp(`(?:^|;\\s*)${WIDTH_COOKIE}=(\\d+)`),
	);
	return match ? Number(match[1]) : null;
}

function writeWidthCookie(width: number) {
	// biome-ignore lint/suspicious/noDocumentCookie: persiste a largura do painel
	document.cookie = `${WIDTH_COOKIE}=${width}; path=/; max-age=31536000; samesite=lax`;
}

/** Campo de texto que vira edição ao clicar (rótulo, nome): salva ao sair do campo ou com Enter, Esc cancela. */
function InlineText({
	value,
	placeholder,
	ariaLabel,
	title,
	required = false,
	className,
	inputClassName,
	onCommit,
}: {
	value: string;
	placeholder?: string;
	ariaLabel: string;
	title?: string;
	/** Vazio não vale: volta ao valor anterior. */
	required?: boolean;
	className?: string;
	inputClassName?: string;
	onCommit: (value: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const committedRef = useRef(false);

	function commit() {
		// Enter desmonta o input e dispara blur de novo: só salva uma vez.
		if (committedRef.current) return;
		committedRef.current = true;
		setEditing(false);
		const next = draft.trim();
		if (required && !next) return;
		if (next !== value.trim()) onCommit(next);
	}

	if (editing) {
		return (
			<Input
				aria-label={ariaLabel}
				autoFocus
				className={inputClassName}
				onBlur={commit}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
					if (event.key === "Escape") {
						committedRef.current = true;
						setDraft(value);
						setEditing(false);
					}
				}}
				value={draft}
			/>
		);
	}
	return (
		<button
			className={className}
			onClick={() => {
				setDraft(value);
				committedRef.current = false;
				setEditing(true);
			}}
			title={title}
			type="button"
		>
			{value.trim() || placeholder}
		</button>
	);
}

/** Cabeçalho centralizado: avatar, nome e rótulo, os dois editáveis ali mesmo (clique no texto). */
export function BotHeader({
	agent,
	onUpdate,
}: {
	agent: Agent;
	onUpdate: (patch: Partial<Agent>) => void;
}) {
	return (
		<div className="flex flex-col items-center gap-1 pt-2" data-bot-header>
			<AgentAvatar
				bodyColor={agent.color}
				mood="neutre"
				shape={agent.shape}
				size={98}
			/>
			<InlineText
				ariaLabel="Nome do bot"
				className="max-w-full truncate rounded-md px-1 font-bold text-[17px] outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50"
				inputClassName="h-8 max-w-56 text-center font-bold text-[17px]"
				onCommit={(name) => onUpdate({ name })}
				required
				title="Clique para editar o nome"
				value={agent.name}
			/>
			<InlineText
				ariaLabel="Rótulo do bot"
				className="max-w-full truncate rounded-md px-1 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
				inputClassName="h-7 max-w-56 text-center text-xs"
				onCommit={(snippet) => onUpdate({ snippet })}
				placeholder="Adicionar um rótulo"
				value={agent.snippet}
			/>
		</div>
	);
}

/** Computador dormindo: avatar apagado, "z z" e o botão Acordar. */
export function SleepingComputer({
	agent,
	busy,
	error,
	onWake,
	restarting,
}: {
	agent: Agent;
	busy?: boolean;
	/** Mensagem em português quando a VM não subiu mesmo após as tentativas automáticas. */
	error?: string | null;
	onWake?: () => void;
	/** A primeira subida falhou e o sistema está refazendo sozinho. */
	restarting?: boolean;
}) {
	return (
		<div
			className="flex h-full min-h-56 flex-col items-center justify-center gap-4 px-6 py-8 text-center"
			data-computer-sleeping
		>
			<div className="relative grayscale">
				<div className="opacity-50">
					{/* Parado de propósito: dormindo não respira, não pisca nem gira. */}
						<AgentAvatar animated={false} bodyColor={agent.color} mood="somnolent" shape={agent.shape} size={72} />
				</div>
				<span
					aria-hidden="true"
					className="absolute -top-4 -right-5 font-semibold text-muted-foreground text-xs tracking-widest"
				>
					z z
				</span>
			</div>
			<p className="font-bold text-sm">{error && !busy ? "Não consegui ligar o computador" : "O computador está dormindo"}</p>
			{error && !busy ? (
				<p className="max-w-64 text-muted-foreground text-xs" role="alert">
					{error}
				</p>
			) : null}
			<Button
				className="rounded-full bg-(--bot-accent,var(--primary)) text-white hover:bg-(--bot-accent,var(--primary))/90"
				disabled={busy || !onWake}
				onClick={onWake}
				size="sm"
			>
				{busy ? (restarting ? "Reiniciando a VM…" : "Acordando…") : error ? "Tentar de novo" : "Acordar"}
			</Button>
		</div>
	);
}

export function ChatContextPanel({
	agent,
	className,
	editingRoutine,
	initialWidth,
	onClosePanel,
	onCloseView,
	onDescribeRoutineInChat,
	onCreateRoutineTemplate,
	onCreateScheduledRoutine,
	onCreateWebhookRoutine,
	onEditRoutineWithAgent,
	onOpenPanel,
	onOpenSandboxViewer,
	onStopSandbox,
	sandboxStopBusy = false,
	sandboxStopError = null,
	onSaveRoutine,
	onCreateRoutine,
	onToggleRoutine,
	isRoutinePersisted,
	onSaveGithubTrigger,
	onDeleteRoutine,
	routineGroups = [],
	onCreateRoutineGroup,
	onRenameRoutineGroup,
	onSetRoutineGroupEnabled,
	onDeleteRoutineGroup,
	onRunRoutine,
	onRotateRoutineSecret,
	onOpenSettings,
	onStartSandbox,
	onUpdate,
	group,
	open = true,
	routines = [],
	routineRuns = [],
	routinePersisted = false,
	routineOneTimeSecret = null,
	onOpenMarketplace,
	defaultRoutineModel,
	sandboxBusy = false,
	sandboxError = null,
	sandboxRestarting = false,
	sandboxSessionId,
	sandboxViewerUrl,
	agentPointer = null,
	view = "default",
	initialTab = "library",
}: {
	agent: Agent;
	className?: string;
	editingRoutine?: Routine;
	initialWidth?: number;
	onClosePanel?: () => void;
	onCloseView?: () => void;
	/** Foca o composer com um prefill (chooser "Descreva no chat"). */
	onDescribeRoutineInChat?: () => void;
	/** Cria a rotina a partir de um dos GITHUB_ROUTINE_TEMPLATES; retorna a mensagem de erro (409 etc) ou null. */
	onCreateRoutineTemplate?: (
		template: GithubRoutineTemplate,
		fields: TemplateCreateFields,
	) => Promise<string | null>;
	onCreateScheduledRoutine?: () => void;
	onCreateWebhookRoutine?: () => void;
	/** "Editar": prefill do composer ("Edite sua rotina: …"). */
	onEditRoutineWithAgent?: (routine: Routine) => void;
	onOpenPanel?: () => void;
	onOpenSandboxViewer?: () => void;
	/** "Desligar computador": para a VM com graça; sem isto o botão não aparece. */
	onStopSandbox?: () => void;
	sandboxStopBusy?: boolean;
	sandboxStopError?: string | null;
	onSaveRoutine?: (routine: Routine) => void | Promise<void>;
	onCreateRoutine?: (routine: Routine) => Promise<boolean> | boolean;
	onToggleRoutine?: (
		routine: Routine,
		enabled: boolean,
	) => Promise<string | null>;
	isRoutinePersisted?: (routine: Routine) => boolean;
	/** Salva só o gatilho GitHub (botão explícito "Salvar gatilho"). */
	onSaveGithubTrigger?: (
		github: RoutineGithubUiConfig,
	) => Promise<RoutineGithubUiConfig | { error: string }>;
	onDeleteRoutine?: (routine: Routine) => void;
	/** Grupos de rotinas do bot (o bloco agrupa as rotinas com o mesmo `groupId`). */
	routineGroups?: Array<{ id: string; name: string }>;
	/** Cria um grupo pelo editor; devolve o grupo ou a mensagem de erro. */
	onCreateRoutineGroup?: (name: string) => Promise<{ id: string; name: string } | { error: string }>;
	onRenameRoutineGroup?: RoutineGroupHandlers["onRename"];
	onSetRoutineGroupEnabled?: RoutineGroupHandlers["onSetEnabled"];
	onDeleteRoutineGroup?: RoutineGroupHandlers["onDelete"];
	/** Dispara a execução de teste; `false`/rejeição = falha. */
	onRunRoutine?: (routine: Routine) => unknown;
	/** Gera uma chave nova (o secret só existe em hash; aparece uma vez). */
	onRotateRoutineSecret?: (routine: Routine) => void | Promise<void>;
	/** Abre as configurações do bot (engrenagem no topo da visão geral; só o dono). */
	onOpenSettings?: () => void;
	onStartSandbox?: () => void;
	onUpdate: (patch: Partial<Agent> & { policyJson?: unknown }) => void;
	/** Grupo de bots: no lugar do cabeçalho do bot e das abas, "Membros" e "Detalhes" do grupo. */
	group?: GroupPanelProps;
	open?: boolean;
	routines?: Routine[];
	routineRuns?: { id: string; name: string; time: string }[];
	routinePersisted?: boolean;
	routineOneTimeSecret?: string | null;
	/** Abre o dialog do Marketplace (conectar GitHub etc). */
	onOpenMarketplace?: () => void;
	/** Modelo do bot — pré-preenche rotina nova. */
	defaultRoutineModel?: string;
	sandboxBusy?: boolean;
	sandboxError?: string | null;
	sandboxRestarting?: boolean;
	sandboxSessionId?: string | null;
	sandboxViewerUrl?: string | null;
	/** Cursor do agente a desenhar sobre a prévia do sandbox. */
	agentPointer?: AgentPointerState | null;
	/** settings = configurações do bot; routine = rascunho de rotina ou rotina aberta pelo chat. */
	view?: "default" | "settings" | "routine" | "activity";
	initialTab?: "library" | "computer" | "email";
}) {
	const [width, setWidth] = useState(initialWidth ?? DEFAULT_WIDTH);
	const [resizing, setResizing] = useState(false);
	const [mounted, setMounted] = useState(false);
	const [snapshotVersion, setSnapshotVersion] = useState(0);
	const [tab, setTab] = useState<string>(initialTab);
	const [historyFor, setHistoryFor] = useState<Routine | null>(null);
	const [webhookFor, setWebhookFor] = useState<Routine | null>(null);
	const [githubFor, setGithubFor] = useState<Routine | null>(null);
	const [secretFor, setSecretFor] = useState<string | null>(null);
	const [snapshotStatus, setSnapshotStatus] = useState<{
		sessionId: string;
		state: "ready" | "failed";
	} | null>(null);
	const latestWidth = useRef(width);
	const executions = routineRuns;
	// Modo proativo: lembretes agendados aparecem só no bot principal com o modo ligado.
	const [settingsPage, setSettingsPage] = useState<AgentSettingsPage>("main");
	// Fuso da conta (padrão do modo proativo): relê ao abrir/trocar de vista, p. ex. depois de mudá-lo nas configurações.
	const accountTimezone = useAccountTimezone(view);
	const accountCodingModel = useAccountCodingModel(view);
	const proactiveSettings = readProactiveSettings(
		(agent as { policyJson?: unknown }).policyJson,
		accountTimezone,
	);
	const showFollowups = agent.isPrimary === true && proactiveSettings.enabled && !group;
	const followups = useBotFollowups(agent.id, showFollowups);
	const [followupId, setFollowupId] = useState<string | null>(null);
	const openFollowup = showFollowups ? (followups.followups.find((item) => item.id === followupId) ?? null) : null;
	useEffect(() => {
		if (view !== "settings") setSettingsPage("main");
		if (view !== "default") setFollowupId(null);
	}, [view]);
	useEffect(() => {
		setFollowupId(null);
	}, [agent.id]);
	const snapshotReady =
		snapshotStatus !== null &&
		snapshotStatus.sessionId === sandboxSessionId &&
		snapshotStatus.state === "ready";
	const snapshotFailed =
		snapshotStatus !== null &&
		snapshotStatus.sessionId === sandboxSessionId &&
		snapshotStatus.state === "failed";
	const snapshotUrl = sandboxSessionId
		? `${getAtlasApiBaseUrl()}/v1/sandbox/sessions/${encodeURIComponent(sandboxSessionId)}/screenshot?v=${snapshotVersion}`
		: null;
	// Prévia do computador só atualiza com a aba Computador aberta E a página visível (aba do navegador em
	// segundo plano não baixa screenshot a cada 4 s).
	const documentVisible = useDocumentVisible();
	const previewVisible = open && view === "default" && tab === "computer" && documentVisible;
	const activitySelection = useActivitySelection();
	const isActivityView = view === "activity" && activitySelection !== null;
	const isDraftView = view === "routine" && !(routinePersisted && editingRoutine);

	const loadRuns = useCallback(
		(routineId: string) => listRoutineRuns(agent.id, routineId),
		[agent.id],
	);

	useEffect(() => {
		if (!sandboxSessionId || !previewVisible) return;
		const timer = window.setInterval(() => {
			setSnapshotVersion((version) => version + 1);
		}, 4_000);
		return () => window.clearInterval(timer);
	}, [sandboxSessionId, previewVisible]);

	// Logo depois de um clique do agente a prévia atualiza (sem esperar o ciclo de 4 s).
	const agentClickSeq = agentPointer?.clickSeq ?? 0;
	useEffect(() => {
		if (!sandboxSessionId || !previewVisible || agentClickSeq === 0) return;
		const timer = window.setTimeout(() => {
			setSnapshotVersion((version) => version + 1);
		}, 700);
		return () => window.clearTimeout(timer);
	}, [agentClickSeq, sandboxSessionId, previewVisible]);

	// Rotina persistida aberta fora da lista (card do chat, template do chooser):
	// mostra o diálogo certo em vez de uma subpágina.
	const openedFromView = useRef<string | null>(null);
	useEffect(() => {
		if (view !== "routine" || !editingRoutine || !routinePersisted) {
			openedFromView.current = null;
			return;
		}
		if (openedFromView.current === editingRoutine.id) return;
		openedFromView.current = editingRoutine.id;
		setTab("library");
		const kind = routinePrimaryTriggerKind(editingRoutine);
		if (kind === "webhook") setWebhookFor(editingRoutine);
		else if (kind === "github") setGithubFor(editingRoutine);
		else setHistoryFor(editingRoutine);
	}, [view, editingRoutine, routinePersisted]);

	// Fallback (sem valor do servidor): aplica o cookie antes do paint.
	useSafeLayoutEffect(() => {
		if (initialWidth !== undefined) return;
		const stored = readWidthCookie();
		if (stored === null) return;
		const next = clampWidth(stored);
		latestWidth.current = next;
		setWidth(next);
	}, [initialWidth]);

	useEffect(() => {
		setMounted(true);
	}, []);

	function handleResizeStart(event: React.PointerEvent<HTMLButtonElement>) {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = width;
		const restoreWidth = latestWidth.current;
		let lastRaw = startWidth;
		let closed = false;
		setResizing(true);

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		const closeNow = () => {
			if (closed) return;
			closed = true;
			setResizing(false);
			cleanup();
			// Restaura a largura válida para a próxima abertura e fecha
			// na hora, sem esperar soltar o mouse.
			setWidth(restoreWidth);
			onClosePanel?.();
		};

		const onMove = (moveEvent: PointerEvent) => {
			if (closed) return;
			lastRaw = startWidth + (startX - moveEvent.clientX);
			// Bateu no mínimo e continuou: fecha imediatamente.
			if (lastRaw < MIN_WIDTH) {
				closeNow();
				return;
			}
			const next = clampWidth(lastRaw);
			latestWidth.current = next;
			setWidth(next);
		};
		const onUp = () => {
			if (closed) return;
			setResizing(false);
			cleanup();
			writeWidthCookie(latestWidth.current);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function handleReopenDragStart(event: React.PointerEvent<HTMLButtonElement>) {
		event.preventDefault();
		const startX = event.clientX;
		let opened = false;

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		const onMove = (moveEvent: PointerEvent) => {
			if (opened) return;
			// Puxou para a esquerda além do limite: abre na hora,
			// sem precisar soltar o mouse.
			if (startX - moveEvent.clientX > REOPEN_DRAG_PX) {
				opened = true;
				cleanup();
				onOpenPanel?.();
			}
		};
		const onUp = () => {
			cleanup();
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	const createChooser = (trigger: React.ReactElement) => (
		<RoutineCreateChooser
			onCreateScheduled={() => onCreateScheduledRoutine?.()}
			onCreateTemplate={async (template, fields) =>
				(await onCreateRoutineTemplate?.(template, fields)) ?? null
			}
			onCreateWebhook={() => onCreateWebhookRoutine?.()}
			onDescribeInChat={() => onDescribeRoutineInChat?.()}
			trigger={trigger}
		/>
	);

	function closeRoutineDialog() {
		// Aberto pelo chat: ao fechar o diálogo, limpa a rotina em edição.
		if (view === "routine") onCloseView?.();
	}

	const followupView = !group && view === "default" && openFollowup !== null;
	const subview = !group && (view === "settings" || isDraftView || isActivityView || followupView);
	// Dentro de Configurações: a subvista (Modo proativo) volta para a principal; a principal fecha a vista.
	const inSettingsSubpage = view === "settings" && settingsPage !== "main";
	const subviewTitle = isActivityView
		? activitySelection.kind === "dev"
			? "Sessão de código"
			: "Subagente"
		: followupView && openFollowup
			? followupKindLabel(openFollowup.kind)
			: view === "settings"
				? AGENT_SETTINGS_TITLES[settingsPage]
				: editingRoutine?.name.trim() || "Nova rotina";
	const fullscreen = open && subview;
	const webhookSecret =
		webhookFor &&
		(secretFor === webhookFor.id ||
			(view === "routine" && editingRoutine?.id === webhookFor.id))
			? routineOneTimeSecret
			: null;

	return (
		<>
			{open ? null : (
				<button
					aria-label="Abrir painel lateral"
					className="group/pull absolute inset-y-0 right-0 z-30 hidden w-4 cursor-ew-resize touch-none bg-transparent lg:block"
					onClick={() => onOpenPanel?.()}
					onPointerDown={handleReopenDragStart}
					title="Arrastar para abrir o painel"
					type="button"
				>
					<span className="absolute inset-y-0 right-0 w-1.5 bg-transparent transition-colors group-hover/pull:bg-sidebar-border/60" />
				</button>
			)}
			{open && !subview ? (
				<button
					aria-label="Fechar ao tocar fora"
					className="fixed inset-0 z-40 cursor-default bg-black/50 supports-backdrop-filter:bg-black/40 supports-backdrop-filter:backdrop-blur-sm lg:hidden"
					data-slot="info-pane-backdrop"
					onClick={() => onClosePanel?.()}
					tabIndex={-1}
					type="button"
				/>
			) : null}
			<aside
				className={cn(
					"info-pane relative shrink-0 overflow-hidden border-l border-sidebar-border bg-sidebar/40",
					open
						? subview
						? "max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:block max-lg:w-full! max-lg:border-0 max-lg:bg-background"
						: "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:block max-lg:w-[88%]! max-lg:max-w-sm max-lg:rounded-l-3xl max-lg:border-0 max-lg:bg-background max-lg:shadow-xl"
						: "hidden lg:block",
					fullscreen && "lg:relative",
					mounted && !resizing && "transition-all duration-300 ease-out",
					open ? "opacity-100" : "border-l-transparent opacity-0",
					className,
				)}
				inert={!open}
				style={
					{
						width: open ? width : 0,
						"--info-pane-width": `${width}px`,
						...botAccentStyle(agent.color),
					} as React.CSSProperties
				}
			>
				<div
					className="relative flex h-full flex-col max-lg:w-full!"
					style={{ width: "var(--info-pane-width)" }}
				>
					<header className="info-pane__top flex h-12 shrink-0 items-center gap-1 px-2">
						<div className="flex w-8 shrink-0 justify-start">
							{subview ? (
								<Button
									aria-label="Voltar"
									onClick={() =>
										followupView
											? setFollowupId(null)
											: inSettingsSubpage
												? setSettingsPage("main")
												: onCloseView?.()
									}
									size="icon-sm"
									variant="ghost"
								>
									<ChevronLeftIcon />
								</Button>
							) : null}
						</div>
						<h2 className="min-w-0 flex-1 truncate text-center font-medium text-sm">
							{subview ? subviewTitle : null}
						</h2>
						<div className="flex shrink-0 items-center justify-end gap-0.5">
							{!subview && !group && onOpenSettings ? (
								<Button
									aria-label="Configurações do bot"
									data-info-row="settings"
									onClick={() => {
										setSettingsPage("main");
										onOpenSettings();
									}}
									size="icon-sm"
									variant="ghost"
								>
									<SettingsIcon />
								</Button>
							) : null}
							<Button
								aria-label="Fechar painel"
								onClick={() => {
									if (view !== "default") onCloseView?.();
									onClosePanel?.();
								}}
								size="icon-sm"
								variant="ghost"
							>
								<XIcon />
							</Button>
						</div>
					</header>

					{group ? (
						<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
							<GroupPanelContent agent={agent} group={group} />
						</div>
					) : isActivityView ? (
						<div
							className="flex min-h-0 flex-1 animate-in flex-col pt-1 duration-200 fade-in slide-in-from-right-2"
							key={activitySelection.kind === "dev" ? activitySelection.sessionId : `${activitySelection.groupId}:${activitySelection.taskIndex}`}
						>
							{activitySelection.kind === "dev" ? (
								<DevSessionDetail sessionId={activitySelection.sessionId} />
							) : (
								<SubagentDetail groupId={activitySelection.groupId} taskIndex={activitySelection.taskIndex} />
							)}
						</div>
					) : followupView && openFollowup ? (
						<div className="flex min-h-0 flex-1 animate-in flex-col duration-200 fade-in slide-in-from-right-2">
							<FollowupDetail
								item={openFollowup}
								onCancel={followups.cancel}
								onDone={() => setFollowupId(null)}
								onReschedule={followups.reschedule}
								timeZone={proactiveSettings.timezone}
							/>
						</div>
					) : view === "settings" ? (
						<div className="flex min-h-0 flex-1 animate-in flex-col duration-200 fade-in slide-in-from-right-2">
							<AgentSettings
								accountCodingModel={accountCodingModel}
								accountTimezone={accountTimezone}
								agent={agent}
								onChange={onUpdate}
								onOpenPage={setSettingsPage}
								page={settingsPage}
							/>
						</div>
					) : isDraftView ? (
						<div className="flex min-h-0 flex-1 animate-in flex-col duration-200 fade-in slide-in-from-right-2">
							<RoutineEditor
								key={editingRoutine?.id ?? "new"}
								defaultModel={defaultRoutineModel}
								onOpenMarketplace={onOpenMarketplace}
								onCreate={onCreateRoutine}
								onSave={onSaveRoutine}
								groups={routineGroups}
								onCreateGroup={onCreateRoutineGroup}
								onSaveGithubTrigger={onSaveGithubTrigger}
								oneTimeSecret={routineOneTimeSecret}
								persisted={routinePersisted}
								routine={editingRoutine}
							/>
						</div>
					) : (
						<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
							<BotHeader agent={agent} onUpdate={onUpdate} />
							<Tabs onValueChange={setTab} value={tab}>
								<TabsList aria-label="Seções do painel" className="w-full">
									<TabsTrigger className="min-w-0 flex-1 basis-0 px-1.5" value="library">Biblioteca</TabsTrigger>
									<TabsTrigger className="min-w-0 flex-1 basis-0 px-1.5" value="computer">Computador</TabsTrigger>
									<TabsTrigger className="min-w-0 flex-1 basis-0 px-1.5" value="email">E-mail</TabsTrigger>
								</TabsList>

								<TabsContent value="library">
									<BotLibrary
										active={tab === "library"}
										botId={agent.id}
										createRoutine={createChooser}
										routines={routines}
										routinesBody={
											<RoutinesSectionBody
												cards={{
													onDelete: onDeleteRoutine,
													onEdit: onEditRoutineWithAgent,
													onOpenGithub: setGithubFor,
													onOpenHistory: setHistoryFor,
													onOpenWebhook: setWebhookFor,
													onRun: onRunRoutine,
													onToggle: onToggleRoutine,
													isPersisted: isRoutinePersisted,
												}}
												createChooser={createChooser}
												executions={executions}
												extra={
													showFollowups ? (
														<FollowupsSection
															followups={followups.followups}
															loaded={followups.loaded}
															onCancel={followups.cancel}
															onOpen={setFollowupId}
															timeZone={proactiveSettings.timezone}
														/>
													) : null
												}
												groupHandlers={{ onDelete: onDeleteRoutineGroup, onRename: onRenameRoutineGroup, onSetEnabled: onSetRoutineGroupEnabled }}
												groups={routineGroups}
												routines={routines}
											/>
										}
									/>
								</TabsContent>

								<TabsContent value="email">
									<BotEmailTab active={tab === "email"} botId={agent.id} onOpenConversation={onClosePanel} />
								</TabsContent>

								<TabsContent className="space-y-2" value="computer">
									<div
										className={cn(
											"group relative w-full overflow-hidden rounded-2xl border bg-card",
											// Com tela: proporção de vídeo. Dormindo: a altura vem do conteúdo, senão espreme em coluna estreita.
											sandboxViewerUrl ? "aspect-video" : "min-h-56",
										)}
									>
										{sandboxViewerUrl ? (
											<>
												{snapshotUrl ? (
													// Screenshot muda a cada poucos segundos; otimização/cache de imagem atrasa a prévia.
													// eslint-disable-next-line @next/next/no-img-element
													<img
														aria-hidden="true"
														alt=""
														className="pointer-events-none absolute inset-0 h-full w-full object-contain"
														// Mesma proporção do quadro (aspect-video): o navegador reserva o espaço antes de carregar.
														height={720}
														key={sandboxSessionId}
														width={1280}
														onError={() => {
															setSnapshotStatus({
																sessionId: sandboxSessionId!,
																state: "failed",
															});
														}}
														onLoad={() => {
															setSnapshotStatus({
																sessionId: sandboxSessionId!,
																state: "ready",
															});
														}}
														src={snapshotUrl}
														style={{ visibility: snapshotReady ? "visible" : "hidden" }}
													/>
												) : null}
												{snapshotReady ? (
													<AgentPointerOverlay
														botName={agent.name}
														color={agent.color}
														pointer={agentPointer}
													/>
												) : (
													<div className="grid h-full place-items-center bg-muted/40">
														<AgentAvatar
															bodyColor={agent.color}
															mood="neutre"
															shape={agent.shape}
															size={72}
														/>
													</div>
												)}
												<button
													aria-label="Abrir tela do sandbox"
													className="absolute inset-0 grid place-items-center bg-background/10 transition-colors hover:bg-background/45 focus-visible:bg-background/45 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
													onClick={onOpenSandboxViewer}
													type="button"
												>
													<span className="grid size-11 place-items-center rounded-md border bg-background/90 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
														<Maximize2Icon className="size-5 text-foreground" />
													</span>
												</button>
											</>
										) : (
											<SleepingComputer
												agent={agent}
												busy={sandboxBusy}
												error={sandboxError}
												onWake={onStartSandbox}
												restarting={sandboxRestarting}
											/>
										)}
									</div>
									<p className="text-center text-muted-foreground text-xs">
										{sandboxViewerUrl && snapshotFailed
											? `Prévia indisponível — ${agent.name}`
											: `Tela de ${agent.name}`}
									</p>
									{sandboxViewerUrl && onStopSandbox ? (
										<StopComputerButton
											agentName={agent.name}
											busy={sandboxStopBusy}
											error={sandboxStopError}
											onStop={onStopSandbox}
										/>
									) : null}
								</TabsContent>
							</Tabs>
						</div>
					)}

					<button
						aria-label="Redimensionar painel"
						className="group/resize absolute inset-y-0 left-0 z-30 hidden w-2 cursor-col-resize touch-none bg-transparent lg:block"
						onPointerDown={handleResizeStart}
						type="button"
					>
						<span className="mx-auto block h-full w-px bg-transparent transition-colors group-hover/resize:bg-border" />
					</button>
				</div>
			</aside>

			<HistoryDialog
				loadRuns={loadRuns}
				onOpenChange={(next) => {
					if (next) return;
					setHistoryFor(null);
					closeRoutineDialog();
				}}
				routine={historyFor}
			/>
			<WebhookDialog
				canRotate={Boolean(webhookFor && isRoutinePersisted?.(webhookFor))}
				onOpenChange={(next) => {
					if (next) return;
					setWebhookFor(null);
					closeRoutineDialog();
				}}
				onRotate={
					onRotateRoutineSecret
						? async (routine) => {
								await onRotateRoutineSecret(routine);
								setSecretFor(routine.id);
							}
						: undefined
				}
				routine={webhookFor}
				secret={webhookSecret}
			/>
			<GithubDialog
				onOpenChange={(next) => {
					if (next) return;
					setGithubFor(null);
					closeRoutineDialog();
				}}
				routine={githubFor}
			/>
		</>
	);
}
