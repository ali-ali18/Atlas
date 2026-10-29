"use client";

import { useMemo } from "react";
import type { BotPendingItem } from "@workspace/shared";
import { AgentAvatar } from "@/components/ui/templates/template-4/agent-avatar";
import { ConfirmCard } from "@/components/ai-elements/confirm";
import { DevApprovalCard } from "@/components/ai-elements/dev-session/dev-approval-card";
import { QuestionnaireCard, type QuestionnaireAnswersMap, type QuestionnaireCardMessage } from "@/components/ui/templates/template-4/chat-thread/questionnaire-card";
import type { QuestionnaireItemData } from "@/components/ui/templates/template-4/data";

import type { BotRef } from "./bot-chip";

export type BotRelayedCardProps = {
	bot: BotRef;
	item: BotPendingItem;
	busy?: boolean;
	error?: string | null;
	onApprove?: () => void;
	/** Agora não (sem comentário) ou "Recusar com comentário". */
	onReject?: (feedback: string) => void;
	onAnswer?: (answers: QuestionnaireAnswersMap) => void;
};

/**
 * O card do bot de destino mostrado na conversa de quem o chamou: os MESMOS componentes
 * do card original (aprovação de comando/escrita, confirmação, questionário), mais o
 * rótulo "Do bot X". Cada botão responde o card original (ver `answerBotPending`).
 */
export function BotRelayedCard({ bot, item, busy = false, error, onApprove, onReject, onAnswer }: BotRelayedCardProps) {
	// Estável entre renders: o card de questionário reage à identidade da mensagem.
	const questionnaireMessage = useMemo<QuestionnaireCardMessage | null>(
		() =>
			item.questionnaire
				? {
						id: item.handle,
						kind: "questionnaire",
						questionnaireId: item.questionnaire.id,
						title: item.title,
						...(item.questionnaire.description ? { description: item.questionnaire.description } : {}),
						items: item.questionnaire.items as QuestionnaireItemData[],
						status: "pending",
					}
				: null,
		[item],
	);
	let card;
	if (questionnaireMessage) {
		card = <QuestionnaireCard message={questionnaireMessage} onSubmit={onAnswer ? (_message, answers) => onAnswer(answers) : undefined} />;
	} else if (item.devApproval) {
		card = (
			<DevApprovalCard
				cancelLabel={item.cancelLabel}
				confirmLabel={item.confirmLabel}
				disabled={busy}
				info={item.devApproval}
				onConfirm={onApprove}
				onReject={onReject}
				onSkip={onReject ? () => onReject("") : undefined}
				title={item.title}
			/>
		);
	} else {
		card = (
			<ConfirmCard
				cancelLabel={item.cancelLabel}
				confirmLabel={item.confirmLabel}
				description={item.preview}
				disabled={busy}
				error={error}
				onCancel={onReject ? () => onReject("") : undefined}
				onConfirm={onApprove}
				title={item.title}
			/>
		);
	}
	return (
		<div className="flex min-w-0 flex-col gap-1.5" data-testid="bot-relayed-card">
			<p className="m-0 flex items-center gap-1.5 px-1 text-muted-foreground text-xs" data-testid="bot-relayed-label">
				<AgentAvatar animated={false} bodyColor={bot.color} id={bot.id} shape={bot.shape} size={14} />
				<span className="min-w-0 truncate">Do bot {bot.name}</span>
			</p>
			{card}
			{error && !(item.kind === "mcp" || item.kind === "other") ? (
				<p className="m-0 px-1 text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
