import { CHAT_CARD_COPY } from "@workspace/ui/lib/chat-card-copy";
import { purchaseRequestFromEvent, type AgentV4Event, type PurchaseFacts } from "@workspace/shared";
import * as React from "react";
import { Linking, TextInput, View } from "react-native";
import { CheckCircleIcon, ExternalLinkIcon, HandIcon, ShieldCheckIcon, ShoppingCartIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatCard, ChatCardActions, ChatCardDetails, ChatCardHeader, ChatCardLine, type ChatCardTone } from "@/components/ui/chat-card";
import { Text } from "@/components/ui/text";
import { approvalDetails, approvalFacts, approvalPaysWithoutForm, approvalMessageBody, approvalSummaryLines, askOwnerAnswerText, askOwnerQuestionnaireItem, cvvComplete, cvvDigits, describeApproval, formatMoney, handoffSteps, safeReceiptUrl, type AgentCardDecision } from "@/lib/agent-cards";
import { cn } from "@/lib/cn";
import type { AgentV4Decision } from "@/lib/chat-api";
import type { ChatItem } from "@/lib/chat-types";
import { colorTokens } from "@/lib/theme";
import { useAppColorScheme } from "@/lib/use-theme";
import { QuestionnaireCard } from "./cards";

type AgentCardItem = Extract<ChatItem, { kind: "agent-card" }>;
type Of<T extends AgentV4Event["type"]> = Extract<AgentV4Event, { type: T }>;

export type AgentCardActions = {
	/** Aprovar, "Agora não" ou "Já fiz". `cvv` só na compra: vai no corpo da chamada e não fica em lugar nenhum. */
	onRespond: (item: AgentCardItem, decision: AgentV4Decision, cvv?: string) => void;
	onAnswerQuestion: (item: AgentCardItem, answer: string) => void;
	onDismissQuestion: (item: AgentCardItem) => void;
};

const PAY_UNAVAILABLE = "Não dá para pagar por aqui. Conclua a compra direto no site da loja.";

type Badge = { tone: ChatCardTone; label: string };

/** Selo do card: pendente, ou o que o dono decidiu; resolvido em outro lugar (sem decisão aqui) = "Resolvido", neutro. */
function badgeFor(item: AgentCardItem, labels: { ok: string }): Badge {
	const decision: AgentCardDecision | undefined = item.decision;
	if (decision === "dismissed" || decision === "denied") return { tone: "muted", label: CHAT_CARD_COPY.dismissed };
	if (decision) return { tone: "success", label: labels.ok };
	if (item.settled) return { tone: "muted", label: "Resolvido" };
	return { tone: "pending", label: CHAT_CARD_COPY.needsYou };
}

const isPending = (item: AgentCardItem) => !item.decision && !item.settled;

/** Um card do motor v4 no fio. Escolhe a forma pelo tipo do evento. */
export function AgentCardRow({ item, actions }: { item: AgentCardItem; actions: AgentCardActions }) {
	const card = item.card;
	switch (card.type) {
		case "receipt":
			return <ReceiptRow card={card} />;
		case "approval_request": {
			const purchase = purchaseRequestFromEvent(card);
			return purchase ? <PurchaseRow facts={purchase.facts} inputOnly={purchase.inputOnly} item={item} actions={actions} /> : <ApprovalRow card={card} item={item} actions={actions} />;
		}
		case "handoff_request":
			return <HandoffRow card={card} item={item} actions={actions} />;
		case "ask_owner":
			return <AskOwnerRow card={card} item={item} actions={actions} />;
	}
}

function ApprovalRow({ card, item, actions }: { card: Of<"approval_request">; item: AgentCardItem; actions: AgentCardActions }) {
	const facts = approvalFacts(card);
	const details = approvalDetails(card);
	const summary = approvalSummaryLines(card);
	// Pagamento sem o formulário do cartão (o `checkout` declara o campo do código): não dá para aprovar por aqui.
	const noForm = approvalPaysWithoutForm(card);
	const messageBody = approvalMessageBody(card);
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader leading={<ShieldCheckIcon />} title={describeApproval(card)} badge={badgeFor(item, { ok: "Aprovado" })} />
			{facts.externalRecipients.length > 0 ? <Text className="text-body text-warning">Vai para fora do seu círculo: {facts.externalRecipients.join(", ")}</Text> : null}
			{facts.irreversible ? <Text className="text-body text-warning">Não dá para desfazer depois.</Text> : null}
			{summary.map((line, index) => (
				<Text key={`s${index}-${line}`} variant="muted" className="text-body">
					{line}
				</Text>
			))}
			{messageBody ? (
				<ChatCardDetails>
					<Text className="text-body">{messageBody}</Text>
				</ChatCardDetails>
			) : null}
			{details.map((value, index) => (
				<Text key={`${index}-${value}`} variant="muted" className="text-body">
					{value}
				</Text>
			))}
			{noForm && isPending(item) ? <Text className="text-body text-warning">{PAY_UNAVAILABLE}</Text> : null}
			{isPending(item) ? (
				<ChatCardActions>
					{noForm ? null : (
						<Button size="sm" accessibilityLabel="Aprovar" onPress={() => actions.onRespond(item, "approve")}>
							<Text>Aprovar</Text>
						</Button>
					)}
					<Button size="sm" variant="secondary" accessibilityLabel={CHAT_CARD_COPY.dismiss} onPress={() => actions.onRespond(item, "deny")}>
						<Text>{CHAT_CARD_COPY.dismiss}</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}

/**
 * Compra: loja, itens, frete, total, final do cartão e o campo do CVV. O código vive só no campo (uma `ref`, nunca estado,
 * store, URL nem log): lido ao enviar, apagado do campo antes da chamada e entregue só ao corpo da requisição.
 */
function PurchaseRow({ facts, inputOnly, item, actions }: { facts: PurchaseFacts; inputOnly: boolean; item: AgentCardItem; actions: AgentCardActions }) {
	const scheme = useAppColorScheme();
	const field = React.useRef<React.ComponentRef<typeof TextInput>>(null);
	const typed = React.useRef("");
	const [valid, setValid] = React.useState(false);
	const [tried, setTried] = React.useState(false);
	const pending = isPending(item);
	const total = formatMoney(facts.amount, facts.currency);
	// Ao sair da tela o que sobrou na ref é apagado.
	React.useEffect(
		() => () => {
			typed.current = "";
		},
		[],
	);
	const submit = () => {
		const cvv = typed.current;
		if (!cvvComplete(cvv)) {
			setTried(true);
			return;
		}
		setTried(false);
		typed.current = "";
		field.current?.clear();
		setValid(false);
		actions.onRespond(item, "approve", cvv);
	};
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader leading={<ShoppingCartIcon />} title={inputOnly ? "Digite o código do cartão" : "Confirmar compra"} badge={badgeFor(item, { ok: "Aprovada" })} />
			<Text variant="muted" className="text-control">
				{inputOnly ? "Sua autorização cobre esta compra. Só falta o código de segurança do cartão." : `O bot montou o carrinho e quer pagar em ${facts.store}.`}
			</Text>
			{facts.items.map((entry) => (
				<Text key={entry} className="text-body">
					{entry}
				</Text>
			))}
			{facts.shipping !== null ? <Text className="text-body">Frete: {facts.shipping === 0 ? "Grátis" : formatMoney(facts.shipping, facts.currency)}</Text> : null}
			{facts.discount ? <Text className="text-body">Desconto: −{formatMoney(facts.discount, facts.currency)}</Text> : null}
			<Text className="text-control font-semibold">Total: {total}</Text>
			{facts.card ? <Text className="text-body">Cartão: {facts.card}</Text> : null}
			{pending ? (
				<View className="gap-1.5">
					<Text className="text-control font-medium">Código de segurança (CVV)</Text>
					<TextInput
						ref={field}
						accessibilityLabel="Código de segurança do cartão"
						secureTextEntry
						keyboardType="number-pad"
						textContentType="oneTimeCode"
						autoComplete="off"
						importantForAutofill="no"
						autoCorrect={false}
						autoCapitalize="none"
						contextMenuHidden
						maxLength={4}
						placeholder="3 ou 4 dígitos"
						placeholderTextColor={colorTokens[scheme]["muted-foreground"]}
						onChangeText={(text) => {
							typed.current = cvvDigits(text);
							setValid(cvvComplete(typed.current));
						}}
						onSubmitEditing={submit}
						className={cn("h-11 rounded-full border border-transparent bg-input/50 px-5 text-control text-foreground", tried && !valid && "border-destructive")}
					/>
					<Text variant="caption" className="text-body">
						Vai direto para a loja e não é guardado nem o bot vê.
					</Text>
					{tried && !valid ? <Text className="text-body text-destructive">Digite os 3 ou 4 números do código.</Text> : null}
				</View>
			) : null}
			{pending ? (
				<ChatCardActions>
					<Button size="sm" disabled={!valid} accessibilityLabel={inputOnly ? "Enviar código e pagar" : `Pagar ${total}`} onPress={submit}>
						<Text>{inputOnly ? "Enviar código e pagar" : `Pagar ${total}`}</Text>
					</Button>
					<Button size="sm" variant="secondary" accessibilityLabel={CHAT_CARD_COPY.dismiss} onPress={() => actions.onRespond(item, "deny")}>
						<Text>{CHAT_CARD_COPY.dismiss}</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}

function HandoffRow({ card, item, actions }: { card: Of<"handoff_request">; item: AgentCardItem; actions: AgentCardActions }) {
	const steps = handoffSteps(card.message);
	return (
		<ChatCard className="max-w-[min(68ch,100%)] self-start">
			<ChatCardHeader leading={<HandIcon />} title="Isso é com você" badge={badgeFor(item, { ok: "Feito" })} />
			{steps.length > 1 ? (
				steps.map((step, index) => (
					<Text key={`${index}-${step}`} className="text-control">
						{index + 1}. {step}
					</Text>
				))
			) : (
				<Text className="text-control">{steps[0] ?? card.message}</Text>
			)}
			{isPending(item) ? (
				<ChatCardActions>
					<Button size="sm" accessibilityLabel="Já fiz" onPress={() => actions.onRespond(item, "handoff_done")}>
						<Text>Já fiz</Text>
					</Button>
				</ChatCardActions>
			) : null}
		</ChatCard>
	);
}

/** Pergunta do bot: o mesmo questionário do app (alternativas + campo livre); a resposta segue como fala. */
function AskOwnerRow({ card, item, actions }: { card: Of<"ask_owner">; item: AgentCardItem; actions: AgentCardActions }) {
	const status = item.decision === "dismissed" ? "dismissed" : item.decision === "answered" || item.settled ? "submitted" : "pending";
	const questionnaire: Extract<ChatItem, { kind: "questionnaire" }> = React.useMemo(
		() => ({ id: `ask-owner-${card.cardId}`, kind: "questionnaire", questionnaireId: card.cardId, title: "Pergunta para você", items: [askOwnerQuestionnaireItem(card)], status }),
		[card, status],
	);
	return (
		<QuestionnaireCard
			item={questionnaire}
			onAnswer={(_target, answers) => {
				const answer = askOwnerAnswerText(card, answers.answer);
				if (answer) actions.onAnswerQuestion(item, answer);
			}}
			onDismiss={() => actions.onDismissQuestion(item)}
		/>
	);
}

/** Recibo: linha compacta do que foi feito (e onde), com o link quando houver. Sem nome de ferramenta nem id. */
function ReceiptRow({ card }: { card: Of<"receipt"> }) {
	const url = safeReceiptUrl(card.url);
	return (
		<ChatCard variant="activity" className="max-w-[min(68ch,100%)] self-start">
			<ChatCardLine
				leading={<CheckCircleIcon />}
				trailing={
					url ? (
						<Button size="sm" variant="secondary" accessibilityLabel={`Abrir: ${card.what}`} onPress={() => void Linking.openURL(url)}>
							<Text>Abrir</Text>
							<ExternalLinkIcon />
						</Button>
					) : null
				}
			>
				<Text className="text-sm">
					{card.what}
					{card.where ? <Text className="text-sm text-muted-foreground"> · {card.where}</Text> : null}
				</Text>
			</ChatCardLine>
		</ChatCard>
	);
}
