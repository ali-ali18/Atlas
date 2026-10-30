"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";
import type { CSSProperties } from "react";

import type { BotNeedsUserCard as BotNeedsUserCardData } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card";
import { AgentAvatar } from "@/components/ui/templates/template-4/agent-avatar";
import { botAccentStyle } from "@/components/ui/templates/template-4/chat-context-panel/bot-accent";
import { beginCardDecision, endCardDecision } from "@/lib/card-decision";
import { useTranslations } from "@/lib/i18n/provider";
import { answerBotPending, createAgentRun, getActiveSandboxSession, resolveBotProfileProposal, resumeAgentRun } from "@/lib/atlas-api";

import type { BotRef } from "./bot-chip";
import { BotRelayedCard } from "./bot-relayed-card";

type Need = BotNeedsUserCardData["need"];

export type BotNeedsUserCardViewProps = {
	bot: BotRef;
	need: Need;
	status: "pending" | "resolved";
	/** Uma ação em andamento (desabilita os botões). */
	busy?: boolean;
	error?: string | null;
	onOpenVm?: () => void;
	onDone?: () => void;
	onApprove?: () => void;
	onReject?: () => void;
	/** "Abrir conversa de X": navega até o card original. */
	onOpenConversation?: () => void;
};

/**
 * Pedido de um bot delegado que parou esperando o usuário (login, captcha,
 * aprovação...), relayado para a conversa de quem o chamou. Mesmas ações do card
 * original, mais o atalho para a conversa do bot.
 */
export function BotNeedsUserCardView({
	bot,
	need,
	status,
	busy = false,
	error,
	onOpenVm,
	onDone,
	onApprove,
	onReject,
	onOpenConversation,
}: BotNeedsUserCardViewProps) {
	const { t } = useTranslations();
	if (status === "resolved") {
		return (
			<div className="my-2" data-testid="bot-needs-user-resolved">
				<Marker className="justify-center text-xs">
					<MarkerContent className="inline-flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
						<CheckIcon aria-hidden className="size-3.5" />
						<span className="max-w-[10rem] truncate font-medium text-foreground/80">{bot.name}:</span>
						<span>{t("aiElements.bots.resolvedLine", { label: need.label })}</span>
					</MarkerContent>
				</Marker>
			</div>
		);
	}
	const isLogin = need.type === "login" || need.type === "captcha" || need.type === "connector";
	// Primária no tom do bot (mesmo destaque do painel de contexto); sem cor válida cai no tema.
	const accentButton = REQUEST_PRIMARY_CLASS;
	return (
		<RequestCard
			actions={
				<>
					{isLogin && need.type !== "connector" ? (
						<Button className={accentButton} disabled={busy || !onOpenVm} onClick={onOpenVm} size="sm" type="button">
							{t("aiElements.bots.openVm")}
						</Button>
					) : null}
					{isLogin && onDone ? (
						<Button
							className={need.type === "connector" ? accentButton : undefined}
							disabled={busy}
							onClick={onDone}
							size="sm"
							type="button"
							variant={need.type === "connector" ? "default" : "secondary"}
						>
							{t("aiElements.bots.finished")}
						</Button>
					) : null}
					{!isLogin && onApprove ? (
						<Button className={accentButton} disabled={busy} onClick={onApprove} size="sm" type="button">
							{need.confirmLabel ?? t("aiElements.bots.approve")}
						</Button>
					) : null}
				</>
			}
			badge={{ tone: "pending", label: t("aiElements.login.needsYou") }}
			data-testid="bot-needs-user-card"
			description={need.label}
			error={error}
			leading={<AgentAvatar animated={false} bodyColor={bot.color} id={bot.id} shape={bot.shape} size={20} />}
			style={botAccentStyle(bot.color) as CSSProperties}
			title={t("aiElements.bots.needsYou", { name: bot.name })}
			trailing={
				<>
					{!isLogin && onReject ? (
						<Button disabled={busy} onClick={onReject} size="sm" type="button" variant="ghost">
							{need.cancelLabel ?? t("aiElements.bots.reject")}
						</Button>
					) : null}
					{onOpenConversation ? (
						<Button
							className="text-muted-foreground"
							disabled={busy}
							onClick={onOpenConversation}
							size="sm"
							type="button"
							variant="ghost"
						>
							{t("aiElements.bots.openConversation", { name: bot.name })}
						</Button>
					) : null}
				</>
			}
		/>
	);
}

/** O card com as ações ligadas à API (opera no run/conversa do bot de destino). */
export function BotNeedsUserCard({
	card,
	bot,
	onOpenConversation,
	onResolved,
}: {
	card: Pick<BotNeedsUserCardData, "need" | "status" | "botId">;
	bot: BotRef;
	onOpenConversation?: () => void;
	/** Decidido daqui: quem hospeda o cartão (o dock) o tira da vista. */
	onResolved?: () => void;
}) {
	const { t } = useTranslations();
	const { need } = card;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [localResolved, setLocalResolved] = useState(false);

	const run = async (action: () => Promise<void>, failure: string, resolves = true): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await action();
			if (resolves) {
				setLocalResolved(true);
				onResolved?.();
			}
		} catch (cause) {
			console.warn("bot needs-user action failed", cause);
			setError(failure);
		} finally {
			setBusy(false);
		}
	};

	const decide = async (text: string, failure: string) => {
		// Trava no módulo: remontar o cartão (voltar ao app) não libera um segundo envio da mesma decisão.
		const key = `needs|${need.conversationId}|${text}`;
		if (!beginCardDecision(key)) return;
		try {
			await run(async () => {
				await createAgentRun({
					messages: [{ role: "user", content: text }],
					conversationId: need.conversationId,
					botId: card.botId,
				});
			}, failure);
		} finally {
			endCardDecision(key);
		}
	};

	const isLogin = need.type === "login" || need.type === "captcha" || need.type === "connector";
	const item = need.item;
	if (item && !localResolved && card.status === "pending" && (item.kind === "command" || item.kind === "write" || item.kind === "mcp" || item.kind === "questionnaire")) {
		// Mesmo card do destino aqui; cada botão responde o card original (já respondido lá = só resolve aqui).
		const respond = (request: Omit<Parameters<typeof answerBotPending>[0], "conversationId" | "cardId">, failure: string) =>
			void run(async () => {
				await answerBotPending({ conversationId: need.conversationId, cardId: need.cardId, ...request });
			}, failure);
		return (
			<BotRelayedCard
				bot={bot}
				busy={busy}
				error={error}
				item={item}
				onAnswer={(answers) => respond({ decision: "answer", answers }, t("aiElements.bots.sendAnswersError"))}
				onApprove={() => respond({ decision: "approve" }, t("aiElements.bots.approveError"))}
				onReject={(feedback) => respond({ decision: "reject", ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }, t("aiElements.bots.rejectError"))}
			/>
		);
	}
	return (
		<BotNeedsUserCardView
			bot={bot}
			busy={busy}
			error={error}
			need={need}
			onApprove={
				need.type === "confirm" && need.confirmTitle
					? () => void decide(t("aiElements.bots.confirmed", { title: need.confirmTitle ?? "" }), t("aiElements.bots.approveError"))
					: need.type === "profile" && need.proposalId
						? () =>
								void run(
									() =>
										resolveBotProfileProposal({ conversationId: need.conversationId, proposalId: need.proposalId!, decision: "approved" }).then(() => undefined),
									t("aiElements.bots.approveError"),
								)
						: undefined
			}
			onDone={
				isLogin && need.runId
					? () =>
							void run(async () => {
								const { enqueued } = await resumeAgentRun(need.runId!);
								if (!enqueued) throw new Error("not enqueued");
							}, t("aiElements.bots.resumeError"))
					: undefined
			}
			onOpenConversation={onOpenConversation}
			onOpenVm={
				isLogin
					? () =>
							void run(
								async () => {
									const session = await getActiveSandboxSession(need.conversationId);
									if (!session?.viewerUrl) throw new Error("no session");
									window.open(session.viewerUrl, "_blank", "noopener,noreferrer");
								},
								t("aiElements.bots.vmInactive", { name: bot.name }),
								false,
							)
					: undefined
			}
			onReject={
				need.type === "confirm" && need.confirmTitle
					? () => void decide(t("aiElements.bots.cancelThis"), t("aiElements.bots.rejectError"))
					: need.type === "profile" && need.proposalId
						? () =>
								void run(
									() =>
										resolveBotProfileProposal({ conversationId: need.conversationId, proposalId: need.proposalId!, decision: "rejected" }).then(() => undefined),
									t("aiElements.bots.rejectError"),
								)
						: undefined
			}
			status={localResolved ? "resolved" : card.status}
		/>
	);
}
