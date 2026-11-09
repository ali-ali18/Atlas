// Cards do motor v4 no celular (aprovação, compra com CVV, "isso é com você", pergunta do bot, recibo). Parte pura,
// sem React: monta o item do fio a partir do evento (ao vivo e gravado, mesma chave que o web), diz em frase simples
// o que vai ser feito e prepara as respostas. O evento já vem validado por `parseAgentV4Event` (shared).
import { agentCardCallId, agentCardKey, approvalEventFact, approvalMessageFact, formatApprovalEventWhen, isAgentV4EventType, parseAgentV4Event, type AgentV4Event, type ComputerUseEvent, type QuestionnaireCardItem } from "@workspace/shared";
import type { ChatItem } from "./chat-types";

export type AgentCardItem = Extract<ChatItem, { kind: "agent-card" }>;
type ApprovalEvent = Extract<AgentV4Event, { type: "approval_request" }>;
type AskOwnerEvent = Extract<AgentV4Event, { type: "ask_owner" }>;

/** Prefixo do id do card ao vivo: o gravado (id do banco) vence quando os dois coexistem. */
export const LIVE_AGENT_CARD_PREFIX = "agent-card-";

/** Teto da resposta digitada à pergunta do bot (o mesmo do web). */
export const ASK_OWNER_ANSWER_MAX = 8_000;

export function agentCardItem(event: AgentV4Event, options: { id?: string; runId?: string; createdAt?: string } = {}): AgentCardItem {
	const card: AgentV4Event = event.runId || !options.runId ? event : { ...event, runId: options.runId };
	return { id: options.id ?? `${LIVE_AGENT_CARD_PREFIX}${agentCardKey(card)}`, kind: "agent-card", card, ...(options.createdAt ? { createdAt: options.createdAt } : {}) };
}

/** Card gravado na conversa (`role` = tipo do evento, `content` = o evento em JSON). Inválido = sem card. */
export function agentCardFromStored(id: string, role: string, content: string, options: { runId?: string; createdAt?: string } = {}): AgentCardItem | null {
	if (!isAgentV4EventType(role)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch {
		return null;
	}
	const event = parseAgentV4Event(raw);
	if (!event || event.type !== role) return null;
	return agentCardItem(event, { id, ...options });
}

/** O evento do stream que é um card v4 válido, ou `null`. */
export function asAgentCardEvent(event: ComputerUseEvent): AgentV4Event | null {
	return isAgentV4EventType(event.type) ? parseAgentV4Event(event) : null;
}

/** Card ao vivo na lista: o mesmo card (mesma chave) não entra duas vezes (reconexão reentrega os eventos). */
export function addAgentCard(items: ChatItem[], event: AgentV4Event, runId: string | null): ChatItem[] {
	const item = agentCardItem(event, runId ? { runId } : {});
	const key = agentCardKey(item.card);
	if (items.some((existing) => existing.kind === "agent-card" && agentCardKey(existing.card) === key)) return items;
	return [...items, item];
}

/** O resultado da chamada estacionada chegou: o pedido foi resolvido (aqui ou em outro aparelho). */
export function settleAgentCardsForCall(items: ChatItem[], callId: string, runId: string | null): ChatItem[] {
	let changed = false;
	const next = items.map((item) => {
		if (item.kind !== "agent-card" || item.settled || agentCardCallId(item.card) !== callId) return item;
		if (runId && item.card.runId && item.card.runId !== runId) return item;
		changed = true;
		return { ...item, settled: true };
	});
	return changed ? next : items;
}

// ---- frases ------------------------------------------------------------------------------------------------

const shortText = (value: unknown, max = 120): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

const textList = (value: unknown): string[] => (Array.isArray(value) ? value.map((entry) => shortText(entry)).filter((entry): entry is string => entry !== null) : []);

export function formatMoney(amount: number, currency: string): string {
	try {
		return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}

export type ApprovalFacts = { externalRecipients: string[]; irreversible: boolean };

export function approvalFacts(event: ApprovalEvent): ApprovalFacts {
	return { externalRecipients: textList(event.riskFacts.externalRecipients), irreversible: event.riskFacts.irreversible === true };
}

/** O que o bot vai fazer, numa frase simples. Nunca usa o nome da ferramenta nem nomes de campo. */
export function describeApproval(event: ApprovalEvent): string {
	const facts = event.riskFacts;
	const amount = typeof facts.amount === "number" && Number.isFinite(facts.amount) ? facts.amount : undefined;
	const currency = typeof facts.currency === "string" && /^[A-Za-z]{3}$/.test(facts.currency) ? facts.currency.toUpperCase() : undefined;
	const merchant = shortText(facts.merchant);
	const target = shortText(facts.target);
	const recipients = textList(facts.recipients);
	const calendarEvent = approvalEventFact(facts);
	if (calendarEvent) {
		const title = calendarEvent.title;
		if (calendarEvent.action === "delete") return title ? `Apagar o evento “${title}”` : "Apagar um evento da agenda";
		if (calendarEvent.action === "update") return title ? `Alterar o evento “${title}”` : "Alterar um evento da agenda";
		return title ? `Criar o evento “${title}”` : "Criar um evento na agenda";
	}
	switch (event.effect) {
		case "money": {
			const total = amount !== undefined ? (currency ? formatMoney(amount, currency) : String(amount)) : null;
			if (total && merchant) return `Pagar ${total} em ${merchant}`;
			if (total) return `Pagar ${total}`;
			return merchant ? `Fazer um pagamento em ${merchant}` : "Fazer um pagamento";
		}
		case "send":
			return recipients.length > 0 ? `Enviar para ${recipients.join(", ")}` : "Enviar uma mensagem";
		case "public_link":
			return target ? `Criar um link público de ${target}` : "Criar um link público";
		case "destructive":
			return target ? `Apagar ${target}` : "Apagar um item";
		case "credential":
			return target ? `Usar ${target}` : "Usar uma senha ou chave salva";
		case "write_external":
			return target ? `Alterar ${target}` : "Fazer uma alteração fora do Atlas";
		case "write_internal":
			return target ? `Salvar ${target}` : "Salvar uma alteração";
		case "draft":
			return target ? `Preparar um rascunho de ${target}` : "Preparar um rascunho";
		case "read":
			return target ? `Consultar ${target}` : "Consultar uma informação";
	}
}

/** Valores simples dos argumentos (sem os nomes dos campos, que são internos). Credencial não mostra nada. */
export function approvalDetails(event: ApprovalEvent, max = 6): string[] {
	// Evento e e-mail têm linhas próprias (`approvalSummaryLines`): os argumentos crus trariam o id do evento e campos internos.
	if (event.effect === "credential" || approvalEventFact(event.riskFacts) || approvalMessageFact(event.riskFacts)) return [];
	const out: string[] = [];
	const visit = (value: unknown, depth: number) => {
		if (out.length >= max || depth > 2) return;
		if (typeof value === "string") {
			const text = shortText(value, 200);
			if (text) out.push(text);
		} else if (typeof value === "number" && Number.isFinite(value)) {
			out.push(String(value));
		} else if (Array.isArray(value)) {
			for (const entry of value) visit(entry, depth + 1);
		} else if (value && typeof value === "object") {
			for (const entry of Object.values(value)) visit(entry, depth + 1);
		}
	};
	visit(event.args, 0);
	return out;
}

/** Pagamento sem o formulário do cartão: o `checkout` declara o campo do código e vira o card de compra; qualquer outro pedido de dinheiro não pode ser aprovado por este card. */
export function approvalPaysWithoutForm(event: ApprovalEvent): boolean {
	return event.effect === "money";
}

/** Linhas do que vai ser feito para eventos de agenda e e-mails: quando, onde, quem, assunto (mesmas do web, em pt-BR). */
export function approvalSummaryLines(event: ApprovalEvent): string[] {
	const lines: string[] = [];
	const calendarEvent = approvalEventFact(event.riskFacts);
	if (calendarEvent) {
		// Leitura do evento falhou: não esconde a identificação, avisa e mostra o identificador.
		const eventId = typeof (event.args as { eventId?: unknown } | null)?.eventId === "string" ? (event.args as { eventId: string }).eventId.slice(0, 120) : null;
		if (!calendarEvent.title && calendarEvent.action !== "create") lines.push(eventId ? `Não consegui ler o evento. Identificador: ${eventId}` : "Não consegui ler o evento.");
		const when = formatApprovalEventWhen(calendarEvent, "pt-BR");
		if (when) lines.push(when);
		if (calendarEvent.location) lines.push(`Local: ${calendarEvent.location}`);
		if (calendarEvent.guests.length > 0) {
			lines.push(`Convidados: ${calendarEvent.guests.join(", ")}`);
			if (calendarEvent.notifyGuests !== undefined) lines.push(calendarEvent.notifyGuests ? "Os convidados vão receber um e-mail." : "Os convidados não serão avisados.");
		}
	}
	const message = approvalMessageFact(event.riskFacts);
	if (message) {
		if (message.subject) lines.push(`Assunto: ${message.subject}`);
		if (message.from) lines.push(message.from === "gmail" ? "Sai do seu Gmail." : "Sai da caixa de e-mail do bot.");
	}
	return lines;
}

/** O corpo inteiro do e-mail a enviar (trecho recolhível do card), ou `null`. */
export function approvalMessageBody(event: ApprovalEvent): string | null {
	return approvalMessageFact(event.riskFacts)?.body ?? null;
}

/** Passo a passo do "isso é com você": uma linha por passo, sem a numeração que o texto já traz. */
export function handoffSteps(message: string): string[] {
	return message
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^(?:\d{1,2}[.)]|[-*•])\s+/, ""))
		.filter(Boolean);
}

/** Link do recibo só se for http(s). */
export function safeReceiptUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
	} catch {
		return null;
	}
}

// ---- pergunta do bot --------------------------------------------------------------------------------------

/** A pergunta vira um item de questionário (alternativas + campo livre), no mesmo molde do web. */
export function askOwnerQuestionnaireItem(card: AskOwnerEvent): QuestionnaireCardItem {
	const choices = card.choices?.map((choice) => ({ value: choice.value, ...(choice.label ? { label: choice.label } : {}), ...(choice.description ? { description: choice.description } : {}) }));
	return { name: "answer", prompt: card.question.trim() || card.offer || "", required: true, input: { label: "Sua resposta", placeholder: "Digite sua própria resposta" }, ...(choices && choices.length > 0 ? { choices } : {}) };
}

/** Texto da resposta: rótulo da alternativa escolhida (ou o próprio valor); lista junta com ", ". */
export function askOwnerAnswerText(card: AskOwnerEvent, value: string | string[] | undefined): string {
	const values = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((entry) => entry.trim()).filter(Boolean);
	return values.map((entry) => card.choices?.find((choice) => choice.value === entry)?.label ?? entry).join(", ");
}

// ---- CVV --------------------------------------------------------------------------------------------------

/** CVV: só dígitos, no máximo 4. O valor vive no campo; nada daqui guarda o texto. */
export const cvvDigits = (text: string): string => text.replace(/\D/g, "").slice(0, 4);
export const cvvComplete = (text: string): boolean => text.length === 3 || text.length === 4;

// ---- estado do card na tela -------------------------------------------------------------------------------

export type AgentCardDecision = "approved" | "denied" | "done" | "answered" | "dismissed";

/**
 * O card ainda pede o dono? Aprovação e "isso é com você" só enquanto o run está parado esperando (o `runId` do card é o
 * do run parado); a pergunta do bot, enquanto o dono não falou de outra coisa depois dela (a oferta vira "ignorada").
 */
export function agentCardPending(item: AgentCardItem, context: { pausedRunId: string | null; laterUserMessage: boolean }, decision?: AgentCardDecision): boolean {
	if (decision || item.settled) return false;
	switch (item.card.type) {
		case "approval_request":
		case "handoff_request":
			return Boolean(item.card.runId) && item.card.runId === context.pausedRunId;
		case "ask_owner":
			return Boolean(item.card.runId) && !context.laterUserMessage;
		case "receipt":
			return false;
	}
}
