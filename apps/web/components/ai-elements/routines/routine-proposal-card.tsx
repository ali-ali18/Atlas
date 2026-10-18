"use client";

import { CalendarClockIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { describeRoutineProposalSchedule } from "@workspace/shared";
import { proposalView } from "@/lib/routine-proposal-message";
import type { Message } from "@/components/ui/templates/template-4/data";

export type RoutineProposalCardProps = {
	message: Extract<Message, { kind: "routine-proposal" }>;
	/** Sugerir: Criar. Automático: Manter. */
	onAccept?: () => void;
	/** Sugerir: Agora não. Automático: Desfazer. */
	onDecline?: () => void;
};

/**
 * Rotina que o bot propôs sozinho (modo proativo), na casca dos outros pedidos do chat:
 * "Quer que eu faça X toda segunda às 8h?" (Criar / Agora não) ou, no modo Automático,
 * "Criei a rotina X — manter?" (Manter / Desfazer). Decidido, só o selo e uma linha ficam.
 */
export function RoutineProposalCard({ message, onAccept, onDecline }: RoutineProposalCardProps) {
	const view = proposalView({
		mode: message.mode,
		status: message.status,
		spec: message.spec,
		schedule: describeRoutineProposalSchedule(message.spec),
	});
	const busy = message.isApplying ?? false;
	return (
		<RequestCard
			actions={
				<Button
					className={REQUEST_PRIMARY_CLASS}
					disabled={busy}
					onClick={onAccept}
					size="sm"
					type="button"
				>
					{busy ? "Aplicando…" : view.confirmLabel}
				</Button>
			}
			badge={view.badge}
			data-kind="routine-proposal"
			description={view.description}
			error={message.error}
			leading={<CalendarClockIcon aria-hidden />}
			note={view.note}
			resolved={view.resolved}
			title={view.title}
			trailing={
				<Button disabled={busy} onClick={onDecline} size="sm" type="button" variant="ghost">
					{view.cancelLabel}
				</Button>
			}
		/>
	);
}
