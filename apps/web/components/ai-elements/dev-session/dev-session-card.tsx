"use client";

import { SquareTerminalIcon } from "lucide-react";

import {
	devIsWorking,
	devStatusTone,
	devCurrentStep,
	devRowStatus,
	devSessionCounters,
	devPrCardText,
	devSessionTitle,
	type DevSessionView,
} from "@/lib/dev-session/reducer";
import { markActiveWorkSeen } from "@/lib/dev-session/active-work";
import { useQueuedSessionPoll } from "@/lib/dev-session/queue-poll";
import { useCiPolling } from "@/lib/dev-session/use-ci-polling";
import { openActivity, useActivitySelection, useDevSession, useNow } from "@/lib/dev-session/store";

import { useTranslations } from "@/lib/i18n/provider";

import { ActivityCard } from "./parts";

/** Linha compacta no chat; o clique abre o detalhe na 3ª coluna. */
export function DevSessionCardView({
	view,
	now,
	selected = false,
	onOpen,
}: {
	view: DevSessionView;
	now: number;
	selected?: boolean;
	onOpen?: () => void;
}) {
	const translator = useTranslations();
	const { t, tn } = translator;
	const step = devCurrentStep(view, translator);
	const counters = devSessionCounters(view);
	const parts = [
		counters.commands > 0 ? tn("devSession.card.command", counters.commands) : null,
		counters.files > 0 ? tn("devSession.card.file", counters.files) : null,
		counters.added > 0 || counters.removed > 0 ? `+${counters.added} −${counters.removed}` : null,
	].filter(Boolean);
	const pr = devPrCardText(view, translator);
	const extra = step ? (
		<span className="font-mono">{step}</span>
	) : !devIsWorking(view) && (pr || parts.length > 0) ? (
		[pr, ...parts].filter(Boolean).join(" · ")
	) : null;
	return (
		<ActivityCard
			dataAttr="data-dev-session-card"
			extra={extra}
			icon={<SquareTerminalIcon />}
			label={t("devSession.card.open", { title: devSessionTitle(view, translator) })}
			onOpen={onOpen}
			selected={selected}
			status={devRowStatus(view, now, translator)}
			title={devSessionTitle(view, translator)}
			tone={devStatusTone(view)}
		/>
	);
}

export function DevSessionCard({ sessionId }: { sessionId: string }) {
	const view = useDevSession(sessionId);
	const selection = useActivitySelection();
	const now = useNow(view ? devIsWorking(view) : false);
	useQueuedSessionPoll(sessionId, view?.status);
	useCiPolling(sessionId, view);
	if (!view) return null;
	return (
		<DevSessionCardView
			now={now}
			onOpen={() => {
				markActiveWorkSeen(sessionId);
				openActivity({ kind: "dev", sessionId });
			}}
			selected={selection?.kind === "dev" && selection.sessionId === sessionId}
			view={view}
		/>
	);
}
