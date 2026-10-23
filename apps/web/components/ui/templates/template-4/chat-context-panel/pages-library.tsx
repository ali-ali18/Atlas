"use client";

import { CheckIcon, FolderIcon, MoreHorizontalIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { groupPagesForDisplay } from "@workspace/shared";
import { PageDialog, PageShareDialog } from "@/components/ai-elements/pages";
import { LIBRARY_REFRESH_EVENT } from "@/components/ai-elements/files/file-attachment";
import { cn } from "@workspace/ui/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";
import { type AtlasPage, type AtlasPageListItem, deletePage, getPage, listBotPages, listRoutineGroups, movePageToGroup } from "@/lib/atlas-api";
import { PAGES_REFRESH_EVENT } from "@/lib/pages-refresh";
import type { Routine } from "../data";
import { type PageCardModel, pageCardModel, updatedAgo } from "./library-sections";
import { PageGroupBlock } from "./page-group-block";
import { routineScheduleSummary } from "./routine-map";

export type PageGroupOption = { id: string; name: string };

export const PAGES_EMPTY_TEXT =
	"Peça ao bot um painel ou relatório, como “monta um painel das vendas da semana”, e o painel fica guardado aqui para você abrir e atualizar.";

/** Resumo da rotina que atualiza cada painel ("Toda segunda às 08:00"; pausada avisa). Pura. */
export function routineSummaryByPage(routines: readonly Routine[]): Map<string, string> {
	const byPage = new Map<string, string>();
	for (const routine of routines) {
		if (!routine.pageId || byPage.has(routine.pageId)) continue;
		const summary = routineScheduleSummary(routine);
		byPage.set(routine.pageId, routine.active ? summary : `${summary} (pausada)`);
	}
	return byPage;
}

function PageRow({
	model,
	busy,
	revealed,
	onOpen,
	onDelete,
	onReveal,
	groups,
	explicitGroupId,
	onMove,
}: {
	groups?: readonly PageGroupOption[];
	/** Grupo escolhido para o painel (null: sem grupo ou só o da rotina). */
	explicitGroupId?: string | null;
	onMove?: (groupId: string | null) => void;
	model: PageCardModel;
	busy: boolean;
	/** Toque: a lixeira foi revelada por pressão longa neste item. */
	revealed: boolean;
	onOpen: () => void;
	onDelete: () => void;
	onReveal: () => void;
}) {
	const longPress = useLongPress(onReveal);
	const meta = [model.sources, model.updated].filter(Boolean).join(" · ");
	return (
		<li
			className="group/row flex min-w-0 items-stretch gap-1 rounded-xl border border-border/60 bg-card transition-colors [@media(hover:hover)]:hover:bg-muted/40 [@media(hover:none)]:select-none"
			data-page-card={model.id}
			{...longPress}
		>
			<button
				aria-label={`Abrir painel ${model.title}`}
				className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
				disabled={busy}
				onClick={onOpen}
				type="button"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate font-medium text-[13px]">{model.title}</span>
					{model.routine ? (
						<RefreshCwIcon aria-label={`Atualizado por rotina: ${model.routine}`} className="size-3.5 shrink-0 text-muted-foreground" role="img" />
					) : null}
				</span>
				{meta ? <span className="truncate text-muted-foreground text-xs">{meta}</span> : null}
				{model.routine ? <span className="truncate text-muted-foreground text-xs">{model.routine}</span> : null}
			</button>
			{onMove ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-label={`Mais ações do painel ${model.title}`}
								className="my-1 self-start [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
								size="icon-sm"
								type="button"
								variant="ghost"
							/>
						}
					>
						<MoreHorizontalIcon aria-hidden />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<FolderIcon aria-hidden />
								Mover para grupo
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{(groups ?? []).length === 0 ? <DropdownMenuItem disabled>Nenhum grupo ainda</DropdownMenuItem> : null}
								{(groups ?? []).map((group) => (
									<DropdownMenuItem key={group.id} onClick={() => onMove(group.id)}>
										{explicitGroupId === group.id ? <CheckIcon aria-hidden /> : null}
										{group.name}
									</DropdownMenuItem>
								))}
								{explicitGroupId ? (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem onClick={() => onMove(null)}>Sem grupo</DropdownMenuItem>
									</>
								) : null}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			<Button
				aria-label={`Apagar painel ${model.title}`}
				className={cn(
					"my-1 mr-1 self-start transition-opacity",
					// Mouse: some até passar o mouse ou focar dentro do item. Toque: some até a pressão longa.
					"[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100 focus-visible:opacity-100",
					!revealed && "[@media(hover:none)]:hidden",
				)}
				onClick={onDelete}
				size="icon-sm"
				variant="ghost"
			>
				<Trash2Icon />
			</Button>
		</li>
	);
}

/** Lista dos painéis do bot (cartões) com estado vazio; pura para teste. */
export function PagesList({
	items,
	routineByPage,
	now,
	openingId,
	revealedId: initialRevealedId = null,
	onOpen,
	onDelete,
	groups,
	onMove,
}: {
	/** Grupos do bot (os mesmos das rotinas), para as seções e o menu "Mover para grupo". */
	groups?: readonly PageGroupOption[];
	onMove?: (item: AtlasPageListItem, groupId: string | null) => void;
	items: readonly AtlasPageListItem[];
	routineByPage?: ReadonlyMap<string, string>;
	now?: Date;
	openingId?: string | null;
	/** Item com a lixeira revelada de saída (teste); no uso real nasce da pressão longa. */
	revealedId?: string | null;
	onOpen?: (id: string) => void;
	onDelete?: (item: AtlasPageListItem) => void;
}) {
	const [revealedId, setRevealedId] = useState<string | null>(initialRevealedId);
	const listRef = useRef<HTMLUListElement>(null);
	useEffect(() => {
		if (!revealedId) return;
		// Tocar fora do item revelado (ou em outro item) esconde a lixeira; no próprio item, não.
		const onPointerDown = (event: PointerEvent) => {
			const row = (event.target as Element | null)?.closest?.("[data-page-card]");
			if (row && listRef.current?.contains(row) && row.getAttribute("data-page-card") === revealedId) return;
			setRevealedId(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [revealedId]);
	if (items.length === 0) {
		return <p className="px-2 py-6 text-center text-muted-foreground text-xs leading-relaxed">{PAGES_EMPTY_TEXT}</p>;
	}
	// Sem a lista de grupos (teste, carga falhou) as seções saem dos nomes que a própria listagem traz.
	const knownGroups: PageGroupOption[] = groups ? [...groups] : [];
	if (!groups) {
		for (const item of items) {
			if (item.groupId && item.groupName && !knownGroups.some((group) => group.id === item.groupId)) knownGroups.push({ id: item.groupId, name: item.groupName });
		}
	}
	const sections = groupPagesForDisplay(items, knownGroups);
	const row = (item: AtlasPageListItem) => (
		<PageRow
			busy={openingId === item.id}
			explicitGroupId={item.explicitGroupId ?? null}
			groups={knownGroups}
			key={item.id}
			model={pageCardModel(item, routineByPage?.get(item.id) ?? null, now)}
			onDelete={() => {
				setRevealedId(null);
				onDelete?.(item);
			}}
			onMove={onMove ? (groupId) => onMove(item, groupId) : undefined}
			onOpen={() => onOpen?.(item.id)}
			onReveal={() => setRevealedId(item.id)}
			revealed={revealedId === item.id}
		/>
	);
	return (
		<ul aria-label="Painéis do Bot" ref={listRef} className="m-0 flex list-none flex-col gap-2 p-0">
			{sections.map((section) => {
				if (section.groupId === null) return section.items.map(row);
				const group = knownGroups.find((candidate) => candidate.id === section.groupId);
				return (
					<PageGroupBlock count={section.items.length} id={section.groupId} key={section.groupId} name={group?.name ?? ""}>
						{section.items.map(row)}
					</PageGroupBlock>
				);
			})}
		</ul>
	);
}

/** Seção Painéis da Biblioteca: carrega ao abrir, recarrega quando o chat cria ou atualiza um painel. */
export function BotPagesSection({ botId, active, routines }: { botId: string; active: boolean; routines: readonly Routine[] }) {
	const [items, setItems] = useState<AtlasPageListItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [opened, setOpened] = useState<AtlasPage | null>(null);
	const [shareOpen, setShareOpen] = useState(false);
	const [openingId, setOpeningId] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<AtlasPageListItem | null>(null);
	const [groups, setGroups] = useState<PageGroupOption[] | undefined>(undefined);
	const routineByPage = routineSummaryByPage(routines);

	const reload = useCallback(() => {
		let stale = false;
		listRoutineGroups(botId)
			.then((list) => {
				if (!stale) setGroups(list.map((group) => ({ id: group.id, name: group.name })));
			})
			.catch(() => undefined);
		listBotPages(botId, 50)
			.then((list) => {
				if (stale) return;
				setItems(list);
				setError(null);
			})
			.catch(() => {
				if (!stale) setError("Não consegui carregar os painéis agora.");
			});
		return () => {
			stale = true;
		};
	}, [botId]);

	useEffect(() => {
		setItems(null);
		setGroups(undefined);
		setOpened(null);
	}, [botId]);

	useEffect(() => {
		if (!active) return;
		return reload();
	}, [active, reload]);

	useEffect(() => {
		let timer: number | undefined;
		const onRefresh = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				reload();
			}, 800);
		};
		window.addEventListener(PAGES_REFRESH_EVENT, onRefresh);
		window.addEventListener(LIBRARY_REFRESH_EVENT, onRefresh);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener(PAGES_REFRESH_EVENT, onRefresh);
			window.removeEventListener(LIBRARY_REFRESH_EVENT, onRefresh);
		};
	}, [reload]);

	async function open(id: string) {
		setOpeningId(id);
		setError(null);
		try {
			setOpened(await getPage(id));
		} catch {
			setError("Não consegui abrir o painel. Ele pode ter sido apagado.");
			reload();
		} finally {
			setOpeningId(null);
		}
	}

	async function move(item: AtlasPageListItem, groupId: string | null) {
		try {
			await movePageToGroup(item.id, groupId);
			setError(null);
			reload();
		} catch {
			setError("Não consegui mover o painel agora. Tente de novo.");
		}
	}

	async function confirmDelete() {
		const target = pendingDelete;
		setPendingDelete(null);
		if (!target) return;
		try {
			await deletePage(target.id);
			setItems((current) => current?.filter((item) => item.id !== target.id) ?? current);
			setError(null);
		} catch {
			setError("Não consegui apagar o painel agora. Tente de novo.");
		}
	}

	const openedRoutine = opened ? (routineByPage.get(opened.id) ?? null) : null;
	return (
		<div className="flex flex-col gap-2">
			{items === null ? (
				error ? null : <div aria-live="polite" className="h-16 animate-pulse rounded-xl bg-muted/40 motion-reduce:animate-none" data-testid="pages-loading" />
			) : (
				<PagesList groups={groups} items={items} onDelete={setPendingDelete} onMove={move} onOpen={open} openingId={openingId} routineByPage={routineByPage} />
			)}
			{error ? (
				<p className="m-0 text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			{opened ? (
				<PageDialog
					onOpenChange={(next) => {
						if (!next) {
							setOpened(null);
							setShareOpen(false);
						}
					}}
					onPublicLink={() => setShareOpen(true)}
					open
					routineLabel={openedRoutine}
					sources={opened.sources}
					spec={opened.spec}
					summary={opened.spec.summary}
					title={opened.title}
					updatedLabel={updatedAgo(opened.refreshedAt ?? opened.updatedAt)}
				/>
			) : null}
			{opened && shareOpen ? <PageShareDialog onOpenChange={setShareOpen} open pageId={opened.id} title={opened.title} /> : null}
			<AlertDialog onOpenChange={(next) => !next && setPendingDelete(null)} open={pendingDelete !== null}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Apagar o painel “{pendingDelete?.title}”?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingDelete && routineByPage.has(pendingDelete.id)
								? "Ele some da Biblioteca e a rotina que o atualiza passa a pular as execuções. Isso não pode ser desfeito."
								: "Ele some da Biblioteca. Isso não pode ser desfeito."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction onClick={() => void confirmDelete()} variant="destructive">
							Apagar painel
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
