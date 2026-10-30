"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@workspace/ui/components/dialog";
import type { RoutineRunRecord } from "@workspace/shared";
import type { Routine } from "../data";
import {
	formatRoutineRunTime,
	routineRunLabel,
	routineTriggerRows,
} from "./routine-map";
import { WebhookSection } from "./webhook-fields";
import { useT, useTranslations } from "@/lib/i18n/provider";

type DialogProps = {
	routine: Routine | null;
	onOpenChange: (open: boolean) => void;
};

export function WebhookDialog({
	routine,
	onOpenChange,
	secret,
	canRotate,
	onRotate,
}: DialogProps & {
	secret?: string | null;
	canRotate: boolean;
	onRotate?: (routine: Routine) => void | Promise<void>;
}) {
	const t = useT();
	return (
		<Dialog onOpenChange={onOpenChange} open={Boolean(routine)}>
			<DialogContent className="grid-cols-[minmax(0,1fr)] break-words [&>*]:min-w-0">
				<DialogHeader>
					<DialogTitle>{t("routines.webhook.title", { name: routine?.name ?? "" })}</DialogTitle>
					<DialogDescription>
						{t("routines.webhook.description")}
					</DialogDescription>
				</DialogHeader>
				{routine ? (
					<WebhookSection
						canRotate={canRotate}
						onRotate={onRotate ? () => onRotate(routine) : undefined}
						secret={secret}
						url={routine.hook?.url}
						urlSecretAt={routine.hook?.urlSecretAt}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

export function GithubDialog({ routine, onOpenChange }: DialogProps) {
	const translator = useTranslations();
	const { t } = translator;
	const rows = routine ? routineTriggerRows(routine, translator) : [];
	const lastError = routine?.github?.state?.lastError;
	const setupUrl = routine?.hook?.setupUrl;
	return (
		<Dialog onOpenChange={onOpenChange} open={Boolean(routine)}>
			<DialogContent className="grid-cols-[minmax(0,1fr)] break-words [&>*]:min-w-0">
				<DialogHeader>
					<DialogTitle>{t("routines.github.title", { name: routine?.name ?? "" })}</DialogTitle>
					<DialogDescription>
						{routine?.github?.repo || t("routines.github.noRepo")}
					</DialogDescription>
				</DialogHeader>
				{lastError ? (
					<Alert variant="destructive">
						<AlertDescription>{lastError}</AlertDescription>
					</Alert>
				) : null}
				{rows.length > 0 ? (
					<ul className="flex min-w-0 flex-col gap-2 break-words text-muted-foreground text-sm">
						{rows.map((row, index) => (
							<li className="min-w-0 break-words" key={index}>{row.text}</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">{t("routines.github.none")}</p>
				)}
				{setupUrl ? (
					<a
						className="break-all text-sm underline underline-offset-2"
						href={setupUrl}
						rel="noreferrer"
						target="_blank"
					>
						{t("routines.github.setup")}
					</a>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

export function HistoryList({ runs }: { runs: RoutineRunRecord[] }) {
	const translator = useTranslations();
	const { t, locale } = translator;
	if (runs.length === 0) {
		return <p className="text-muted-foreground text-sm">{t("routines.history.empty")}</p>;
	}
	return (
		<ul className="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto">
			{runs.slice(0, 20).map((run) => (
				<li
					className="flex items-start justify-between gap-2 text-muted-foreground text-sm"
					key={run.id}
				>
					<span className="min-w-0 break-words">{routineRunLabel(run, translator)}</span>
					<span className="shrink-0 whitespace-nowrap text-right">{formatRoutineRunTime(run.createdAt, locale)}</span>
				</li>
			))}
		</ul>
	);
}

export function HistoryDialog({
	routine,
	onOpenChange,
	loadRuns,
}: DialogProps & { loadRuns: (routineId: string) => Promise<RoutineRunRecord[]> }) {
	const t = useT();
	const [runs, setRuns] = useState<RoutineRunRecord[] | null>(null);
	const [failed, setFailed] = useState(false);
	const routineId = routine?.id;

	useEffect(() => {
		if (!routineId) return;
		let cancelled = false;
		setRuns(null);
		setFailed(false);
		loadRuns(routineId)
			.then((items) => {
				if (!cancelled) setRuns(items);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [routineId, loadRuns]);

	return (
		<Dialog onOpenChange={onOpenChange} open={Boolean(routine)}>
			<DialogContent className="grid-cols-[minmax(0,1fr)] break-words [&>*]:min-w-0">
				<DialogHeader>
					<DialogTitle>{t("routines.history.title", { name: routine?.name ?? "" })}</DialogTitle>
					<DialogDescription>{t("routines.history.description")}</DialogDescription>
				</DialogHeader>
				{failed ? (
					<p className="text-destructive text-sm">{t("routines.history.error")}</p>
				) : runs === null ? (
					<p className="text-muted-foreground text-sm">{t("common.loading")}</p>
				) : (
					<HistoryList runs={runs} />
				)}
			</DialogContent>
		</Dialog>
	);
}
