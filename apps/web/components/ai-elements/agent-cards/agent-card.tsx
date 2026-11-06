"use client";

import { useState } from "react";
import { CheckIcon, CreditCardIcon, ExternalLinkIcon, HandIcon, MessageCircleQuestionIcon, ShieldCheckIcon } from "lucide-react";
import type { AgentV4Event } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ChatCard, ChatCardLine } from "@workspace/ui/components/chat-card";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { Spinner } from "@workspace/ui/components/spinner";
import { Textarea } from "@workspace/ui/components/textarea";
import { useUiCopy } from "@workspace/ui/components/ui-copy";
import { useTranslations } from "@/lib/i18n/provider";
import { formatList } from "@/lib/format";
import {
	type AgentCardMessage,
	agentCardKey,
	approvalDetailValues,
	approvalFacts,
	approvalNeedsCardCode,
	describeApproval,
	handoffSteps,
	safeReceiptUrl,
} from "@/lib/agent-cards";
import { type AgentCardDecision, setAgentCardDecision, useAgentCardDecision } from "@/lib/agent-card-state";
import { AGENT_CARD_ANSWER_MAX, type AgentCardResponse, respondToAgentCard } from "@/lib/atlas-api";

/** Envio da resposta: injetável para teste e prévia; o padrão é a função de `lib/atlas-api.ts`. */
export type AgentCardRespond = (runId: string, response: AgentCardResponse) => Promise<unknown>;

export type AgentCardProps = {
	message: AgentCardMessage;
	respond?: AgentCardRespond;
	/** Estado inicial (teste e prévia); na tela vem do que o dono decidiu neste aparelho. */
	initialDecision?: AgentCardDecision;
};

/** Um card do motor v4 no chat. Escolhe a forma pelo tipo do evento. */
export function AgentCard({ message, respond = respondToAgentCard, initialDecision }: AgentCardProps) {
	const { card } = message;
	switch (card.type) {
		case "receipt":
			return <ReceiptLine card={card} />;
		case "approval_request":
			return <ApprovalCard card={card} initialDecision={initialDecision} respond={respond} settled={message.settled} />;
		case "handoff_request":
			return <HandoffCard card={card} initialDecision={initialDecision} respond={respond} settled={message.settled} />;
		case "ask_owner":
			return <AskOwnerCard card={card} initialDecision={initialDecision} respond={respond} settled={message.settled} />;
	}
}

type CardOf<T extends AgentV4Event["type"]> = Extract<AgentV4Event, { type: T }>;
type InteractiveProps<T extends AgentV4Event["type"]> = { card: CardOf<T>; respond: AgentCardRespond; settled?: boolean; initialDecision?: AgentCardDecision };

/**
 * Resposta de um card: envia, e só depois de o servidor aceitar grava a decisão (falhou = o card continua
 * pendente, com o erro amigável). Card sem `runId` não tem para onde responder: os botões nem aparecem.
 */
function useCardResponse(card: AgentV4Event, respond: AgentCardRespond, initialDecision?: AgentCardDecision) {
	const key = agentCardKey(card);
	const stored = useAgentCardDecision(key);
	const [busy, setBusy] = useState<AgentCardDecision | null>(null);
	const [failed, setFailed] = useState(false);
	const decision = stored ?? initialDecision ?? null;
	const send = async (response: AgentCardResponse, next: AgentCardDecision) => {
		if (!card.runId || busy) return;
		setBusy(next);
		setFailed(false);
		try {
			await respond(card.runId, response);
			setAgentCardDecision(key, next);
		} catch {
			setFailed(true);
		} finally {
			setBusy(null);
		}
	};
	return { decision, busy, failed, send, canRespond: Boolean(card.runId) };
}

/** Selo do card resolvido. Resolvido em outro lugar (sem decisão aqui) = "Resolvido", neutro. */
function resolvedBadge(decision: AgentCardDecision | null, labels: { ok: string; dismissed: string; settled: string }) {
	if (decision === "dismissed") return { tone: "muted" as const, label: labels.dismissed };
	if (decision) return { tone: "success" as const, label: labels.ok };
	return { tone: "muted" as const, label: labels.settled };
}

function ApprovalCard({ card, respond, settled, initialDecision }: InteractiveProps<"approval_request">) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const copy = useUiCopy();
	const { decision, busy, failed, send, canRespond } = useCardResponse(card, respond, initialDecision);
	const resolved = Boolean(decision || settled);
	const facts = approvalFacts(card);
	const details = approvalDetailValues(card.args);
	const payment = approvalNeedsCardCode(card);
	const base = { kind: "approval" as const, requestId: card.requestId, callId: card.callId };
	return (
		<RequestCard
			actions={
				canRespond ? (
					<>
						<Button className={REQUEST_PRIMARY_CLASS} disabled={busy !== null} onClick={() => void send({ ...base, decision: "approve" }, "approved")} size="sm" type="button">
							{busy === "approved" ? <Spinner className="size-3.5" /> : null}
							{t("agentCards.approval.approve")}
						</Button>
						<Button disabled={busy !== null} onClick={() => void send({ ...base, decision: "dismiss" }, "dismissed")} size="sm" type="button" variant="secondary">
							{copy.cardDismiss}
						</Button>
					</>
				) : null
			}
			badge={resolved ? resolvedBadge(decision, { ok: t("agentCards.approval.approved"), dismissed: copy.cardDismissed, settled: t("agentCards.settled") }) : { tone: "pending", label: copy.cardNeedsYou }}
			data-kind="agent-approval"
			error={failed ? t("agentCards.sendFailed") : undefined}
			leading={payment ? <CreditCardIcon aria-hidden /> : <ShieldCheckIcon aria-hidden />}
			resolved={resolved}
			title={describeApproval(card, translator)}
		>
			{facts.externalRecipients.length > 0 || facts.irreversible ? (
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-warning">
					{facts.externalRecipients.length > 0 ? <li>{t("agentCards.approval.external", { recipients: formatList(facts.externalRecipients.slice(0, 5), locale) })}</li> : null}
					{facts.irreversible ? <li>{t("agentCards.approval.irreversible")}</li> : null}
				</ul>
			) : null}
			{details.length > 0 ? (
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-muted-foreground" data-slot="agent-approval-details">
					{details.map((value, index) => (
						<li className="[overflow-wrap:anywhere]" key={`${index}-${value}`}>
							{value}
						</li>
					))}
				</ul>
			) : null}
			{payment && !resolved ? <CardCodeSlot /> : null}
		</RequestCard>
	);
}

/**
 * Espaço previsto do código de segurança do cartão (pagamento). O cartão salvo não tem esse código: o dono
 * digita aqui e ele vai direto para a loja, sem passar pelo servidor do Atlas nem pelo modelo (F6.3).
 * Ainda NÃO implementado: só o lugar e a explicação, sem campo que aceite digitação.
 */
function CardCodeSlot() {
	const t = useTranslations().t;
	return (
		<div className="flex min-w-0 flex-col gap-1 rounded-card border border-dashed border-border p-3" data-slot="agent-card-code-slot">
			<p className="m-0 text-sm font-medium">{t("agentCards.approval.cardCode")}</p>
			<p className="m-0 text-caption text-muted-foreground">{t("agentCards.approval.cardCodeHint")}</p>
		</div>
	);
}

function HandoffCard({ card, respond, settled, initialDecision }: InteractiveProps<"handoff_request">) {
	const t = useTranslations().t;
	const copy = useUiCopy();
	const { decision, busy, failed, send, canRespond } = useCardResponse(card, respond, initialDecision);
	const resolved = Boolean(decision || settled);
	const steps = handoffSteps(card.message);
	const base = { kind: "handoff" as const, callId: card.callId };
	return (
		<RequestCard
			actions={
				canRespond ? (
					<>
						<Button className={REQUEST_PRIMARY_CLASS} disabled={busy !== null} onClick={() => void send({ ...base, decision: "done" }, "done")} size="sm" type="button">
							{busy === "done" ? <Spinner className="size-3.5" /> : null}
							{t("agentCards.handoff.done")}
						</Button>
						<Button disabled={busy !== null} onClick={() => void send({ ...base, decision: "dismiss" }, "dismissed")} size="sm" type="button" variant="secondary">
							{copy.cardDismiss}
						</Button>
					</>
				) : null
			}
			badge={resolved ? resolvedBadge(decision, { ok: t("agentCards.handoff.doneBadge"), dismissed: copy.cardDismissed, settled: t("agentCards.settled") }) : { tone: "pending", label: copy.cardNeedsYou }}
			data-kind="agent-handoff"
			error={failed ? t("agentCards.sendFailed") : undefined}
			leading={<HandIcon aria-hidden />}
			resolved={resolved}
			title={t("agentCards.handoff.title")}
		>
			{steps.length > 1 ? (
				<ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm">
					{steps.map((step, index) => (
						<li className="[overflow-wrap:anywhere]" key={`${index}-${step}`}>
							{step}
						</li>
					))}
				</ol>
			) : (
				<p className="m-0 text-sm whitespace-pre-line [overflow-wrap:anywhere]">{steps[0] ?? card.message}</p>
			)}
		</RequestCard>
	);
}

function AskOwnerCard({ card, respond, settled, initialDecision }: InteractiveProps<"ask_owner">) {
	const t = useTranslations().t;
	const copy = useUiCopy();
	const { decision, busy, failed, send, canRespond } = useCardResponse(card, respond, initialDecision);
	const [answer, setAnswer] = useState("");
	const resolved = Boolean(decision || settled);
	const trimmed = answer.trim();
	const question = card.question.trim() || card.offer || "";
	const submit = () => {
		if (!trimmed) return;
		void send({ kind: "ask_owner", cardId: card.cardId, decision: "answer", answer: trimmed }, "answered");
	};
	return (
		<RequestCard
			actions={
				canRespond ? (
					<>
						<Button className={REQUEST_PRIMARY_CLASS} disabled={busy !== null || !trimmed} onClick={submit} size="sm" type="button">
							{busy === "answered" ? <Spinner className="size-3.5" /> : null}
							{t("agentCards.ask.answer")}
						</Button>
						<Button disabled={busy !== null} onClick={() => void send({ kind: "ask_owner", cardId: card.cardId, decision: "dismiss" }, "dismissed")} size="sm" type="button" variant="secondary">
							{copy.cardDismiss}
						</Button>
					</>
				) : null
			}
			badge={resolved ? resolvedBadge(decision, { ok: t("agentCards.ask.answered"), dismissed: copy.cardDismissed, settled: t("agentCards.settled") }) : { tone: "pending", label: copy.cardNeedsYou }}
			data-kind="agent-ask-owner"
			description={question}
			error={failed ? t("agentCards.sendFailed") : undefined}
			leading={<MessageCircleQuestionIcon aria-hidden />}
			resolved={resolved}
			title={t("agentCards.ask.title")}
		>
			{resolved || !canRespond ? null : (
				<Textarea
					aria-label={t("agentCards.ask.inputLabel")}
					className="min-h-16 resize-none bg-background"
					disabled={busy !== null}
					maxLength={AGENT_CARD_ANSWER_MAX}
					onChange={(event) => setAnswer(event.target.value)}
					onKeyDown={(event) => {
						// Enter envia, Shift+Enter quebra a linha (o mesmo do campo de digitar da conversa).
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={t("agentCards.ask.inputLabel")}
					value={answer}
				/>
			)}
		</RequestCard>
	);
}

/** Recibo: linha compacta do que foi feito (e onde), com o link quando houver. Sem nome de ferramenta nem id. */
function ReceiptLine({ card }: { card: CardOf<"receipt"> }) {
	const t = useTranslations().t;
	const url = safeReceiptUrl(card.url);
	return (
		<ChatCard data-kind="agent-receipt" variant="activity">
			<ChatCardLine
				leading={<CheckIcon aria-label={t("agentCards.receipt.done")} className="text-success" />}
				trailing={
					url ? (
						<Button nativeButton={false} render={<a href={url} rel="noopener noreferrer" target="_blank" />} size="sm" variant="secondary">
							{t("agentCards.receipt.open")}
							<ExternalLinkIcon aria-hidden data-icon="inline-end" />
						</Button>
					) : null
				}
			>
				<span className="text-sm">{card.what}</span>
				{card.where ? <span className="text-sm text-muted-foreground"> · {card.where}</span> : null}
			</ChatCardLine>
		</ChatCard>
	);
}
