"use client";

import { ChevronDownIcon } from "lucide-react";
import type { MemoryChange, SleepReportView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { cn } from "@workspace/ui/lib/utils";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { ActionError, ListLoadError, ListLoading } from "./list-status";
import { canUndoChange, changePhrase, openProposals, proposalView, reportChanges, reportSummary, reportTitle } from "./notebook-model";

export type ChangesState = { status: "loading" } | { status: "error" } | { status: "ready"; changes: readonly MemoryChange[] };

const STATUS_TONE: Partial<Record<SleepReportView["status"], string>> = {
	running: "bg-info/10 text-info",
	skipped: "bg-muted text-muted-foreground",
	failed: "bg-destructive/10 text-destructive",
};

function ChangeLines({ state, busyId, onUndo, onRetry }: { state: ChangesState; busyId: string | null; onUndo: (change: MemoryChange) => void; onRetry: () => void }) {
	const translator = useTranslations();
	const { t } = translator;
	if (state.status === "loading") return <ListLoading />;
	if (state.status === "error") return <ListLoadError onRetry={onRetry} />;
	const changes = reportChanges(state.changes);
	if (changes.length === 0) return <p className="m-0 text-caption text-muted-foreground">{t("notebook.review.noChanges")}</p>;
	return (
		<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
			{changes.map((change) => {
				const phrase = changePhrase(change, translator);
				const undone = Boolean(change.undoneAt);
				return (
					<li className="flex min-w-0 items-start gap-2" data-notebook-change={change.id} key={change.id}>
						<span className={cn("min-w-0 flex-1 text-body [overflow-wrap:anywhere]", undone && "text-muted-foreground line-through")}>{phrase}</span>
						{undone ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">{t("notebook.review.undone")}</span> : null}
						{canUndoChange(change) ? (
							<Button aria-label={t("notebook.review.undoLabel", { what: phrase })} disabled={busyId === change.id} onClick={() => onUndo(change)} size="sm" type="button" variant="secondary">
								{t("notebook.review.undo")}
							</Button>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function ProposalLines({ report, busyId, onDismiss }: { report: SleepReportView; busyId: string | null; onDismiss: (proposalId: string) => void }) {
	const translator = useTranslations();
	const { t } = translator;
	if (report.proposals.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			<h4 className="m-0 font-medium text-caption text-muted-foreground">{t("notebook.review.proposals")}</h4>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{report.proposals.map((proposal) => {
					const view = proposalView(proposal, translator);
					return (
						<li className={cn("flex min-w-0 flex-col gap-1 rounded-card bg-muted/60 p-2.5", view.dismissed && "opacity-60")} data-notebook-proposal={view.id} key={view.id}>
							<div className="flex min-w-0 items-center gap-2">
								<span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-caption text-muted-foreground">{view.badge}</span>
								{view.dismissed ? <span className="ml-auto shrink-0 text-caption text-muted-foreground">{t("ui.cardDismissed")}</span> : null}
							</div>
							<p className="m-0 font-medium text-body [overflow-wrap:anywhere]">{view.title}</p>
							{view.detail ? <p className="m-0 text-caption text-muted-foreground [overflow-wrap:anywhere]">{view.detail}</p> : null}
							{!view.dismissed ? (
								<div className="flex justify-end">
									<Button aria-label={t("notebook.review.proposal.dismissLabel", { what: view.title })} disabled={busyId === view.id} onClick={() => onDismiss(view.id)} size="sm" type="button" variant="secondary">
										{t("ui.cardDismiss")}
									</Button>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export type ReportCardProps = {
	report: SleepReportView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	changes: ChangesState;
	busyId: string | null;
	error: string | null;
	onUndo: (change: MemoryChange) => void;
	onDismiss: (proposalId: string) => void;
	onRetryChanges: () => void;
};

/** Um relatório da noite (ou do domingo): resumo em frase; aberto, o que mudou (com desfazer) e as propostas. Puro. */
export function ReportCard(props: ReportCardProps) {
	const translator = useTranslations();
	const { t, tn } = translator;
	const { report } = props;
	const pending = openProposals(report).length;
	const tone = STATUS_TONE[report.status];
	return (
		<li className="min-w-0 rounded-card border border-border/60 bg-card" data-notebook-report={report.id}>
			<Collapsible onOpenChange={props.onOpenChange} open={props.open}>
				<CollapsibleTrigger className="flex w-full min-w-0 items-start gap-2 rounded-card px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
					<ChevronDownIcon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", !props.open && "-rotate-90")} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="flex min-w-0 flex-wrap items-center gap-1.5">
							<span className="font-medium text-body">{reportTitle(report, translator)}</span>
							{tone ? <span className={cn("rounded-full px-2 py-0.5 text-caption", tone)}>{t(`notebook.review.status.${report.status as "running" | "skipped" | "failed"}`)}</span> : null}
							{pending > 0 ? <span className="rounded-full bg-warning/10 px-2 py-0.5 text-caption text-warning">{tn("notebook.review.openProposals", pending)}</span> : null}
						</span>
						<span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{reportSummary(report, translator)}</span>
					</span>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="flex flex-col gap-3 px-3 pt-1 pb-3">
						<div className="flex flex-col gap-1.5">
							<h4 className="m-0 font-medium text-caption text-muted-foreground">{t("notebook.review.changes")}</h4>
							<ChangeLines busyId={props.busyId} onRetry={props.onRetryChanges} onUndo={props.onUndo} state={props.changes} />
						</div>
						<ProposalLines busyId={props.busyId} onDismiss={props.onDismiss} report={report} />
						<ActionError message={props.error} />
					</div>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

/** Lista de relatórios (sem estado próprio: cada item vem pronto do bloco). */
export function ReportsList({ children, hasMore, loadingMore, onLoadMore }: { children: React.ReactNode; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-2" data-notebook-reports>
			<ul aria-label={t("notebook.review.label")} className="m-0 flex list-none flex-col gap-2 p-0">
				{children}
			</ul>
			{hasMore ? (
				<Button disabled={loadingMore} onClick={onLoadMore} size="sm" type="button" variant="ghost">
					{t("notebook.review.seeMore")}
				</Button>
			) : null}
		</div>
	);
}
