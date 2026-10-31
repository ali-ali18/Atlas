"use client";

import {
	HistoryIcon,
	MoreHorizontalIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	Trash2Icon,
	WebhookIcon,
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
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@workspace/ui/components/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { GithubMarkIcon } from "@/components/icons/github-mark";
import { Switch } from "@workspace/ui/components/switch";
import { cn } from "@workspace/ui/lib/utils";
import { useTranslations } from "@/lib/i18n/provider";
import type { Routine } from "../data";
import {
	buildRoutineMenu,
	routineActionErrorText,
	type RoutineActionError,
	type RoutineMenuItem,
	type RoutineMenuItemId,
	runOptimisticToggle,
	runTest,
} from "./routine-actions";
import { routineAlertDetail, routineAlertSentence, routinePrimaryTriggerKind, routineScheduleSummary } from "./routine-map";

export type RoutineCardHandlers = {
	onToggle?: (routine: Routine, enabled: boolean) => Promise<string | null>;
	onEdit?: (routine: Routine) => void;
	onRun?: (routine: Routine) => unknown;
	onDelete?: (routine: Routine) => void;
	onOpenHistory?: (routine: Routine) => void;
	onOpenWebhook?: (routine: Routine) => void;
	onOpenGithub?: (routine: Routine) => void;
};

export function MenuIcon({ id, resume }: { id: RoutineMenuItemId; resume: boolean }) {
	switch (id) {
		case "toggle":
			return resume ? <PlayIcon /> : <PauseIcon />;
		case "edit":
			return <PencilIcon />;
		case "run":
			return <PlayIcon />;
		case "history":
			return <HistoryIcon />;
		case "webhook":
			return <WebhookIcon />;
		case "github":
			return <GithubMarkIcon />;
		case "delete":
			return <Trash2Icon />;
	}
}

/** Renderiza os itens para o menu de contexto OU para o dropdown "…". */
export function RoutineMenuItems({
	items,
	variant,
	onSelect,
	resume = false,
}: {
	/** A rotina está pausada: o item "alternar" mostra o ícone de retomar. */
	resume?: boolean;
	items: RoutineMenuItem[];
	variant: "context" | "dropdown";
	onSelect: (id: RoutineMenuItemId) => void;
}) {
	const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
	const Separator = variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
	return (
		<>
			{items.map((item) => (
				<span key={item.id} className="contents">
					{item.separatorBefore ? <Separator /> : null}
					<Item
						disabled={item.disabled}
						onClick={() => onSelect(item.id)}
						variant={item.destructive ? "destructive" : "default"}
					>
						<MenuIcon id={item.id} resume={item.id === "toggle" && resume} />
						{item.label}
					</Item>
				</span>
			))}
		</>
	);
}

export function RoutineCard({
	routine,
	persisted,
	...handlers
}: { routine: Routine; persisted: boolean } & RoutineCardHandlers) {
	const translator = useTranslations();
	const { t } = translator;
	const [optimistic, setOptimistic] = useState<boolean | null>(null);
	const [error, setError] = useState<RoutineActionError | null>(null);
	const [testPending, setTestPending] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		if (optimistic !== null && routine.active === optimistic) setOptimistic(null);
	}, [routine.active, optimistic]);

	const active = optimistic ?? routine.active;
	const alertSentence = routineAlertSentence(routine, translator);
	const alertDetail = routineAlertDetail(routine, translator);
	const alertTitle = alertSentence ? (alertDetail ? `${alertSentence} · ${alertDetail}` : alertSentence) : undefined;
	const summary = alertSentence ?? routineScheduleSummary(routine, translator);
	const switchKey = active ? "routines.card.pauseNamed" : "routines.card.resumeNamed";
	const kind = routinePrimaryTriggerKind(routine);
	const items = buildRoutineMenu(
		{
			active,
			persisted,
			kind: kind === "webhook" || kind === "github" ? kind : "other",
			running: testPending,
		},
		translator,
	);

	async function toggle() {
		setError(null);
		const result = await runOptimisticToggle({
			current: active,
			apply: setOptimistic,
			request: async (next) =>
				handlers.onToggle ? handlers.onToggle(routine, next) : t("routines.card.unavailable"),
		});
		if (!result.ok) setError(result.error);
	}

	async function run() {
		setError(null);
		setTestPending(true);
		const ok = await runTest(() => handlers.onRun?.(routine));
		setTestPending(false);
		if (!ok) setError("run");
	}

	function select(id: RoutineMenuItemId) {
		if (id === "toggle") void toggle();
		else if (id === "edit") handlers.onEdit?.(routine);
		else if (id === "run") void run();
		else if (id === "history") handlers.onOpenHistory?.(routine);
		else if (id === "webhook") handlers.onOpenWebhook?.(routine);
		else if (id === "github") handlers.onOpenGithub?.(routine);
		else if (id === "delete") setConfirmDelete(true);
	}

	const card: ReactNode = (
		<div
			className="group/routine flex min-w-0 items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2.5"
			data-routine-card={routine.id}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm font-medium" title={routine.name}>
					{routine.name}
				</span>
				<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
					<span className={alertSentence ? "line-clamp-3 break-words" : "truncate"} data-routine-alert={alertSentence ? "" : undefined} title={alertTitle}>
						{persisted ? summary : t("routines.card.withDraft", { summary })}
					</span>
					{routine.createdBy === "bot" ? (
						<Badge data-routine-created-by="bot" variant="secondary">
							{t("routines.card.createdByBot")}
						</Badge>
					) : null}
				</span>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={t("routines.card.moreActions", { name: routine.name })}
							className={cn(
								"shrink-0 text-muted-foreground transition-opacity",
								"opacity-0 group-hover/routine:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
								"[@media(hover:none)]:opacity-100",
							)}
							size="icon-sm"
							variant="ghost"
						/>
					}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<RoutineMenuItems items={items} onSelect={select} resume={!active} variant="dropdown" />
				</DropdownMenuContent>
			</DropdownMenu>
			<Switch
				aria-label={t(switchKey, { name: routine.name, summary })}
				checked={active}
				className="data-checked:border-(--bot-accent,var(--primary)) data-checked:bg-(--bot-accent,var(--primary)) *:data-[slot=switch-thumb]:data-checked:bg-white!"
				disabled={!handlers.onToggle || !persisted}
				onCheckedChange={() => void toggle()}
			/>
		</div>
	);

	return (
		<li>
			<ContextMenu>
				<ContextMenuTrigger render={<div />}>{card}</ContextMenuTrigger>
				<ContextMenuContent>
					<RoutineMenuItems items={items} onSelect={select} resume={!active} variant="context" />
				</ContextMenuContent>
			</ContextMenu>
			{error ? (
				<p aria-live="polite" className="px-3 pt-1 text-destructive text-xs" role="alert">
					{routineActionErrorText(error, translator)}
				</p>
			) : null}
			<AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("routines.card.deleteTitle", { name: routine.name || t("routines.card.thisRoutine") })}</AlertDialogTitle>
						<AlertDialogDescription>{t("routines.card.deleteBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmDelete(false);
								handlers.onDelete?.(routine);
							}}
							variant="destructive"
						>
							{t("routines.menu.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
}
