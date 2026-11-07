"use client";

import { CalendarClockIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AgendaAction, AgendaItemView, AgendaListResponse } from "@workspace/shared";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@workspace/ui/components/empty";
import { Switch } from "@workspace/ui/components/switch";
import { cn } from "@workspace/ui/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";
import { changeAgendaItem, listAgenda } from "@/lib/atlas-api";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { performAgendaAction } from "./agenda-actions";
import { type AgendaCardModel, agendaCardModel, applyAgendaChange } from "./agenda-text";
import { LibrarySection } from "./library-section";

/** Resultado de uma ação para o cartão mostrar o aviso certo. */
export type AgendaActionResult = "ok" | "gone" | "error";

const STATE_BADGE = { active: "success", paused: "warning", ended: "secondary" } as const;

/** Um combinado da agenda. Pausar/retomar é o interruptor; cancelar só aparece no hover/foco (mouse) ou na pressão longa (toque). */
export function AgendaCard({
	item,
	model,
	onAction,
	revealed = false,
	onReveal,
}: {
	item: AgendaItemView;
	model: AgendaCardModel;
	onAction?: (item: AgendaItemView, action: AgendaAction) => Promise<AgendaActionResult>;
	/** Toque: a pressão longa já mostrou o botão de cancelar. */
	revealed?: boolean;
	onReveal?: () => void;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmCancel, setConfirmCancel] = useState(false);
	const longPress = useLongPress(() => onReveal?.());
	const ended = model.state === "ended";

	async function run(action: AgendaAction) {
		if (!onAction) return;
		setBusy(true);
		setError(null);
		const result = await onAction(item, action);
		setBusy(false);
		if (result === "gone") setError(t("agenda.changeGone"));
		else if (result === "error") setError(t("agenda.changeError"));
	}

	return (
		<li data-agenda-card={item.id} data-agenda-state={model.state}>
			<div
				className="group/agenda flex min-w-0 items-start gap-2 rounded-card border border-border bg-card px-3 py-2.5 [@media(hover:none)]:select-none"
				{...longPress}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className={cn("line-clamp-2 break-words font-medium text-body", ended && "text-muted-foreground")}>{model.note}</span>
					<span className="flex flex-wrap items-center gap-1.5">
						<Badge variant="outline">{model.kind}</Badge>
						<Badge variant={STATE_BADGE[model.state]}>{model.stateLabel}</Badge>
					</span>
					{model.summary ? <span className="break-words text-caption text-muted-foreground">{model.summary}</span> : null}
					{model.endText ? <span className="break-words text-caption text-muted-foreground">{model.endText}</span> : null}
					{model.next ? <span className="break-words text-caption text-muted-foreground">{model.next}</span> : null}
					{model.last ? <span className="line-clamp-3 break-words text-caption text-muted-foreground">{model.last}</span> : null}
				</div>
				{ended ? null : (
					<>
						<Button
							aria-label={t("agenda.cancelNamed", { note: model.note })}
							className={cn(
								"shrink-0 text-muted-foreground transition-opacity",
								// Mouse: some até passar o mouse ou focar dentro do item. Toque: some até a pressão longa.
								"[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/agenda:opacity-100 [@media(hover:hover)]:group-focus-within/agenda:opacity-100 focus-visible:opacity-100",
								!revealed && "[@media(hover:none)]:hidden",
							)}
							disabled={busy}
							onClick={() => setConfirmCancel(true)}
							size="icon-sm"
							type="button"
							variant="ghost"
						>
							<Trash2Icon />
						</Button>
						<Switch
							aria-label={t(model.state === "paused" ? "agenda.resumeNamed" : "agenda.pauseNamed", { note: model.note })}
							checked={model.state === "active"}
							className="mt-0.5 data-checked:border-(--bot-accent,var(--primary)) data-checked:bg-(--bot-accent,var(--primary)) *:data-[slot=switch-thumb]:data-checked:bg-white!"
							disabled={busy || !onAction}
							onCheckedChange={() => void run(model.state === "paused" ? "resume" : "pause")}
						/>
					</>
				)}
			</div>
			{error ? (
				<p aria-live="polite" className="px-3 pt-1 text-caption text-destructive" role="alert">
					{error}
				</p>
			) : null}
			<AlertDialog onOpenChange={setConfirmCancel} open={confirmCancel}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("agenda.cancelTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("agenda.cancelBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("agenda.cancelKeep")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmCancel(false);
								void run("cancel");
							}}
							variant="destructive"
						>
							{t("agenda.cancelConfirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</li>
	);
}

/** Lista da Agenda: ativos e pausados, o estado vazio e os encerrados recolhidos. Pura (dados por props) para teste. */
export function AgendaList({
	items,
	ended,
	timezone,
	now,
	onAction,
	revealedId = null,
	onReveal,
	endedOpen,
}: {
	items: readonly AgendaItemView[];
	ended: readonly AgendaItemView[];
	timezone: string;
	now: Date;
	onAction?: (item: AgendaItemView, action: AgendaAction) => Promise<AgendaActionResult>;
	revealedId?: string | null;
	onReveal?: (id: string) => void;
	/** Só para teste/prévia: já abre os encerrados. */
	endedOpen?: boolean;
}) {
	const t = useT();
	const translator = useTranslations();
	const card = (item: AgendaItemView) => (
		<AgendaCard
			item={item}
			key={item.id}
			model={agendaCardModel(item, timezone, now, translator)}
			onAction={onAction}
			onReveal={() => onReveal?.(item.id)}
			revealed={revealedId === item.id}
		/>
	);
	return (
		<div className="flex flex-col gap-3">
			{items.length === 0 ? (
				<Empty className="gap-2 p-4" data-agenda-empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CalendarClockIcon />
						</EmptyMedia>
						<EmptyTitle className="text-body">{t("agenda.empty.title")}</EmptyTitle>
						<EmptyDescription className="text-caption">{t("agenda.empty.body")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul aria-label={t("agenda.listLabel")} className="m-0 flex list-none flex-col gap-2 p-0">
					{items.map(card)}
				</ul>
			)}
			{ended.length > 0 ? (
				<Collapsible defaultOpen={endedOpen}>
					<CollapsibleTrigger className="rounded-md text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
						{t("agenda.ended.show", { count: ended.length })}
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						<ul className="m-0 flex list-none flex-col gap-2 p-0">{ended.map(card)}</ul>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</div>
	);
}

/**
 * Seção Agenda da Biblioteca. Só existe para quem usa o motor novo: enquanto o servidor não confirma (`enabled`) e
 * quando diz que não, nada é desenhado, então o app de quem não usa fica exatamente como era.
 */
export function BotAgenda({ botId, active }: { botId: string; active: boolean }) {
	const t = useT();
	const [data, setData] = useState<AgendaListResponse | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [revealedId, setRevealedId] = useState<string | null>(null);

	const reload = useCallback(() => {
		let stale = false;
		listAgenda(botId)
			.then((next) => {
				if (stale) return;
				setData(next);
				setLoadFailed(false);
			})
			.catch(() => {
				if (!stale) setLoadFailed(true);
			});
		return () => {
			stale = true;
		};
	}, [botId]);

	useEffect(() => {
		setData(null);
		setLoadFailed(false);
		setRevealedId(null);
	}, [botId]);

	useEffect(() => {
		if (!active) return;
		return reload();
	}, [active, reload]);

	const onAction = useCallback(
		async (item: AgendaItemView, action: AgendaAction): Promise<AgendaActionResult> => {
			const outcome = await performAgendaAction(changeAgendaItem, item, action);
			if (outcome.result === "ok") {
				setData((current) => (current ? applyAgendaChange(current, outcome.item) : current));
				setRevealedId(null);
			} else if (outcome.result === "gone") {
				reload();
			}
			return outcome.result;
		},
		[reload],
	);

	if (!data?.enabled) return null;
	return (
		<LibrarySection count={data.items.length} id="agenda" title={t("agenda.title")}>
			{loadFailed ? <p className="pb-2 text-caption text-muted-foreground">{t("agenda.loadError")}</p> : null}
			<AgendaList
				ended={data.ended}
				items={data.items}
				now={new Date()}
				onAction={onAction}
				onReveal={setRevealedId}
				revealedId={revealedId}
				timezone={data.timezone}
			/>
		</LibrarySection>
	);
}
