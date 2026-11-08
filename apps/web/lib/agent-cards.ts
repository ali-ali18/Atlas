import { type AgentV4Event, type ComputerUseEvent, agentCardCallId, agentCardIdentity, agentCardKey, approvalEventFact, approvalMessageFact, formatApprovalEventWhen, isAgentV4EventType, parseAgentV4Event } from "@workspace/shared";
import type { Message } from "@/components/ui/templates/template-4/data";
import { formatCurrency, formatList } from "@/lib/format";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/**
 * Cards do motor v4 no chat (aprovação, "isso é com você", pergunta do bot, recibo). Parte pura: identidade
 * estável entre o ao vivo e o gravado, montagem da mensagem da thread e a frase simples do que vai ser feito.
 * O evento chega já validado por `parseAgentV4Event` (shared); nada aqui confia no payload cru.
 */

export type AgentCardMessage = Extract<Message, { kind: "agent-card" }>;
export type AgentCardType = AgentV4Event["type"];

export { agentCardIdentity, agentCardKey };

/** Prefixo do id do card ao vivo: o gravado (id do banco) vence quando os dois coexistem. */
export const LIVE_AGENT_CARD_PREFIX = "agent-card-";

/** Evento do stream → mensagem da thread. `runId` de reserva quando o evento não traz o dele. */
export function agentCardMessage(event: AgentV4Event, options: { id?: string; runId?: string } = {}): AgentCardMessage {
	const card: AgentV4Event = event.runId || !options.runId ? event : { ...event, runId: options.runId };
	return { id: options.id ?? `${LIVE_AGENT_CARD_PREFIX}${agentCardKey(card)}`, kind: "agent-card", card };
}

/**
 * Card gravado na conversa (`role` = tipo do evento, `content` = o evento em JSON). Valida com o parser
 * de shared: JSON inválido ou campo fora do contrato = sem card (nunca um card quebrado na tela).
 */
export function agentCardFromStored(id: string, role: string, content: string, runId?: string): AgentCardMessage | null {
	if (!isAgentV4EventType(role)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return null;
	}
	const event = parseAgentV4Event(raw);
	if (!event || event.type !== role) return null;
	// O run da linha gravada é a reserva: a chave tem de ser a mesma do card ao vivo (que recebe a do stream).
	return agentCardMessage(event, { id, ...(runId ? { runId } : {}) });
}

/** Vale para o ao vivo e para a hidratação: o evento do stream que é um card v4 válido, ou `null`. */
export function asAgentCardEvent(event: ComputerUseEvent): AgentV4Event | null {
	return isAgentV4EventType(event.type) ? parseAgentV4Event(event) : null;
}

/**
 * Card v4 aplicado à thread. O mesmo card (mesma chave) não entra duas vezes (reconexão reentrega eventos);
 * card novo vai para o fim, na ordem em que chegou, como o resto do passo do run.
 */
export function applyAgentCardEvent(previous: Message[], event: AgentV4Event, runId?: string): Message[] {
	const message = agentCardMessage(event, runId ? { runId } : {});
	const key = agentCardKey(message.card);
	if (previous.some((item) => item.kind === "agent-card" && agentCardKey(item.card) === key)) return previous;
	return [...previous, message];
}

/**
 * Resultado da chamada estacionada chegou: o pedido foi resolvido (aqui ou em outro aparelho). O card fica,
 * mas sem botões. Sem card dessa chamada, a thread volta igual (mesma referência).
 */
export function settleAgentCardsForCall(previous: Message[], callId: string, runId?: string): Message[] {
	let changed = false;
	const next = previous.map((item) => {
		if (item.kind !== "agent-card" || item.settled || agentCardCallId(item.card) !== callId) return item;
		// Id de chamada pode se repetir entre runs (provedor com ids sequenciais): com os dois runs conhecidos, têm de casar.
		if (runId && item.card.runId && item.card.runId !== runId) return item;
		changed = true;
		return { ...item, settled: true };
	});
	return changed ? next : previous;
}

/** Todos os cards v4 dos eventos de um run, na ordem, com os já resolvidos marcados. */
export function applyAgentCardEvents(thread: Message[], events: readonly ComputerUseEvent[], runId?: string): Message[] {
	let next = thread;
	for (const event of events) {
		const card = asAgentCardEvent(event);
		if (card) next = applyAgentCardEvent(next, card, runId);
		else if (event.type === "tool_result") next = settleAgentCardsForCall(next, event.id, runId);
	}
	return next;
}

/** Link do recibo só se for http(s): URL vinda de fora nunca vira `javascript:` na tela. */
export function safeReceiptUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
	} catch {
		return null;
	}
}

type ApprovalEvent = Extract<AgentV4Event, { type: "approval_request" }>;

const shortText = (value: unknown, max = 120): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

const textList = (value: unknown): string[] =>
	Array.isArray(value) ? value.map((item) => shortText(item)).filter((item): item is string => item !== null) : [];

/** Fatos de risco que o card mostra, lidos com cuidado (o tipo em shared é `Record<string, unknown>`). */
export type ApprovalFacts = {
	amount?: number;
	currency?: string;
	merchant?: string;
	target?: string;
	recipients: string[];
	externalRecipients: string[];
	irreversible: boolean;
};

export function approvalFacts(event: ApprovalEvent): ApprovalFacts {
	const facts = event.riskFacts;
	const amount = typeof facts.amount === "number" && Number.isFinite(facts.amount) ? facts.amount : undefined;
	const currency = typeof facts.currency === "string" && /^[A-Za-z]{3}$/.test(facts.currency) ? facts.currency.toUpperCase() : undefined;
	const merchant = shortText(facts.merchant) ?? undefined;
	const target = shortText(facts.target) ?? undefined;
	return {
		...(amount !== undefined && { amount }),
		...(currency && { currency }),
		...(merchant && { merchant }),
		...(target && { target }),
		recipients: textList(facts.recipients),
		externalRecipients: textList(facts.externalRecipients),
		irreversible: facts.irreversible === true,
	};
}

/**
 * O que o bot vai fazer, numa frase simples, a partir da classe de efeito e dos fatos tipados. Nunca usa o
 * nome da ferramenta nem nomes de campo: o dono lê "Pagar R$ 120,00 em Loja X", não "checkout(amount=…)".
 */
export function describeApproval(event: ApprovalEvent, translator: Translator = defaultTranslator): string {
	const { t, locale } = translator;
	const facts = approvalFacts(event);
	const calendarEvent = approvalEventFact(event.riskFacts);
	if (calendarEvent) {
		const title = calendarEvent.title;
		if (calendarEvent.action === "delete") return title ? t("agentCards.approval.eventDelete", { title }) : t("agentCards.approval.eventDeleteGeneric");
		if (calendarEvent.action === "update") return title ? t("agentCards.approval.eventUpdate", { title }) : t("agentCards.approval.eventUpdateGeneric");
		return title ? t("agentCards.approval.eventCreate", { title }) : t("agentCards.approval.eventCreateGeneric");
	}
	switch (event.effect) {
		case "money": {
			const amount = facts.amount !== undefined ? (facts.currency ? formatCurrency(facts.amount, facts.currency, locale) : String(facts.amount)) : null;
			if (amount && facts.merchant) return t("agentCards.approval.payAt", { amount, merchant: facts.merchant });
			if (amount) return t("agentCards.approval.pay", { amount });
			if (facts.merchant) return t("agentCards.approval.payMerchant", { merchant: facts.merchant });
			return t("agentCards.approval.payGeneric");
		}
		case "send":
			return facts.recipients.length > 0
				? t("agentCards.approval.sendTo", { recipients: formatList(facts.recipients, locale) })
				: t("agentCards.approval.sendGeneric");
		case "public_link":
			return facts.target ? t("agentCards.approval.publicLinkOf", { target: facts.target }) : t("agentCards.approval.publicLink");
		case "destructive":
			return facts.target ? t("agentCards.approval.deleteTarget", { target: facts.target }) : t("agentCards.approval.deleteGeneric");
		case "credential":
			return t("agentCards.approval.credential");
		case "write_external":
			return facts.target ? t("agentCards.approval.changeTarget", { target: facts.target }) : t("agentCards.approval.changeExternal");
		case "write_internal":
			return facts.target ? t("agentCards.approval.saveTarget", { target: facts.target }) : t("agentCards.approval.saveGeneric");
		case "draft":
			return facts.target ? t("agentCards.approval.draftTarget", { target: facts.target }) : t("agentCards.approval.draftGeneric");
		case "read":
			return facts.target ? t("agentCards.approval.readTarget", { target: facts.target }) : t("agentCards.approval.readGeneric");
	}
}

/**
 * Pagamento sem o formulário do cartão: o `checkout` declara o campo do código e vira o card de compra; qualquer outro
 * pedido de dinheiro cai aqui e NÃO pode ser aprovado por este card (o código do cartão não tem onde ser digitado).
 */
export function approvalPaysWithoutForm(event: ApprovalEvent): boolean {
	return event.effect === "money";
}

/**
 * Detalhes do que vai ser feito: só os valores simples dos argumentos (texto, número, sim/não), sem os nomes
 * dos campos, que são internos. Limitado para não virar um despejo: até `max` valores, cada um curto.
 */
export function approvalDetailValues(args: unknown, max = 6): string[] {
	return collectDetailValues(args, max);
}

/** Valores do card de aprovação para a tela. Credencial não mostra nada: a frase basta e o valor nunca aparece. */
export function approvalDetails(event: ApprovalEvent, max = 6): string[] {
	// Evento e e-mail têm linhas próprias (`approvalSummaryLines`): os argumentos crus trariam o id do evento e campos internos.
	if (event.effect === "credential" || approvalEventFact(event.riskFacts) || approvalMessageFact(event.riskFacts)) return [];
	return collectDetailValues(event.args, max);
}

/** Linhas do que vai ser feito para eventos de agenda e e-mails: quando, onde, quem, assunto. Em palavras do dono, sem campos internos. */
export function approvalSummaryLines(event: ApprovalEvent, translator: Translator = defaultTranslator): string[] {
	const { t, locale } = translator;
	const lines: string[] = [];
	const calendarEvent = approvalEventFact(event.riskFacts);
	if (calendarEvent) {
		const when = formatApprovalEventWhen(calendarEvent, locale);
		if (when) lines.push(when);
		if (calendarEvent.location) lines.push(t("agentCards.approval.eventLocation", { location: calendarEvent.location }));
		if (calendarEvent.guests.length > 0) {
			lines.push(t("agentCards.approval.eventGuests", { guests: formatList(calendarEvent.guests, locale) }));
			if (calendarEvent.notifyGuests !== undefined) lines.push(calendarEvent.notifyGuests ? t("agentCards.approval.eventNotify") : t("agentCards.approval.eventNoNotify"));
		}
	}
	const message = approvalMessageFact(event.riskFacts);
	if (message) {
		if (message.subject) lines.push(t("agentCards.approval.subject", { subject: message.subject }));
		if (message.from) lines.push(message.from === "gmail" ? t("agentCards.approval.fromGmail") : t("agentCards.approval.fromBot"));
	}
	return lines;
}

/** O corpo inteiro do e-mail a enviar (para o trecho recolhível do card), ou `null`. */
export function approvalMessageBody(event: ApprovalEvent): string | null {
	return approvalMessageFact(event.riskFacts)?.body ?? null;
}

function collectDetailValues(args: unknown, max: number): string[] {
	const out: string[] = [];
	const visit = (value: unknown, depth: number) => {
		if (out.length >= max || depth > 2) return;
		if (typeof value === "string") {
			const text = shortText(value, 200);
			if (text) out.push(text);
		} else if (typeof value === "number" && Number.isFinite(value)) {
			out.push(String(value));
		} else if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
		} else if (value && typeof value === "object") {
			for (const item of Object.values(value)) visit(item, depth + 1);
		}
	};
	visit(args, 0);
	return out;
}

/**
 * Passo a passo do "isso é com você": o texto vem pronto do motor, no idioma do bot. Uma linha por passo;
 * a numeração ou o marcador que o texto já traz sai, porque a lista da tela numera.
 */
export function handoffSteps(message: string): string[] {
	return message
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^(?:\d{1,2}[.)]|[-*•])\s+/, ""))
		.filter(Boolean);
}

export type AskOwnerStatus = "pending" | "submitted" | "dismissed";

/** Monta a mensagem de questionário da pergunta do bot (alternativas + campo livre do próprio questionário). */
export function askOwnerQuestionnaire(
	card: Extract<AgentV4Event, { type: "ask_owner" }>,
	title: string,
	status: AskOwnerStatus,
	answers?: Record<string, string | string[]>,
): Extract<Message, { kind: "questionnaire" }> {
	const choices = card.choices?.map((choice) => ({ value: choice.value, label: choice.label, description: choice.description }));
	return {
		id: `ask-owner-${card.cardId}`,
		kind: "questionnaire",
		questionnaireId: card.cardId,
		title,
		items: [{ name: "answer", prompt: card.question.trim() || card.offer || "", required: true, ...(choices && choices.length > 0 && { choices }) }],
		status,
		...(answers && { answers }),
	};
}

/** Texto da resposta do dono: rótulo da alternativa escolhida (ou o próprio valor); lista junta com ", ". */
export function askOwnerAnswerText(
	card: Extract<AgentV4Event, { type: "ask_owner" }>,
	value: string | string[] | undefined,
): string {
	const values = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((entry) => entry.trim()).filter(Boolean);
	return values.map((entry) => card.choices?.find((choice) => choice.value === entry)?.label ?? entry).join(", ");
}
