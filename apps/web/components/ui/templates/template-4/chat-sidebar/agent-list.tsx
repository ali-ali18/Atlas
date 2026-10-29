"use client";

import { Fragment, useState } from "react";

import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronDownIcon,
	PencilIcon,
	Trash2Icon,
	UsersIcon,
} from "lucide-react";

import type { Section } from "@workspace/shared";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@workspace/ui/components/context-menu";
import { Input } from "@workspace/ui/components/input";
import { Separator } from "@workspace/ui/components/separator";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@workspace/ui/components/hover-card";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@workspace/ui/components/sidebar";
import { cn } from "@workspace/ui/lib/utils";

import { useLocale } from "@/lib/i18n/provider";
import { rowTime } from "@/lib/list-time";
import { useListNow } from "@/lib/use-list-now";
import type { Agent } from "../data";
import { AgentAvatars } from "./agent-avatars";
import { type AgentMenuActions, AgentContextMenu } from "./agent-context-menu";

export type SectionActions = {
	onRenameSection: (id: string, name: string) => void;
	onDeleteSection: (id: string) => void;
	onMoveSection: (id: string, direction: "up" | "down") => void;
};

const UNCATEGORIZED_KEY = "__sem-sessao";

function sortSections(sections: Section[]): Section[] {
	return [...sections].sort((a, b) => a.order - b.order);
}

function stripMarkdownPreview(text: string): string {
	return (
		text
			// code fences e inline code (mantém o conteúdo)
			.replace(/```[\s\S]*?```/g, (block) =>
				block.replace(/```\w*\n?|\n?```/g, " "),
			)
			.replace(/`([^`]*)`/g, "$1")
			// imagens e links (mantém o texto)
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// negrito / itálico / riscado (mantém o conteúdo)
			.replace(/(\*\*|__)(.*?)\1/g, "$2")
			.replace(/(^|\W)\*(?!\s)(.*?)(?<!\s)\*(?!\w)/g, "$1$2")
			.replace(/(^|\W)_(?!\s)(.*?)(?<!\s)_(?!\w)/g, "$1$2")
			.replace(/~~(.*?)~~/g, "$1")
			// títulos, citações, listas, divisórias
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^>\s?/gm, "")
			.replace(/^(\s*[-*+]|\s*\d+[.)])\s+/gm, "")
			.replace(/^([-*_]){3,}\s*$/gm, "")
			// colapsa espaços e quebras
			.replace(/\s+/g, " ")
			.trim()
	);
}

function AgentHoverPreview({
	agent,
	agents,
}: {
	agent: Agent;
	agents: Agent[];
}) {
	return (
		<>
			<span className="flex items-center gap-2.5">
				<AgentAvatars agent={agent} agents={agents} size={40} />
				<p className="min-w-0 flex-1 truncate font-medium text-sm">
					{agent.name}
				</p>
			</span>
			<p className="mt-2 line-clamp-2 text-muted-foreground text-xs leading-relaxed">
				{agent.lastMessage?.trim()
					? stripMarkdownPreview(agent.lastMessage)
					: "Nenhuma mensagem ainda"}
			</p>
		</>
	);
}

function AgentRow({
	activeId,
	agent,
	agents,
	menuActions,
	sections,
	onDragEnd,
	onSelect,
	onStartDrag,
}: {
	activeId: string;
	agent: Agent;
	agents: Agent[];
	menuActions: AgentMenuActions;
	sections: Section[];
	onDragEnd: () => void;
	onSelect: (id: string) => void;
	onStartDrag: (agent: Agent) => (event: React.DragEvent) => void;
}) {
	const timeLabel = rowTime(agent, useListNow(), useLocale());
	return (
		<SidebarMenuItem key={agent.id}>
			<AgentContextMenu
				agent={agent}
				actions={menuActions}
				sections={sections}
			>
				<HoverCard>
					<SidebarMenuButton
						className="h-auto cursor-grab items-center gap-2.5 px-1.5 py-1.5 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:data-active:bg-transparent active:cursor-grabbing"
						draggable
						isActive={agent.id === activeId}
						onClick={() => onSelect(agent.id)}
						onDragEnd={onDragEnd}
						onDragStart={onStartDrag(agent)}
						render={<HoverCardTrigger />}
					>
						<span className="shrink-0">
							<AgentAvatars agent={agent} agents={agents} />
						</span>
						<span className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
							<span className="flex items-center justify-between gap-2">
								<span className="flex min-w-0 items-center gap-1.5">
									<span className={`truncate text-sm ${agent.notifications ? "font-semibold" : "font-medium"}`}>
										{agent.name}
									</span>
									{agent.members?.length ? (
										<span
											className="flex shrink-0 items-center gap-0.5 text-caption text-sidebar-foreground/50"
											data-testid="group-count"
											title={`${agent.members.length} bots no grupo`}
										>
											<UsersIcon className="size-3" />
											{agent.members.length}
										</span>
									) : null}
								</span>
								{timeLabel ? (
									<span className="shrink-0 text-caption text-sidebar-foreground/50">
										{timeLabel}
									</span>
								) : null}
							</span>
							<span className="truncate text-sidebar-foreground/60 text-xs">
								{agent.lastMessage?.trim()
									? stripMarkdownPreview(agent.lastMessage)
									: "Nenhuma mensagem ainda"}
							</span>
						</span>
					</SidebarMenuButton>
					<HoverCardContent className="w-60 p-3" side="right" sideOffset={12}>
						<AgentHoverPreview agent={agent} agents={agents} />
					</HoverCardContent>
				</HoverCard>
			</AgentContextMenu>
		</SidebarMenuItem>
	);
}

function SectionNameInput({
	initial,
	onCancel,
	onCommit,
}: {
	initial: string;
	onCancel: () => void;
	onCommit: (name: string) => void;
}) {
	// O fechamento do menu pode roubar o foco e causar um blur imediato:
	// só confirma se o texto foi alterado; senão, apenas fecha.
	const [dirty, setDirty] = useState(false);
	return (
		<Input
			aria-label="Nome da sessão"
			autoFocus
			className="h-6 rounded-md border-transparent bg-transparent px-1.5 text-xs shadow-none outline-none focus-visible:border-transparent focus-visible:ring-0"
			defaultValue={initial}
			onChange={() => setDirty(true)}
			onBlur={(event) => {
				if (dirty) onCommit(event.currentTarget.value);
				else onCancel();
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
				if (event.key === "Escape") onCancel();
			}}
		/>
	);
}

function SectionBlock({
	title,
	open,
	onOpenChange,
	renaming,
	onStartRename,
	onCommitRename,
	onCancelRename,
	onDelete,
	onMoveUp,
	onMoveDown,
	canMoveUp,
	canMoveDown,
	menu,
	children,
}: {
	title: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	renaming: boolean;
	onStartRename: () => void;
	onCommitRename: (name: string) => void;
	onCancelRename: () => void;
	onDelete: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	canMoveUp: boolean;
	canMoveDown: boolean;
	menu: boolean;
	children: React.ReactNode;
}) {
	const header = (
		<CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-sidebar-foreground/60 transition-colors outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring">
			<ChevronDownIcon
				className={cn(
					"size-3.5 shrink-0 transition-transform duration-200",
					!open && "-rotate-90",
				)}
			/>
			<span className="min-w-0 flex-1 truncate">{title}</span>
		</CollapsibleTrigger>
	);
	return (
		<Collapsible open={open} onOpenChange={onOpenChange}>
			<div className="group/section flex h-8 items-center gap-0.5">
				{renaming ? (
					<div className="flex min-w-0 flex-1 items-center px-1.5 py-1">
						<SectionNameInput
							initial={title}
							onCancel={onCancelRename}
							onCommit={onCommitRename}
						/>
					</div>
				) : menu ? (
					<ContextMenu>
						<ContextMenuTrigger
							className="flex min-w-0 flex-1 outline-none"
							render={<div />}
						>
							{header}
						</ContextMenuTrigger>
						<ContextMenuContent align="start" side="right" sideOffset={8}>
							<ContextMenuItem onClick={onStartRename}>
								<PencilIcon />
								Renomear
							</ContextMenuItem>
							<ContextMenuItem disabled={!canMoveUp} onClick={onMoveUp}>
								<ArrowUpIcon />
								Mover para cima
							</ContextMenuItem>
							<ContextMenuItem disabled={!canMoveDown} onClick={onMoveDown}>
								<ArrowDownIcon />
								Mover para baixo
							</ContextMenuItem>
							<ContextMenuSeparator />
							<ContextMenuItem onClick={onDelete} variant="destructive">
								<Trash2Icon />
								Excluir
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
				) : (
					header
				)}
			</div>
			<CollapsibleContent>
				<SidebarMenu>{children}</SidebarMenu>
			</CollapsibleContent>
		</Collapsible>
	);
}

export function AgentList({
	activeId,
	agents,
	menuActions,
	sections,
	sectionActions,
	onDragEnd,
	onSelect,
	onStartDrag,
}: {
	activeId: string;
	agents: Agent[];
	menuActions: AgentMenuActions;
	sections: Section[];
	sectionActions: SectionActions;
	onDragEnd: () => void;
	onSelect: (id: string) => void;
	onStartDrag: (agent: Agent) => (event: React.DragEvent) => void;
}) {
	const { open } = useSidebar();
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const [renamingId, setRenamingId] = useState<string | null>(null);

	const orderedSections = sortSections(sections);

	function isOpen(key: string) {
		return !collapsed[key];
	}

	function setSectionOpen(key: string, next: boolean) {
		setCollapsed((previous) => ({ ...previous, [key]: !next }));
	}

	// Rail minimizado: o SidebarMenuButton colapsado (size-8, overflow-hidden)
	// esmagaria os avatares — botões maiores com respiro, como na referência.
	// Fixados vêm primeiro, com divisória marcando onde cada bloco
	// começa e termina. Sessões aparecem como grupos separados por divisórias.
	if (!open) {
		const pinnedAgents = agents
			.filter((agent) => agent.pinned)
			.sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
		const unpinnedAgents = agents.filter((agent) => !agent.pinned);
		const knownIds = new Set(orderedSections.map((section) => section.id));
		const groups = orderedSections
			.map((section) => ({
				key: section.id,
				agents: unpinnedAgents.filter(
					(agent) => agent.sectionId === section.id,
				),
			}))
			.filter((group) => group.agents.length > 0);
		const loose = unpinnedAgents.filter(
			(agent) => !agent.sectionId || !knownIds.has(agent.sectionId),
		);
		if (loose.length > 0) {
			groups.push({ key: UNCATEGORIZED_KEY, agents: loose });
		}
		const renderRailButton = (agent: Agent) => (
			<AgentContextMenu
				agent={agent}
				actions={menuActions}
				sections={orderedSections}
				key={agent.id}
			>
				<HoverCard>
					<HoverCardTrigger
						className="grid size-15 cursor-grab place-items-center rounded-2xl transition-colors hover:bg-sidebar-accent/60 active:cursor-grabbing"
						render={
							<button
								draggable
								onClick={() => onSelect(agent.id)}
								onDragEnd={onDragEnd}
								onDragStart={onStartDrag(agent)}
								type="button"
							/>
						}
					>
						<AgentAvatars agent={agent} agents={agents} size={48} />
					</HoverCardTrigger>
					<HoverCardContent className="w-60 p-3" side="right" sideOffset={12}>
						<AgentHoverPreview agent={agent} agents={agents} />
					</HoverCardContent>
				</HoverCard>
			</AgentContextMenu>
		);
		return (
			<div className="mt-10 flex flex-col items-center gap-2 py-1">
				{pinnedAgents.map(renderRailButton)}
				{pinnedAgents.length > 0 && groups.length > 0 ? (
					<Separator className="w-8 rounded-full bg-sidebar-border" />
				) : null}
				{groups.map((group, index) => (
					<Fragment key={group.key}>
						{index > 0 ? (
							<Separator className="w-8 rounded-full bg-sidebar-border" />
						) : null}
						{group.agents.map(renderRailButton)}
					</Fragment>
				))}
			</div>
		);
	}

	const knownIds = new Set(orderedSections.map((section) => section.id));
	const rowsBySection = new Map<string, Agent[]>();
	for (const agent of agents) {
		const key =
			agent.sectionId && knownIds.has(agent.sectionId)
				? agent.sectionId
				: UNCATEGORIZED_KEY;
		const rows = rowsBySection.get(key);
		if (rows) rows.push(agent);
		else rowsBySection.set(key, [agent]);
	}

	function renderRows(list: Agent[]) {
		return list.map((agent) => (
			<AgentRow
				key={agent.id}
				activeId={activeId}
				agent={agent}
				agents={agents}
				menuActions={menuActions}
				sections={orderedSections}
				onDragEnd={onDragEnd}
				onSelect={onSelect}
				onStartDrag={onStartDrag}
			/>
		));
	}

	type Block = { key: string; node: React.ReactNode };
	const blocks: Block[] = orderedSections.map((section, index) => {
		const rows = rowsBySection.get(section.id) ?? [];
		return {
			key: section.id,
			node: (
				<SectionBlock
					title={section.name}
					open={isOpen(section.id)}
					onOpenChange={(next) => setSectionOpen(section.id, next)}
					renaming={renamingId === section.id}
					onStartRename={() => setRenamingId(section.id)}
					onCommitRename={(name) => {
						setRenamingId(null);
						sectionActions.onRenameSection(section.id, name);
					}}
					onCancelRename={() => setRenamingId(null)}
					onDelete={() => sectionActions.onDeleteSection(section.id)}
					onMoveUp={() => sectionActions.onMoveSection(section.id, "up")}
					onMoveDown={() => sectionActions.onMoveSection(section.id, "down")}
					canMoveUp={index > 0}
					canMoveDown={index < orderedSections.length - 1}
					menu
				>
					{rows.length > 0 ? (
						renderRows(rows)
					) : (
						<p className="px-3 py-1 text-caption text-sidebar-foreground/40">
							Nenhum bot nesta sessão
						</p>
					)}
				</SectionBlock>
			),
		};
	});
	const loose = rowsBySection.get(UNCATEGORIZED_KEY) ?? [];
	if (loose.length > 0) {
		blocks.push({
			key: UNCATEGORIZED_KEY,
			node: (
				<SectionBlock
					title="Sem sessão"
					open={isOpen(UNCATEGORIZED_KEY)}
					onOpenChange={(next) => setSectionOpen(UNCATEGORIZED_KEY, next)}
					renaming={false}
					onStartRename={() => undefined}
					onCommitRename={() => undefined}
					onCancelRename={() => undefined}
					onDelete={() => undefined}
					onMoveUp={() => undefined}
					onMoveDown={() => undefined}
					canMoveUp={false}
					canMoveDown={false}
					menu={false}
				>
					{renderRows(loose)}
				</SectionBlock>
			),
		});
	}

	return (
		<SidebarGroup>
			<SidebarGroupContent>
				<div className="flex flex-col">
					{blocks.map((block) => (
						<Fragment key={block.key}>{block.node}</Fragment>
					))}
				</div>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}
