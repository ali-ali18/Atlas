"use client";

import { Fragment, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@workspace/ui/lib/utils";
import type { Section } from "@workspace/shared";

import type { Agent } from "../data";
import type { SidebarDrag } from "./chat-sidebar";
import { type AgentMenuActions, AgentContextMenu } from "./agent-context-menu";
import { PinnedBotButton } from "./pinned-bot-button";

export function PinnedAgentsZone({
	agents,
	drag,
	menuActions,
	sections = [],
	onDragEnd,
	onDragReset,
	onDropped,
	onPlacePinned,
	onSelect,
	onStartDrag,
}: {
	agents: Agent[];
	drag?: SidebarDrag;
	menuActions: AgentMenuActions;
	sections?: Section[];
	onDragEnd: () => void;
	onDragReset: () => void;
	onDropped: () => void;
	onPlacePinned: (id: string, index: number) => void;
	onSelect: (id: string) => void;
	onStartDrag: (agent: Agent) => (event: React.DragEvent) => void;
}) {
	const [over, setOver] = useState(false);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const itemRefs = useRef(new Map<string, HTMLDivElement>());
	const prevRects = useRef(new Map<string, DOMRect>());
	const overCount = useRef(0);

	const orderKey = agents.map((agent) => agent.id).join("|");
	const draggingId = drag?.id;

	function captureRects() {
		const next = new Map<string, DOMRect>();
		for (const [id, element] of itemRefs.current) {
			next.set(id, element.getBoundingClientRect());
		}
		return next;
	}

	// FLIP: anima os itens da posição antiga para a nova após reordenar.
	// biome-ignore lint/correctness/useExhaustiveDependencies: orderKey/dropIndex disparam o FLIP
	useLayoutEffect(() => {
		for (const [id, element] of itemRefs.current) {
			const before = prevRects.current.get(id);
			if (!before) continue;
			const after = element.getBoundingClientRect();
			const deltaX = before.left - after.left;
			const deltaY = before.top - after.top;
			if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
			element.animate(
				[
					{ transform: `translate(${deltaX}px, ${deltaY}px)` },
					{ transform: "translate(0, 0)" },
				],
				{ duration: 180, easing: "ease-out" },
			);
		}
		prevRects.current = captureRects();
	}, [orderKey, dropIndex]);

	function setItemRef(id: string) {
		return (element: HTMLDivElement | null) => {
			if (element) itemRefs.current.set(id, element);
			else itemRefs.current.delete(id);
		};
	}

	function computeIndex(clientX: number, clientY: number) {
		const entries: HTMLDivElement[] = [];
		for (const agent of agents) {
			const element = itemRefs.current.get(agent.id);
			if (element) entries.push(element);
		}
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (!entry) continue;
			const rect = entry.getBoundingClientRect();
			const centerX = rect.left + rect.width / 2;
			if (clientY < rect.top) return index;
			if (clientY <= rect.bottom && clientX < centerX) return index;
		}
		return entries.length;
	}

	function handleDragEnter() {
		overCount.current += 1;
		setOver(true);
	}

	function handleDragLeave() {
		overCount.current = Math.max(0, overCount.current - 1);
		if (overCount.current === 0) {
			setOver(false);
			setDropIndex(null);
		}
	}

	function handleDragOver(event: React.DragEvent) {
		event.preventDefault();
		if (!drag) return;
		const rawIndex = computeIndex(event.clientX, event.clientY);
		if (drag.pinned) {
			const from = agents.findIndex((agent) => agent.id === drag.id);
			const target = rawIndex > from ? rawIndex - 1 : rawIndex;
			if (from === -1 || target === from) return;
			prevRects.current = captureRects();
			onPlacePinned(drag.id, target);
			setDropIndex(null);
			return;
		}
		if (dropIndex !== rawIndex) {
			prevRects.current = captureRects();
			setDropIndex(rawIndex);
		}
	}
	function handleDrop(event: React.DragEvent) {
		event.preventDefault();
		onDropped();
		const id = event.dataTransfer.getData("text/plain") || drag?.id;
		const isPinned = Boolean(id) && agents.some((agent) => agent.id === id);
		if (id && !isPinned) {
			const index = dropIndex ?? computeIndex(event.clientX, event.clientY);
			prevRects.current = captureRects();
			onPlacePinned(id, index);
		}
		overCount.current = 0;
		setOver(false);
		setDropIndex(null);
		onDragReset();
	}

	const showGhost = Boolean(drag && !drag.pinned);
	const ghost = (
		<div
			aria-hidden
			className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-sidebar-ring/60 bg-sidebar-accent/20 p-1.5"
		>
			<span className="size-16 rounded-full bg-sidebar-accent/50" />
			<span className="h-3 w-14 rounded bg-sidebar-accent/50" />
			<span className="h-3.5 w-16 rounded-full bg-sidebar-accent/50" />
		</div>
	);

	// Sem fixados e sem arrasto em andamento: não renderiza nada feio.
	// A zona de drop aparece sozinha quando um arrasto começa (showGhost).
	if (agents.length === 0 && !showGhost) {
		return null;
	}

	// biome-ignore lint/a11y/noStaticElementInteractions: área de drop para fixar/reordenar bots
	return (
		<div className="@container">
		<div
			className={cn(
				"mx-2 grid min-h-16 grid-cols-3 gap-2 rounded-xl border border-dashed border-transparent p-1 transition-colors group-data-[collapsible=icon]:hidden @max-[300px]:grid-cols-2",
				over && "border-sidebar-border bg-sidebar-accent/60",
			)}
			data-pin-drop
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		>
			{agents.map((agent, index) => (
				<Fragment key={agent.id}>
					{showGhost && dropIndex === index ? ghost : null}
					<AgentContextMenu
						agent={agent}
						actions={menuActions}
						sections={sections}
					>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: item arrastável para reordenar */}
					<div
						className={cn(
							"cursor-grab active:cursor-grabbing",
							draggingId === agent.id && "opacity-40",
						)}
						draggable
						onDragEnd={onDragEnd}
						onDragStart={onStartDrag(agent)}
						ref={setItemRef(agent.id)}
					>
						<PinnedBotButton
							agent={agent}
							onSelect={() => onSelect(agent.id)}
						/>
					</div>
					</AgentContextMenu>
				</Fragment>
			))}
			{showGhost && dropIndex !== null && dropIndex >= agents.length
				? ghost
				: null}
		</div>
		</div>
	);
}
