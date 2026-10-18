"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	ArrowLeftIcon,
	CheckIcon,
	FolderMinusIcon,
	FolderPlusIcon,
	ListFilterIcon,
	MoreHorizontalIcon,
	PlusIcon,
	SearchIcon,
	StoreIcon,
	UsersIcon,
} from "lucide-react";
import type { Section } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@workspace/ui/components/input-group";
import {
	Sheet,
	SheetContent,
	SheetTitle,
} from "@workspace/ui/components/sheet";
import { authClient } from "@/lib/auth-client";
import { rowTime } from "@/lib/list-time";
import { useListNow } from "@/lib/use-list-now";
import { signOutAndRedirect } from "@/lib/sign-out";
import { AgentAvatar } from "./agent-avatar";
import { AvatarStatus } from "./avatar-status";
import type { AgentMenuActions } from "./chat-sidebar/agent-context-menu";
import type { SectionActions } from "./chat-sidebar/agent-list";
import { UserAvatar } from "./chat-sidebar/chat-sidebar-footer";
import { NewChatMenu } from "./chat-sidebar/new-chat-menu";
import { GroupAvatar, resolveGroupMembers } from "./group-avatar";
import { copyText } from "./chat-thread/message-reactions";
import type { Agent } from "./data";
import { ActiveWorkMobileRow } from "@/components/ai-elements/dev-session/active-work";
import type { ActiveWorkItemResponse } from "@/lib/atlas-api";
import { ListLoadError, listErrorMode } from "./list-load-error";
import {
	type AccountMenuItemId,
	type BotActionId,
	type SectionActionId,
	accountMenuItems,
	botActionItems,
	createLongPress,
	sectionActionItems,
	sectionChoices,
} from "./mobile-home-menus";

/** Handlers de toque/clique comuns às linhas: tap abre, long-press ou botão direito abre o menu. */
function useBotPress(onOpen: () => void, onMenu: () => void) {
	const latest = useRef({ onOpen, onMenu });
	latest.current = { onOpen, onMenu };
	const press = useMemo(
		() => createLongPress(() => latest.current.onMenu()),
		[],
	);
	useEffect(() => () => press.cancel(), [press]);
	return {
		onClick: () => {
			if (press.consumeFired()) return;
			latest.current.onOpen();
		},
		onContextMenu: (event: React.MouseEvent) => {
			event.preventDefault();
			latest.current.onMenu();
		},
		onTouchCancel: () => press.cancel(),
		onTouchEnd: () => press.cancel(),
		onTouchMove: (event: React.TouchEvent) => {
			const touch = event.touches[0];
			if (touch) press.move(touch.clientX, touch.clientY);
		},
		onTouchStart: (event: React.TouchEvent) => {
			const touch = event.touches[0];
			if (touch) press.start(touch.clientX, touch.clientY);
		},
	};
}

const PRESS_CLASS =
	"touch-manipulation select-none [-webkit-touch-callout:none]";

/** Nome da sessão em edição: Enter/blur salva, Esc cancela, vazio cancela. */
function SectionNameField({
	initial,
	onCancel,
	onCommit,
}: {
	initial: string;
	onCancel: () => void;
	onCommit: (name: string) => void;
}) {
	const done = useRef(false);
	function finish(value: string) {
		if (done.current) return;
		done.current = true;
		const trimmed = value.trim();
		if (!trimmed || trimmed === initial) onCancel();
		else onCommit(trimmed);
	}
	return (
		<input
			aria-label="Nome da sessão"
			autoFocus
			className="mb-1 h-11 w-full rounded-xl border border-border bg-card px-3 text-base font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
			defaultValue={initial}
			enterKeyHint="done"
			maxLength={60}
			onBlur={(event) => finish(event.currentTarget.value)}
			onFocus={(event) => event.currentTarget.select()}
			onKeyDown={(event) => {
				if (event.key === "Enter") finish(event.currentTarget.value);
				if (event.key === "Escape") {
					done.current = true;
					onCancel();
				}
			}}
		/>
	);
}

/** Título de sessão: sem seleção de texto; long-press ou botão "⋯" abre as ações. */
export function MobileSectionHeader({
	name,
	renaming,
	onMenu,
	onCommitRename,
	onCancelRename,
}: {
	name: string;
	renaming: boolean;
	onMenu: () => void;
	onCommitRename: (name: string) => void;
	onCancelRename: () => void;
}) {
	const latest = useRef(onMenu);
	latest.current = onMenu;
	const press = useMemo(() => createLongPress(() => latest.current()), []);
	useEffect(() => () => press.cancel(), [press]);
	if (renaming) {
		return (
			<SectionNameField initial={name} onCancel={onCancelRename} onCommit={onCommitRename} />
		);
	}
	return (
		<div className={`mb-1 flex min-h-11 items-center gap-1 ${PRESS_CLASS}`}>
			<h2
				className={`min-w-0 flex-1 truncate py-2 text-sm font-medium text-muted-foreground ${PRESS_CLASS}`}
				onContextMenu={(event) => {
					event.preventDefault();
					onMenu();
				}}
				onTouchCancel={() => press.cancel()}
				onTouchEnd={() => press.cancel()}
				onTouchMove={(event) => {
					const touch = event.touches[0];
					if (touch) press.move(touch.clientX, touch.clientY);
				}}
				onTouchStart={(event) => {
					const touch = event.touches[0];
					if (touch) press.start(touch.clientX, touch.clientY);
				}}
			>
				{name}
			</h2>
			<button
				aria-label={`Ações da sessão ${name}`}
				className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground active:bg-card/60"
				onClick={onMenu}
				type="button"
			>
				<MoreHorizontalIcon className="size-5" />
			</button>
		</div>
	);
}

/** Avatar da linha: o do bot, ou os dos membros empilhados quando é um grupo. */
function RowAvatar({ agent, agents, size }: { agent: Agent; agents: readonly Agent[]; size: number }) {
	if (agent.members?.length) {
		return (
			<AvatarStatus botId={agent.id} label="Grupo" size={size} unread={agent.notifications}>
				<GroupAvatar members={resolveGroupMembers(agent, agents)} ringClassName="ring-background" size={size} />
			</AvatarStatus>
		);
	}
	return (
		<AvatarStatus botId={agent.id} primary={agent.isPrimary} size={size} unread={agent.notifications}>
			<AgentAvatar bodyColor={agent.color} shape={agent.shape} size={size} mood="neutre" />
		</AvatarStatus>
	);
}

export function MobileBotRow({
	agent,
	agents = [],
	onOpen,
	onMenu,
}: {
	agent: Agent;
	/** Todos os bots (para desenhar os membros de um grupo). */
	agents?: readonly Agent[];
	onOpen: () => void;
	onMenu: () => void;
}) {
	const handlers = useBotPress(onOpen, onMenu);
	const timeLabel = rowTime(agent, useListNow());
	return (
		<button
			className={`flex min-h-[4.5rem] w-full items-center gap-3 rounded-2xl py-3 text-left active:bg-card/60 ${PRESS_CLASS}`}
			type="button"
			{...handlers}
		>
			<RowAvatar agent={agent} agents={agents} size={52} />
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline justify-between gap-2">
					<span className="flex min-w-0 items-center gap-1.5">
						<span className={`truncate ${agent.notifications ? "font-semibold" : "font-medium"}`}>{agent.name}</span>
						{agent.members?.length ? (
							<span className="flex shrink-0 items-center gap-0.5 text-muted-foreground text-xs" data-testid="group-count">
								<UsersIcon className="size-3.5" />
								{agent.members.length}
							</span>
						) : null}
					</span>
					{timeLabel ? (
						<span className="shrink-0 text-xs text-muted-foreground">
							{timeLabel}
						</span>
					) : null}
				</span>
				<span className="mt-1 flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
						{agent.lastMessage?.trim() || "Nenhuma mensagem ainda"}
					</span>
				</span>
			</span>
		</button>
	);
}

function MobilePinnedChip({
	agent,
	agents = [],
	onOpen,
	onMenu,
}: {
	agent: Agent;
	agents?: readonly Agent[];
	onOpen: () => void;
	onMenu: () => void;
}) {
	const handlers = useBotPress(onOpen, onMenu);
	return (
		<button
			className={`flex min-h-11 w-24 shrink-0 flex-col items-center gap-2 text-center ${PRESS_CLASS}`}
			type="button"
			{...handlers}
		>
			<RowAvatar agent={agent} agents={agents} size={72} />
			<span className={`w-full truncate text-sm ${agent.notifications ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
				{agent.name}
			</span>
		</button>
	);
}

export function MobileChatList({
	agents,
	sections,
	loading,
	loadError = false,
	onRetryLoad,
	onSelect,
	onStartCreate,
	onStartCreateGroup,
	onOpenMarketplace,
	onOpenSettings,
	onOpenProviders,
	onOpenAutonomy,
	onOpenWork,
	menuActions,
	sectionActions,
}: {
	/** Abre o item de "Em andamento": navega para a conversa e abre o painel. */
	onOpenWork?: (item: ActiveWorkItemResponse) => void;
	agents: Agent[];
	sections: Section[];
	loading: boolean;
	/** A lista não carregou/atualizou: erro (nunca "nenhuma conversa") ou faixa sobre a última lista. */
	loadError?: boolean;
	onRetryLoad?: () => void;
	onSelect: (id: string) => void;
	onStartCreate: () => void;
	onStartCreateGroup: () => void;
	onOpenMarketplace: () => void;
	onOpenSettings: () => void;
	onOpenProviders: () => void;
	onOpenAutonomy: () => void;
	menuActions: AgentMenuActions;
	sectionActions?: SectionActions;
}) {
	const errorMode = listErrorMode({ loadError, loading, count: agents.length });
	const [sectionMenuId, setSectionMenuId] = useState<string | null>(null);
	const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
	const sectionMenu = sections.find((section) => section.id === sectionMenuId);
	function runSectionAction(id: SectionActionId) {
		if (!sectionMenu || !sectionActions) return;
		setSectionMenuId(null);
		if (id === "rename") setRenamingSectionId(sectionMenu.id);
		else if (id === "move-up") sectionActions.onMoveSection(sectionMenu.id, "up");
		else if (id === "move-down") sectionActions.onMoveSection(sectionMenu.id, "down");
		else sectionActions.onDeleteSection(sectionMenu.id);
	}
	const [menuAgentId, setMenuAgentId] = useState<string | null>(null);
	const [menuStep, setMenuStep] = useState<"actions" | "sections">("actions");
	const [logoutError, setLogoutError] = useState("");
	const menuAgent = agents.find((agent) => agent.id === menuAgentId);

	function openBotMenu(id: string) {
		setMenuStep("actions");
		setMenuAgentId(id);
	}
	function runBotAction(id: BotActionId) {
		if (!menuAgent) return;
		if (id === "move") {
			setMenuStep("sections");
			return;
		}
		setMenuAgentId(null);
		if (id === "open") onSelect(menuAgent.id);
		else if (id === "edit") menuActions.onEdit(menuAgent.id);
		else if (id === "pin") menuActions.onPin(menuAgent.id);
		else if (id === "unpin") menuActions.onUnpin(menuAgent.id);
		else if (id === "mark-read") menuActions.onMarkUnread(menuAgent.id, false);
		else if (id === "mark-unread") menuActions.onMarkUnread(menuAgent.id, true);
		else if (id === "copy-id")
			void copyText(menuAgent.conversationId ?? menuAgent.id);
		else if (id === "hide") menuActions.onHide(menuAgent.id);
		else if (id === "delete") menuActions.onDelete(menuAgent.id);
		else if (id === "set-primary") menuActions.onSetPrimary(menuAgent.id);
		else if (id === "replace-primary") menuActions.onReplacePrimary();
	}
	function runAccountAction(id: AccountMenuItemId) {
		if (id === "settings") onOpenSettings();
		else if (id === "marketplace") onOpenMarketplace();
		else if (id === "providers") onOpenProviders();
		else if (id === "autonomy") onOpenAutonomy();
		else {
			setLogoutError("");
			void signOutAndRedirect().then((failure) => {
				if (failure) setLogoutError(failure);
			});
		}
	}

	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const { data: session } = authClient.useSession();
	const userName = session?.user.name || session?.user.email || "Conta";
	useEffect(() => {
		if (searchOpen) searchInputRef.current?.focus();
	}, [searchOpen]);

	function closeSearch() {
		setQuery("");
		setSearchOpen(false);
	}
	const filtered = useMemo(
		() =>
			agents.filter((agent) =>
				agent.name
					.toLocaleLowerCase()
					.includes(query.trim().toLocaleLowerCase()),
			),
		[agents, query],
	);
	const pinned = filtered
		.filter((agent) => agent.pinned)
		.sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
	const unpinned = filtered.filter((agent) => !agent.pinned);
	const groups = [...sections]
		.sort((a, b) => a.order - b.order)
		.map((section) => ({
			id: section.id,
			name: section.name,
			agents: unpinned.filter((agent) => agent.sectionId === section.id),
		}));
	groups.push({
		id: "unassigned",
		name: "Sem sessão",
		agents: unpinned.filter(
			(agent) =>
				!agent.sectionId ||
				!sections.some((section) => section.id === agent.sectionId),
		),
	});

	return (
		<div className="relative flex h-dvh min-w-0 flex-1 flex-col overflow-x-hidden bg-background md:hidden">
			<header className="z-10 shrink-0 bg-background px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
				<div className="flex min-h-11 items-center gap-3">
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label={`Menu da conta de ${userName}`}
							className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<UserAvatar
								image={session?.user.image}
								email={session?.user.email}
								name={session?.user.name}
								seed={session?.user.email || userName}
								size="large"
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="min-w-56">
							<DropdownMenuGroup>
								<DropdownMenuLabel className="truncate">
									{userName}
								</DropdownMenuLabel>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
							{(["main", "session"] as const).map((group) => (
								<DropdownMenuGroup key={group}>
									{group === "session" ? <DropdownMenuSeparator /> : null}
									{accountMenuItems()
										.filter((item) => item.group === group)
										.map((item) => (
											<DropdownMenuItem
												className="min-h-11"
												key={item.id}
												onClick={() => runAccountAction(item.id)}
											>
												<item.icon /> {item.label}
											</DropdownMenuItem>
										))}
								</DropdownMenuGroup>
							))}
							{logoutError ? (
								<p className="px-2 py-1 text-xs text-destructive" role="alert">
									{logoutError}
								</p>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					<h1 className="min-w-0 flex-1 truncate text-xl font-semibold">
						Conversas
					</h1>
					<div className="flex shrink-0 gap-2">
						<Button
							aria-label="Buscar conversas"
							className="size-11 rounded-full bg-card hover:bg-card/90"
							onClick={() => setSearchOpen(true)}
							size="icon"
							variant="secondary"
						>
							<SearchIcon className="size-5" />
						</Button>
						<NewChatMenu
							itemClassName="min-h-11"
							onNewBot={onStartCreate}
							onNewGroup={onStartCreateGroup}
							trigger={
								<Button aria-label="Novo bot ou grupo" className="size-11 rounded-full" size="icon">
									<PlusIcon className="size-6" />
								</Button>
							}
						/>
					</div>
				</div>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
				{loading ? (
					<p className="py-10 text-center text-sm text-muted-foreground">
						Carregando conversas…
					</p>
				) : null}
				{errorMode !== "none" ? <ListLoadError mode={errorMode} onRetry={() => onRetryLoad?.()} /> : null}
				{!loading && !loadError && agents.length === 0 ? (
					<div className="py-16 text-center">
						<p className="font-medium">Nenhuma conversa ainda</p>
						<p className="mt-1 text-sm text-muted-foreground">
							Crie um agente para começar.
						</p>
						<Button className="mt-5 min-h-11" onClick={onStartCreate}>
							<PlusIcon /> Criar agente
						</Button>
					</div>
				) : null}
				{!loading && onOpenWork ? <ActiveWorkMobileRow onOpenItem={onOpenWork} /> : null}
				{pinned.length > 0 ? (
					<section aria-label="Agentes fixados" className="mb-7">
						<div className="-mx-5 flex gap-4 overflow-x-auto px-5 pb-2">
							{pinned.map((agent) => (
								<MobilePinnedChip
									agent={agent}
									agents={agents}
									key={agent.id}
									onMenu={() => openBotMenu(agent.id)}
									onOpen={() => onSelect(agent.id)}
								/>
							))}
						</div>
					</section>
				) : null}
				{groups
					.filter((group) => group.agents.length > 0)
					.map((group) => (
						<section className="mb-6" key={group.id}>
							{group.id !== "unassigned" && sectionActions ? (
								<MobileSectionHeader
									name={group.name}
									onCancelRename={() => setRenamingSectionId(null)}
									onCommitRename={(name) => {
										setRenamingSectionId(null);
										sectionActions.onRenameSection(group.id, name);
									}}
									onMenu={() => setSectionMenuId(group.id)}
									renaming={renamingSectionId === group.id}
								/>
							) : (
								<h2 className={`mb-1 text-sm font-medium text-muted-foreground ${PRESS_CLASS}`}>
									{group.name}
								</h2>
							)}
							<div>
								{group.agents.map((agent) => (
									<MobileBotRow
										agent={agent}
										agents={agents}
										key={agent.id}
										onMenu={() => openBotMenu(agent.id)}
										onOpen={() => onSelect(agent.id)}
									/>
								))}
							</div>
						</section>
					))}
				<Button
					className="min-h-11 w-full justify-start"
					onClick={onOpenMarketplace}
					variant="ghost"
				>
					<StoreIcon /> Explorar agentes
				</Button>
			</main>
			<Sheet
				onOpenChange={(open) => {
					if (!open) setMenuAgentId(null);
				}}
				open={menuAgent !== undefined}
			>
				<SheetContent
					className="rounded-t-3xl pb-[max(2rem,env(safe-area-inset-bottom))]"
					showCloseButton={false}
					side="bottom"
				>
					<SheetTitle className="truncate px-5 pt-5 pb-2 text-base font-semibold">
						{menuAgent
							? menuStep === "sections"
								? "Trocar de sessão"
								: menuAgent.name
							: ""}
					</SheetTitle>
					{menuAgent && menuStep === "actions" ? (
						<ul className="max-h-[70dvh] overflow-y-auto px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
							{botActionItems(menuAgent, { canPickPrimary: menuActions.canPickPrimary }).map((item) => (
								<li key={item.id}>
									<button
										className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base active:bg-muted ${
											item.destructive ? "text-destructive" : ""
										}`}
										onClick={() => runBotAction(item.id)}
										type="button"
									>
										<item.icon className="size-5 shrink-0" />
										{item.label}
									</button>
								</li>
							))}
						</ul>
					) : null}
					{menuAgent && menuStep === "sections" ? (
						<ul className="max-h-[70dvh] overflow-y-auto px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
							<li>
								<button
									className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base active:bg-muted"
									onClick={() => {
										setMenuAgentId(null);
										menuActions.onCreateSectionFor(menuAgent.id);
									}}
									type="button"
								>
									<FolderPlusIcon className="size-5 shrink-0" /> Nova sessão…
								</button>
							</li>
							{sectionChoices(menuAgent, sections).map((choice) => (
								<li key={choice.id ?? "none"}>
									<button
										className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base active:bg-muted"
										onClick={() => {
											setMenuAgentId(null);
											menuActions.onMoveToSection(menuAgent.id, choice.id);
										}}
										type="button"
									>
										{choice.id === null ? (
											<FolderMinusIcon className="size-5 shrink-0" />
										) : null}
										<span className="min-w-0 flex-1 truncate">
											{choice.label}
										</span>
										{choice.current ? <CheckIcon className="size-5 shrink-0" /> : null}
									</button>
								</li>
							))}
							<li>
								<button
									className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base text-muted-foreground active:bg-muted"
									onClick={() => setMenuStep("actions")}
									type="button"
								>
									<ArrowLeftIcon className="size-5 shrink-0" /> Voltar
								</button>
							</li>
						</ul>
					) : null}
				</SheetContent>
			</Sheet>
			<Sheet
				onOpenChange={(open) => {
					if (!open) setSectionMenuId(null);
				}}
				open={sectionMenu !== undefined}
			>
				<SheetContent
					className="rounded-t-3xl pb-[max(2rem,env(safe-area-inset-bottom))]"
					showCloseButton={false}
					side="bottom"
				>
					<SheetTitle className="truncate px-5 pt-5 pb-2 text-base font-semibold">
						{sectionMenu?.name ?? ""}
					</SheetTitle>
					{sectionMenu ? (
						<ul className="px-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
							{sectionActionItems(sectionMenu.id, sections).map((item) => (
								<li key={item.id}>
									<button
										className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-base active:bg-muted disabled:opacity-40 ${
											item.destructive ? "text-destructive" : ""
										}`}
										disabled={item.disabled}
										onClick={() => runSectionAction(item.id)}
										type="button"
									>
										<item.icon className="size-5 shrink-0" />
										{item.label}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</SheetContent>
			</Sheet>
			<Sheet
				onOpenChange={(open) => {
					setSearchOpen(open);
					if (!open) setQuery("");
				}}
				open={searchOpen}
			>
				<SheetContent
					className="inset-x-0! top-0! h-dvh! w-full! max-w-none! border-0! bg-background p-0"
					showCloseButton={false}
					side="top"
				>
					<SheetTitle className="sr-only">Buscar conversas</SheetTitle>
					<header className="flex shrink-0 items-center gap-2 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4">
						<Button
							aria-label="Voltar às conversas"
							className="size-11 shrink-0 rounded-full bg-card hover:bg-card/90"
							onClick={closeSearch}
							size="icon"
							variant="secondary"
						>
							<ArrowLeftIcon className="size-5" />
						</Button>
						<InputGroup>
							<InputGroupAddon>
								<SearchIcon />
							</InputGroupAddon>
							<InputGroupInput
								ref={searchInputRef}
								aria-label="Buscar conversas"
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Buscar conversas"
								value={query}
							/>
						</InputGroup>
						<DropdownMenu>
							<DropdownMenuTrigger
								aria-label="Filtrar busca"
								render={
									<Button
										className="size-11 shrink-0 rounded-full bg-card hover:bg-card/90"
										size="icon"
										variant="secondary"
									/>
								}
							>
								<ListFilterIcon className="size-5" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuCheckboxItem checked>
									Nome
								</DropdownMenuCheckboxItem>
								<DropdownMenuCheckboxItem disabled>
									Mensagens
								</DropdownMenuCheckboxItem>
								<DropdownMenuCheckboxItem disabled>
									Arquivos
								</DropdownMenuCheckboxItem>
								<DropdownMenuCheckboxItem disabled>
									Rotinas
								</DropdownMenuCheckboxItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</header>
					<main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
						{loading ? (
							<p className="py-10 text-center text-sm text-muted-foreground">
								Carregando conversas…
							</p>
						) : null}
						{!loading && filtered.length === 0 ? (
							<p className="py-10 text-center text-sm text-muted-foreground">
								Nenhuma conversa encontrada.
							</p>
						) : null}
						{filtered.map((agent) => (
							<MobileBotRow
								agent={agent}
								agents={agents}
								key={agent.id}
								onMenu={() => openBotMenu(agent.id)}
								onOpen={() => {
									closeSearch();
									onSelect(agent.id);
								}}
							/>
						))}
					</main>
				</SheetContent>
			</Sheet>
		</div>
	);
}
