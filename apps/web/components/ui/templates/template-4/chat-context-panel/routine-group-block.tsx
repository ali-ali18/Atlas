"use client";

import {
	ChevronRightIcon,
	MoreHorizontalIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	Trash2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
import { ButtonGroup } from "@workspace/ui/components/button-group";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import type { Routine } from "../data";
import { SectionAction } from "./memory-section";

export type RoutineGroupHandlers = {
	/** Devolve a mensagem de erro ou null quando deu certo. */
	onSetEnabled?: (groupId: string, enabled: boolean) => Promise<string | null>;
	onRename?: (groupId: string, name: string) => Promise<string | null>;
	onDelete?: (groupId: string, deleteRoutines: boolean) => Promise<string | null>;
};

/** "2 de 3 ativas" / "1 de 1 ativa". */
export function routineGroupSummary(active: number, total: number): string {
	return `${active} de ${total} ${total === 1 ? "ativa" : "ativas"}`;
}

/**
 * Rotinas do mesmo grupo num bloco recolhível: nome + "N de M ativas" à esquerda;
 * à direita, Pausar/Ativar todas (ícone no celular, ícone e texto no desktop) e "…".
 */
export function RoutineGroupBlock({
	id,
	name,
	routines,
	children,
	onSetEnabled,
	onRename,
	onDelete,
}: {
	id: string;
	name: string;
	routines: Routine[];
	children: ReactNode;
} & RoutineGroupHandlers) {
	const [open, setOpen] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const total = routines.length;
	const activeCount = routines.filter((routine) => routine.active).length;
	const allPaused = activeCount === 0;
	const partial = activeCount > 0 && activeCount < total;

	async function run(task: () => Promise<string | null> | undefined) {
		setError(null);
		setPending(true);
		try {
			const message = await task();
			if (message) setError(message);
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border p-2" data-routine-group={id}>
			<Collapsible onOpenChange={setOpen} open={open}>
				<div className="flex min-w-0 items-center gap-2">
					<CollapsibleTrigger
						aria-label={`${open ? "Recolher" : "Expandir"} grupo ${name}`}
						className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<ChevronRightIcon
							aria-hidden
							className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
						/>
						<span className="flex min-w-0 flex-col">
							<span className="truncate font-medium text-sm leading-tight" title={name}>
								{name}
							</span>
							<span className="truncate text-muted-foreground text-xs leading-tight">
								{routineGroupSummary(activeCount, total)}
							</span>
						</span>
					</CollapsibleTrigger>
					<ButtonGroup>
						<SectionAction
							disabled={pending || !onSetEnabled}
							icon={allPaused ? PlayIcon : PauseIcon}
							label={allPaused ? "Ativar todas" : "Pausar todas"}
							onClick={() => void run(() => onSetEnabled?.(id, allPaused))}
						/>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label={`Mais ações do grupo ${name}`}
										className="w-8 px-0"
										size="sm"
										type="button"
										variant="outline"
									/>
								}
							>
								<MoreHorizontalIcon aria-hidden />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => setRenaming(true)}>
									<PencilIcon />
									Renomear
								</DropdownMenuItem>
								{partial ? (
									<DropdownMenuItem onClick={() => void run(() => onSetEnabled?.(id, true))}>
										<PlayIcon />
										Ativar todas
									</DropdownMenuItem>
								) : null}
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={() => setConfirmDelete(true)} variant="destructive">
									<Trash2Icon />
									Apagar grupo
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</ButtonGroup>
				</div>
				{error ? (
					<p aria-live="polite" className="px-1 pt-1 text-destructive text-xs" role="alert">
						{error}
					</p>
				) : null}
				<CollapsibleContent>
					<ul className="m-0 flex list-none flex-col gap-2 p-0 pt-2">{children}</ul>
				</CollapsibleContent>
			</Collapsible>

			<RenameGroupDialog
				initialName={name}
				onClose={() => setRenaming(false)}
				onSubmit={(next) => onRename?.(id, next) ?? Promise.resolve("Indisponível")}
				open={renaming}
			/>

			<AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Apagar o grupo “{name}”?</AlertDialogTitle>
						<AlertDialogDescription>
							{total === 0
								? "O grupo está vazio."
								: `As ${total} ${total === 1 ? "rotina continua" : "rotinas continuam"}, só ${total === 1 ? "fica" : "ficam"} sem grupo. Ou apague também ${total === 1 ? "a rotina" : "as rotinas"}; isso não pode ser desfeito.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancelar</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmDelete(false);
								void run(() => onDelete?.(id, false));
							}}
							variant="outline"
						>
							Apagar só o grupo
						</AlertDialogAction>
						{total > 0 ? (
							<AlertDialogAction
								onClick={() => {
									setConfirmDelete(false);
									void run(() => onDelete?.(id, true));
								}}
								variant="destructive"
							>
								Apagar grupo e rotinas
							</AlertDialogAction>
						) : null}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
}

function RenameGroupDialog({
	open,
	initialName,
	onClose,
	onSubmit,
}: {
	open: boolean;
	initialName: string;
	onClose: () => void;
	onSubmit: (name: string) => Promise<string | null>;
}) {
	const [value, setValue] = useState(initialName);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const trimmed = value.trim();

	useEffect(() => {
		if (!open) return;
		setValue(initialName);
		setError(null);
	}, [open, initialName]);

	async function submit() {
		if (!trimmed || saving) return;
		if (trimmed === initialName) {
			onClose();
			return;
		}
		setSaving(true);
		setError(null);
		const message = await onSubmit(trimmed);
		setSaving(false);
		if (message) setError(message);
		else onClose();
	}

	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
			open={open}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Renomear grupo</DialogTitle>
					<DialogDescription>O novo nome aparece no painel e para o bot.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<Input
						aria-label="Nome do grupo"
						autoFocus
						maxLength={80}
						onChange={(event) => setValue(event.target.value)}
						value={value}
					/>
					{error ? (
						<p className="text-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button onClick={onClose} type="button" variant="outline">
							Cancelar
						</Button>
						<Button disabled={!trimmed || saving} type="submit">
							Salvar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export type RoutinePanelItem =
	| { kind: "routine"; routine: Routine }
	| { kind: "group"; group: { id: string; name: string }; routines: Routine[] };

/**
 * Ordena a lista do painel: cada grupo aparece na posição da sua primeira
 * rotina; rotinas sem grupo (ou com grupo desconhecido) ficam soltas; grupos
 * vazios vão para o fim para ainda poderem ser renomeados/apagados.
 */
export function groupRoutinesForPanel(
	routines: Routine[],
	groups: ReadonlyArray<{ id: string; name: string }>,
): RoutinePanelItem[] {
	const known = new Map(groups.map((group) => [group.id, group]));
	const members = new Map<string, Routine[]>();
	const items: RoutinePanelItem[] = [];
	for (const routine of routines) {
		const group = routine.groupId ? known.get(routine.groupId) : undefined;
		if (!group) {
			items.push({ kind: "routine", routine });
			continue;
		}
		const list = members.get(group.id);
		if (list) {
			list.push(routine);
			continue;
		}
		const created = [routine];
		members.set(group.id, created);
		items.push({ kind: "group", group, routines: created });
	}
	for (const group of groups) {
		if (!members.has(group.id)) items.push({ kind: "group", group, routines: [] });
	}
	return items;
}
