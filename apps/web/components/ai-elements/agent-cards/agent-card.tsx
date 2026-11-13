"use client";

import { useState } from "react";
import { CheckIcon, CreditCardIcon, ExternalLinkIcon, HandIcon, ShieldCheckIcon } from "lucide-react";
import type { AgentV4Event } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ChatCard, ChatCardDetails, ChatCardError, ChatCardLine } from "@workspace/ui/components/chat-card";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { Spinner } from "@workspace/ui/components/spinner";
import { useUiCopy } from "@workspace/ui/components/ui-copy";
import { useTranslations } from "@/lib/i18n/provider";
import { formatList } from "@/lib/format";
import {
	type AgentCardMessage,
	type AskOwnerStatus,
	agentCardKey,
	askOwnerAnswerText,
	askOwnerQuestionnaire,
	approvalDetails,
	approvalMessageBody,
	approvalSummaryLines,
	approvalFacts,
	approvalPaysWithoutForm,
	agentCardDecisionOfState,
	describeApproval,
	handoffSteps,
	safeReceiptUrl,
} from "@/lib/agent-cards";
import { type QuestionnaireAnswersMap, QuestionnaireCard } from "@/components/ui/templates/template-4/chat-thread/questionnaire-card";
import { type AgentCardDecision, setAgentCardDecision, useAgentCardDecision } from "@/lib/agent-card-state";
import { PurchaseApprovalCard } from "@/components/ai-elements/purchase/purchase-approval-card";
import { purchaseRequestFromEvent } from "@/components/ai-elements/purchase/purchase-facts";
import { AGENT_CARD_ANSWER_MAX, type AgentCardResponse, respondToAgentCard } from "@/lib/atlas-api";

/** Envio da resposta: injetável para teste e prévia; o padrão é a função de `lib/atlas-api.ts`. */
export type AgentCardRespond = (runId: string, response: AgentCardResponse) => Promise<unknown>;

export type AgentCardProps = {
	message: AgentCardMessage;
	respond?: AgentCardRespond;
	/** Estado inicial (teste e prévia); na tela vem do que o dono decidiu neste aparelho. */
	initialDecision?: AgentCardDecision;
	/** Resposta digitada à pergunta do bot: segue como mensagem da conversa (o card só marca "respondido"). */
	onAnswer?: (answer: string) => void;
};

/** Um card do motor v4 no chat. Escolhe a forma pelo tipo do evento. */
export function AgentCard({ message, respond = respondToAgentCard, initialDecision, onAnswer }: AgentCardProps) {
	const { card } = message;
	// Card restaurado: o estado que o servidor derivou (aprovado, dispensado, vencido...) vale como decisão inicial.
	const restored = initialDecision ?? agentCardDecisionOfState(message.state) ?? undefined;
	const expired = message.state === "expired";
	switch (card.type) {
		case "receipt":
			return <ReceiptLine card={card} />;
		case "approval_request":
			return <ApprovalOrPurchase card={card} expired={expired} initialDecision={restored} respond={respond} settled={message.settled} />;
		case "handoff_request":
			return <HandoffCard card={card} expired={expired} initialDecision={restored} respond={respond} settled={message.settled} />;
		case "ask_owner":
			return <AskOwnerCard card={card} expired={expired} initialDecision={restored} onAnswer={onAnswer} respond={respond} settled={message.settled} />;
	}
}

type CardOf<T extends AgentV4Event["type"]> = Extract<AgentV4Event, { type: T }>;
type InteractiveProps<T extends AgentV4Event["type"]> = { card: CardOf<T>; respond: AgentCardRespond; settled?: boolean; expired?: boolean; initialDecision?: AgentCardDecision };

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
	const send = async (response: AgentCardResponse, next: AgentCardDecision): Promise<boolean> => {
		if (!card.runId || busy) return false;
		setBusy(next);
		setFailed(false);
		try {
			await respond(card.runId, response);
			setAgentCardDecision(key, next);
			return true;
		} catch {
			setFailed(true);
			return false;
		} finally {
			setBusy(null);
		}
	};
	return { decision, busy, failed, send, canRespond: Boolean(card.runId) };
}

/** Selo do card resolvido. Resolvido em outro lugar (sem decisão aqui) = "Resolvido", neutro. */
function resolvedBadge(decision: AgentCardDecision | null, labels: { ok: string; dismissed: string; settled: string; expired: string }, expired = false) {
	if (!decision && expired) return { tone: "muted" as const, label: labels.expired };
	if (decision === "dismissed") return { tone: "muted" as const, label: labels.dismissed };
	if (decision) return { tone: "success" as const, label: labels.ok };
	return { tone: "muted" as const, label: labels.settled };
}

/**
 * Pedido de aprovação. A compra (`checkout`, com o campo de CVV) tem cartão próprio, que fala direto com a API
 * (o CVV vai só no corpo da chamada, nunca por aqui); qualquer outro pedido usa o cartão genérico.
 */
function ApprovalOrPurchase(props: InteractiveProps<"approval_request">) {
	const purchase = purchaseRequestFromEvent(props.card);
	return purchase ? <PurchaseCard {...props} request={purchase} /> : <ApprovalCard {...props} />;
}

function PurchaseCard({ card, settled, expired, initialDecision, request }: InteractiveProps<"approval_request"> & { request: NonNullable<ReturnType<typeof purchaseRequestFromEvent>> }) {
	const key = agentCardKey(card);
	const stored = useAgentCardDecision(key);
	const decision = stored ?? initialDecision ?? null;
	const status = decision === "dismissed" ? "dismissed" : decision ? "approved" : expired ? "expired" : settled ? "settled" : "pending";
	return <PurchaseApprovalCard initialStatus={status} key={status} onDecided={(next) => setAgentCardDecision(key, next)} request={request} />;
}

function ApprovalCard({ card, respond, settled, expired, initialDecision }: InteractiveProps<"approval_request">) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const copy = useUiCopy();
	const { decision, busy, failed, send, canRespond } = useCardResponse(card, respond, initialDecision);
	const resolved = Boolean(decision || settled);
	const facts = approvalFacts(card);
	const details = approvalDetails(card);
	const summary = approvalSummaryLines(card, translator);
	const messageBody = approvalMessageBody(card);
	// Pagamento que não veio com o formulário do cartão (checkout) não tem como ser aprovado aqui: só dá para dispensar.
	const payment = approvalPaysWithoutForm(card);
	const base = { kind: "approval" as const, requestId: card.requestId, callId: card.callId };
	return (
		<RequestCard
			actions={
				canRespond ? (
					<>
						{payment ? null : (
							<Button className={REQUEST_PRIMARY_CLASS} disabled={busy !== null} onClick={() => void send({ ...base, decision: "approve" }, "approved")} size="sm" type="button">
								{busy === "approved" ? <Spinner className="size-3.5" /> : null}
								{t("agentCards.approval.approve")}
							</Button>
						)}
						<Button disabled={busy !== null} onClick={() => void send({ ...base, decision: "dismiss" }, "dismissed")} size="sm" type="button" variant="secondary">
							{copy.cardDismiss}
						</Button>
					</>
				) : null
			}
			badge={resolved ? resolvedBadge(decision, { ok: t("agentCards.approval.approved"), dismissed: copy.cardDismissed, settled: t("agentCards.settled"), expired: t("agentCards.expired") }, expired) : { tone: "pending", label: copy.cardNeedsYou }}
			data-kind="agent-approval"
			error={failed ? t("agentCards.sendFailed") : undefined}
			leading={payment ? <CreditCardIcon aria-hidden /> : <ShieldCheckIcon aria-hidden />}
			resolved={resolved}
			title={describeApproval(card, translator)}
		>
			{facts.externalRecipients.length > 0 || facts.irreversible ? (
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-warning">
					{facts.externalRecipients.length > 0 ? <li>{t("agentCards.approval.external", { recipients: formatList(facts.externalRecipients, locale) })}</li> : null}
					{facts.irreversible ? <li>{t("agentCards.approval.irreversible")}</li> : null}
				</ul>
			) : null}
			{summary.length > 0 ? (
				<ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-muted-foreground" data-slot="agent-approval-summary">
					{summary.map((line, index) => (
						<li className="[overflow-wrap:anywhere]" key={`${index}-${line}`}>
							{line}
						</li>
					))}
				</ul>
			) : null}
			{messageBody ? (
				<ChatCardDetails>
					<p className="m-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]" data-slot="agent-approval-message">
						{messageBody}
					</p>
				</ChatCardDetails>
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
			{payment && !resolved ? (
				<p className="m-0 text-sm text-warning" data-slot="agent-approval-pay-unavailable">
					{t("agentCards.approval.payUnavailable")}
				</p>
			) : null}
		</RequestCard>
	);
}

function HandoffCard({ card, respond, settled, expired, initialDecision }: InteractiveProps<"handoff_request">) {
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
					</>
				) : null
			}
			badge={resolved ? resolvedBadge(decision, { ok: t("agentCards.handoff.doneBadge"), dismissed: t("agentCards.settled"), settled: t("agentCards.settled"), expired: t("agentCards.expired") }, expired) : { tone: "pending", label: copy.cardNeedsYou }}
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

function AskOwnerCard({ card, respond, settled, expired, initialDecision, onAnswer }: InteractiveProps<"ask_owner"> & { onAnswer?: (answer: string) => void }) {
	const t = useTranslations().t;
	const { decision, failed, send, canRespond } = useCardResponse(card, respond, initialDecision);
	const [sentAnswer, setSentAnswer] = useState<string | null>(null);
	const [tooLong, setTooLong] = useState(false);
	const status: AskOwnerStatus = decision === "dismissed" || (expired && !decision) ? "dismissed" : decision === "answered" || settled ? "submitted" : "pending";
	// Resposta enviada neste aparelho: o card colapsado mostra o que foi escolhido (só em memória).
	const answers = status === "submitted" && sentAnswer ? { answer: sentAnswer } : undefined;
	const message = askOwnerQuestionnaire(card, t("agentCards.ask.title"), status, answers);
	const submit = (_message: unknown, values: QuestionnaireAnswersMap) => {
		const answer = askOwnerAnswerText(card, values.answer);
		if (!answer) return;
		if (answer.length > AGENT_CARD_ANSWER_MAX) {
			setTooLong(true);
			return;
		}
		setTooLong(false);
		setSentAnswer(answer);
		// O card só marca "respondido"; o texto segue como mensagem da conversa, depois de o servidor aceitar.
		void send({ kind: "ask_owner", cardId: card.cardId, decision: "answer", answer }, "answered").then((ok) => {
			if (ok) onAnswer?.(answer);
		});
	};
	const dismiss = () => void send({ kind: "ask_owner", cardId: card.cardId, decision: "dismiss" }, "dismissed");
	return (
		<div className="flex min-w-0 flex-col gap-2" data-kind="agent-ask-owner">
			<QuestionnaireCard dismissAs="action" message={message} onDismiss={canRespond ? dismiss : undefined} onSubmit={canRespond ? submit : undefined} />
			{failed || tooLong ? <ChatCardError>{t("agentCards.sendFailed")}</ChatCardError> : null}
		</div>
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
