"use client";

import { PlusIcon, RefreshCwIcon } from "lucide-react";

import { ListLoadError, listErrorMode } from "../list-load-error";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@workspace/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@workspace/ui/components/empty";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	useSidebar,
} from "@workspace/ui/components/sidebar";

import type { Section } from "@workspace/shared";

import type { Agent } from "../data";
import { type AgentMenuActions } from "./agent-context-menu";
import { AgentList, type SectionActions } from "./agent-list";
import { AgentsSkeleton } from "./agents-skeleton";
import { ChatSidebarFooter } from "./chat-sidebar-footer";
import { ChatSidebarHeader } from "./chat-sidebar-header";
import { PinnedAgentsZone } from "./pinned-agents-zone";
import { AgentAvatar } from "../agent-avatar";
import { ActiveWorkSidebarSection } from "@/components/ai-elements/dev-session/active-work";
import type { ActiveWorkItemResponse } from "@/lib/atlas-api";
import { useT } from "@/lib/i18n/provider";

export type SidebarDrag = { id: string; pinned: boolean };

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_EXPAND_WIDTH = 240;
const SIDEBAR_EXPAND_DRAG_PX = 16;
const SIDEBAR_WIDTH_COOKIE = "template4_sidebar_width";

function clampSidebarWidth(width: number) {
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function readSidebarWidthCookie() {
	const match = document.cookie.match(
		new RegExp(`(?:^|;\\s*)${SIDEBAR_WIDTH_COOKIE}=(\\d+)`),
	);
	return match ? Number(match[1]) : null;
}

function writeSidebarWidthCookie(width: number) {
	// biome-ignore lint/suspicious/noDocumentCookie: persiste a largura da sidebar
	document.cookie = `${SIDEBAR_WIDTH_COOKIE}=${width}; path=/; max-age=31536000; samesite=lax`;
}

function applySidebarWidth(width: number) {
	document
		.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')
		?.style.setProperty("--sidebar-width", `${width}px`);
}

export function ChatSidebar({
	activeId,
	agents,
	loading = false,
	loadError = false,
	onRetryLoad,
	menuActions,
	sections,
	sectionActions,
	onPlacePinned,
	onSelect,
	onStartCreate,
	onStartCreateGroup,
	onOpenMarketplace,
	onOpenSettings,
	onOpenAutonomy,
	onUnpin,
	onOpenWork,
}: {
	/** Abre o item de "Em andamento": navega para a conversa e abre o painel. */
	onOpenWork?: (item: ActiveWorkItemResponse) => void;
	activeId: string;
	agents: Agent[];
	loading?: boolean;
	/** A lista não carregou/atualizou: mostra erro (nunca "nenhum agente") ou faixa sobre a última lista. */
	loadError?: boolean;
	onRetryLoad?: () => void;
	menuActions: AgentMenuActions;
	sections: Section[];
	sectionActions: SectionActions;
	onPlacePinned: (id: string, index: number) => void;
	onSelect: (id: string) => void;
	onStartCreate: () => void;
	onStartCreateGroup: () => void;
	onOpenMarketplace: () => void;
	onOpenSettings: () => void;
	onOpenAutonomy: () => void;
	onUnpin: (id: string) => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [drag, setDrag] = useState<SidebarDrag>();
	const dragRef = useRef<SidebarDrag | undefined>(undefined);
	const droppedInZone = useRef(false);
	const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();
	const latestSidebarWidth = useRef<number | null>(null);
	const errorMode = listErrorMode({ loadError, loading, count: agents.length });
	const retryLoad = () => onRetryLoad?.();

	// Aplica a largura persistida ao montar (o provider usa 20rem por padrão).
	useEffect(() => {
		const stored = readSidebarWidthCookie();
		if (stored === null) return;
		const next = clampSidebarWidth(stored);
		latestSidebarWidth.current = next;
		applySidebarWidth(next);
	}, []);

	const listAgents = useMemo(() => {
		const term = query.trim().toLowerCase();
		// Fixados ficam SÓ na zona de fixados (fixar e sessão são exclusivos).
		return agents.filter(
			(agent) =>
				!agent.pinned && (!term || agent.name.toLowerCase().includes(term)),
		);
	}, [agents, query]);

	const pinned = useMemo(
		() =>
			agents
				.filter((agent) => agent.pinned)
				.sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0)),
		[agents],
	);

	function startDrag(agent: Agent) {
		return (event: React.DragEvent) => {
			droppedInZone.current = false;
			const next = { id: agent.id, pinned: Boolean(agent.pinned) };
			dragRef.current = next;
			event.dataTransfer.setData("text/plain", agent.id);
			event.dataTransfer.effectAllowed = "move";
			setDrag(next);
		};
	}

	function resetDrag() {
		dragRef.current = undefined;
		setDrag(undefined);
	}

	function endDrag() {
		const current = dragRef.current;
		// Solto fora da área de fixados: desafixa.
		if (current?.pinned && !droppedInZone.current) {
			onUnpin(current.id);
		}
		resetDrag();
	}

	// Garante a limpeza do estado mesmo se a origem do drag desmontar (lista -> fixados).
	useEffect(() => {
		const handleDragEnd = () => {
			dragRef.current = undefined;
			setDrag(undefined);
		};
		window.addEventListener("dragend", handleDragEnd);
		return () => window.removeEventListener("dragend", handleDragEnd);
	}, []);

	function handleSidebarResizeStart(
		event: React.PointerEvent<HTMLButtonElement>,
	) {
		if (!sidebarOpen) return;
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = latestSidebarWidth.current ?? SIDEBAR_DEFAULT_WIDTH;
		let minimized = false;
		document.body.style.userSelect = "none";
		document.body.style.cursor = "ew-resize";

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
		const minimizeNow = () => {
			if (minimized) return;
			minimized = true;
			cleanup();
			// Restaura a largura válida para a próxima expansão e minimiza
			// na hora — mesmo estado do CTRL+B — sem esperar soltar o mouse.
			applySidebarWidth(startWidth);
			setSidebarOpen(false);
		};

		const onMove = (moveEvent: PointerEvent) => {
			if (minimized) return;
			const raw = startWidth + (moveEvent.clientX - startX);
			// Bateu no mínimo e continuou arrastando: minimiza imediatamente.
			if (raw < SIDEBAR_MIN_WIDTH) {
				minimizeNow();
				return;
			}
			const next = clampSidebarWidth(raw);
			latestSidebarWidth.current = next;
			applySidebarWidth(next);
		};
		const onUp = () => {
			if (minimized) return;
			cleanup();
			if (latestSidebarWidth.current !== null) {
				writeSidebarWidthCookie(latestSidebarWidth.current);
			}
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function resetSidebarWidth() {
		// Volta para o tamanho original do rail aberto (20rem / 320px).
		latestSidebarWidth.current = SIDEBAR_DEFAULT_WIDTH;
		applySidebarWidth(SIDEBAR_DEFAULT_WIDTH);
		writeSidebarWidthCookie(SIDEBAR_DEFAULT_WIDTH);
	}

	function handleSidebarExpandStart(
		event: React.PointerEvent<HTMLButtonElement>,
	) {
		event.preventDefault();
		const startX = event.clientX;
		const restoreWidth = latestSidebarWidth.current ?? SIDEBAR_DEFAULT_WIDTH;
		let expanded = false;
		let expandX = startX;
		document.body.style.userSelect = "none";
		document.body.style.cursor = "ew-resize";

		const cleanup = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
		const onMove = (moveEvent: PointerEvent) => {
			if (!expanded) {
				// Só expande puxando — clique sozinho não abre.
				if (moveEvent.clientX - startX > SIDEBAR_EXPAND_DRAG_PX) {
					expanded = true;
					expandX = moveEvent.clientX;
					// Abre já com folga e o resto da puxada controla a largura.
					latestSidebarWidth.current = SIDEBAR_EXPAND_WIDTH;
					applySidebarWidth(SIDEBAR_EXPAND_WIDTH);
					setSidebarOpen(true);
				}
				return;
			}
			const next = clampSidebarWidth(
				SIDEBAR_EXPAND_WIDTH + (moveEvent.clientX - expandX),
			);
			latestSidebarWidth.current = next;
			applySidebarWidth(next);
		};
		const onUp = () => {
			cleanup();
			if (expanded) {
				writeSidebarWidthCookie(latestSidebarWidth.current ?? restoreWidth);
			}
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	return (
		<Sidebar collapsible="icon">
			{sidebarOpen ? (
				<button
					aria-label={t("sidebar.resizeOrCollapse")}
					className="absolute inset-y-0 right-0 z-30 hidden w-1.5 cursor-ew-resize touch-none bg-transparent transition-colors hover:bg-sidebar-border md:block"
					onPointerDown={handleSidebarResizeStart}
					type="button"
				/>
			) : (
				<button
					aria-label={t("sidebar.dragToResize")}
					className="group/pull absolute inset-y-0 right-0 z-30 hidden w-4 cursor-ew-resize touch-none bg-transparent md:block"
					onPointerDown={handleSidebarExpandStart}
					title={t("sidebar.dragToControlSize")}
					type="button"
				>
					<span className="absolute inset-y-0 right-0 w-1.5 bg-transparent transition-colors group-hover/pull:bg-sidebar-border/60" />
				</button>
			)}
			{sidebarOpen ? (
				<SidebarHeader>
					<ChatSidebarHeader
						onQueryChange={setQuery}
						onStartCreate={onStartCreate}
						onStartCreateGroup={onStartCreateGroup}
						query={query}
					/>
				</SidebarHeader>
			) : null}

			<SidebarContent>
				{loading ? (
					<AgentsSkeleton />
				) : errorMode === "full" ? (
					sidebarOpen ? (
						<ListLoadError className="px-4" mode="full" onRetry={retryLoad} />
					) : (
						<Button aria-label={t("sidebar.loadError.retry")} className="mx-auto mt-4" onClick={retryLoad} size="icon" variant="ghost">
							<RefreshCwIcon />
						</Button>
					)
				) : agents.length === 0 ? (
					<div className="flex flex-1 items-center justify-center p-4">
						<Empty className="border-0 p-6">
							<EmptyHeader>
								<EmptyMedia>
									<AgentAvatar
										bodyColor="#fafafa"
										size={64}
										mood="neutre"
									/>
								</EmptyMedia>
								<EmptyTitle>{t("sidebar.empty.title")}</EmptyTitle>
							</EmptyHeader>
							<EmptyContent>
								<p className="text-muted-foreground text-sm">
									{t("sidebar.empty.body")}
								</p>
								<Button onClick={onStartCreate} size="sm">
									<PlusIcon />
									{t("sidebar.empty.cta")}
								</Button>
							</EmptyContent>
						</Empty>
					</div>
				) : (
					<>
						{errorMode === "banner" && sidebarOpen ? <ListLoadError className="mx-2 mt-2" mode="banner" onRetry={retryLoad} /> : null}
						{sidebarOpen && onOpenWork ? <ActiveWorkSidebarSection onOpenItem={onOpenWork} /> : null}
						<PinnedAgentsZone
							agents={pinned}
							drag={drag}
							menuActions={menuActions}
							sections={sections}
							onDragEnd={endDrag}
							onDragReset={resetDrag}
							onDropped={() => {
								droppedInZone.current = true;
							}}
							onPlacePinned={onPlacePinned}
							onSelect={onSelect}
							onStartDrag={startDrag}
						/>
						<AgentList
							activeId={activeId}
							agents={sidebarOpen ? listAgents : agents}
							menuActions={menuActions}
							sections={sections}
							sectionActions={sectionActions}
							onDragEnd={endDrag}
							onSelect={onSelect}
							onStartDrag={startDrag}
						/>
					</>
				)}
			</SidebarContent>

			<SidebarFooter>
				<ChatSidebarFooter
					onOpenMarketplace={onOpenMarketplace}
					onOpenSettings={onOpenSettings}
					onOpenAutonomy={onOpenAutonomy}
					onStartCreate={onStartCreate}
					onStartCreateGroup={onStartCreateGroup}
				/>
			</SidebarFooter>
		</Sidebar>
	);
}
