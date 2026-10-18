/**
 * Conversa entre bots: o que o bot de destino espera do usuário (card de
 * aprovação, questionário...) como item estruturado que o orquestrador lê, mais
 * a regra pura de decisão ("Decidir pelos outros bots"). Sem I/O.
 */
import type { BotNeed } from "./bot-messaging.js";
import { DEV_APPROVAL_COMMAND_MAX_CHARS, hardDenyReason, parseDevApprovalInfo, type DevApprovalCardInfo } from "./dev-command-approval.js";
import { redactSecrets } from "./redact-secrets.js";
import { parseConversationCard, type QuestionnaireCardItem } from "./skill-card.js";

// ---------------------------------------------------------------------------
// Configuração (policyJson do bot orquestrador)
// ---------------------------------------------------------------------------

export const DECIDE_FOR_OTHER_BOTS_KEY = "decideForOtherBots";

/** Liga "Decidir pelos outros bots" (`policyJson.decideForOtherBots === true`). Padrão: desligado. */
export function readDecideForOtherBots(policyJson: unknown): boolean {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return false;
	return (policyJson as Record<string, unknown>)[DECIDE_FOR_OTHER_BOTS_KEY] === true;
}

/** Nova política com o interruptor trocado, sem perder as outras chaves. */
export function withDecideForOtherBots(policyJson: unknown, enabled: boolean): Record<string, unknown> {
	const base =
		policyJson && typeof policyJson === "object" && !Array.isArray(policyJson)
			? { ...(policyJson as Record<string, unknown>) }
			: {};
	if (enabled) base[DECIDE_FOR_OTHER_BOTS_KEY] = true;
	else delete base[DECIDE_FOR_OTHER_BOTS_KEY];
	return base;
}

export const DECIDE_FOR_OTHER_BOTS_LABEL = "Decidir pelos outros bots";
export const DECIDE_FOR_OTHER_BOTS_HINT =
	"Aprovações e perguntas dos bots que este bot aciona são decididas por ele junto com o Jev; se não tiver certeza, chegam para você.";

// ---------------------------------------------------------------------------
// Item pendente
// ---------------------------------------------------------------------------

export type BotPendingKind = "command" | "write" | "mcp" | "questionnaire" | "other";

export type BotPendingOption = { value: string; label: string };

export type BotPendingQuestionnaire = {
	id: string;
	description?: string;
	items: QuestionnaireCardItem[];
};

/** Um card do bot de destino que espera o usuário, como o orquestrador o enxerga. */
export type BotPendingItem = {
	/** Id da linha do card na conversa do destino: serve para responder. */
	handle: string;
	kind: BotPendingKind;
	title: string;
	/** Comando, diff ou argumentos, já redigidos como o card. */
	preview?: string;
	reason?: string;
	options: BotPendingOption[];
	/** Ação MCP irreversível (enviar, apagar, pagar): nunca decidida automaticamente. */
	irreversible?: boolean;
	/** Bloqueio fixo do comando (`hardDenyReason`): nunca decidido automaticamente. */
	hardDeny?: string;
	confirmId?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	devApproval?: DevApprovalCardInfo;
	questionnaire?: BotPendingQuestionnaire;
};

const PREVIEW_MAX = 1_500;
const TEXT_MAX = 300;

const clip = (value: string, max: number): string => redactSecrets(value).slice(0, max);

function redactDevApproval(info: DevApprovalCardInfo): DevApprovalCardInfo {
	if (info.kind === "command") {
		return { ...info, command: redactSecrets(info.command).slice(0, DEV_APPROVAL_COMMAND_MAX_CHARS), ...(info.reason ? { reason: clip(info.reason, 200) } : {}) };
	}
	return { ...info, path: clip(info.path, 1_000), preview: redactSecrets(info.preview) };
}

/** O que a API guardou ao criar o card (intenção pendente): tipo da ação e, se MCP, a classe. */
export type PendingIntentHint = { action?: string; confirmId?: string; actionClass?: "write" | "irreversible" };

/**
 * Linha de card da conversa do destino → item pendente. `null` = não está
 * pendente (ou não espera ação humana). Tudo que sai daqui passa por redação.
 */
export function buildBotPendingItem(input: {
	rowId: string;
	role: string;
	content: string;
	intent?: PendingIntentHint | null;
}): BotPendingItem | null {
	const card = parseConversationCard(input.content);
	if (!card) return null;
	if (card.kind === "questionnaire") {
		if (card.status !== "pending") return null;
		return {
			handle: input.rowId,
			kind: "questionnaire",
			title: clip(card.title, 160),
			...(card.description ? { reason: clip(card.description, TEXT_MAX) } : {}),
			options: [{ value: "answer", label: "Responder" }],
			questionnaire: { id: card.questionnaireId, ...(card.description ? { description: clip(card.description, TEXT_MAX) } : {}), items: card.items },
		};
	}
	if (card.kind === "confirm") {
		if (card.status !== "pending") return null;
		const confirmLabel = card.confirmLabel ?? "Executar";
		const cancelLabel = card.cancelLabel ?? "Pular";
		const base = {
			handle: input.rowId,
			title: clip(card.title, 160),
			options: [
				{ value: "approve", label: confirmLabel },
				{ value: "reject", label: cancelLabel },
			],
			confirmId: card.confirmId,
			confirmLabel,
			cancelLabel,
		};
		const dev = card.devApproval;
		if (dev) {
			const safe = redactDevApproval(dev);
			if (safe.kind === "command") {
				const denied = dev.kind === "command" ? hardDenyReason(dev.command) : null;
				return {
					...base,
					kind: "command",
					preview: clip(safe.command, PREVIEW_MAX),
					...(safe.reason ? { reason: safe.reason } : {}),
					...(denied ? { hardDeny: denied } : {}),
					devApproval: safe,
				};
			}
			return {
				...base,
				kind: "write",
				preview: clip(`${safe.path}\n${safe.preview}`, PREVIEW_MAX),
				devApproval: safe,
			};
		}
		const description = card.description ? clip(card.description, PREVIEW_MAX) : undefined;
		const mcp = input.intent?.action === "mcp-call";
		return {
			...base,
			kind: mcp ? "mcp" : "other",
			...(description ? { preview: description } : {}),
			...(mcp && input.intent?.actionClass === "irreversible" ? { irreversible: true } : {}),
			// Classe desconhecida de uma ação MCP: trata como irreversível (nunca automático).
			...(mcp && !input.intent?.actionClass ? { irreversible: true } : {}),
		};
	}
	if (card.kind === "login") {
		if (card.status !== "pending") return null;
		return { handle: input.rowId, kind: "other", title: clip(`Login em ${card.site}`, 160), options: [] };
	}
	if (card.kind === "bot-profile") {
		if (card.status !== "pending") return null;
		return { handle: input.rowId, kind: "other", title: "Mudança no perfil do bot", options: [{ value: "approve", label: "Aprovar" }, { value: "reject", label: "Recusar" }] };
	}
	return null;
}

function asString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

const KINDS: readonly BotPendingKind[] = ["command", "write", "mcp", "questionnaire", "other"];

/** Valida o item vindo do banco (nunca confia no formato). */
export function parseBotPendingItem(raw: unknown): BotPendingItem | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const row = raw as Record<string, unknown>;
	const handle = asString(row.handle, 200);
	const title = asString(row.title, 300);
	if (!handle || !title || !KINDS.includes(row.kind as BotPendingKind)) return undefined;
	const options: BotPendingOption[] = [];
	if (Array.isArray(row.options)) {
		for (const option of row.options.slice(0, 8)) {
			const value = option && typeof option === "object" ? asString((option as Record<string, unknown>).value, 80) : undefined;
			const label = option && typeof option === "object" ? asString((option as Record<string, unknown>).label, 120) : undefined;
			if (value && label) options.push({ value, label });
		}
	}
	const devApproval = parseDevApprovalInfo(row.devApproval);
	let questionnaire: BotPendingQuestionnaire | undefined;
	const q = row.questionnaire;
	if (q && typeof q === "object" && !Array.isArray(q)) {
		const qr = q as Record<string, unknown>;
		const id = asString(qr.id, 200);
		const parsed = id ? parseConversationCard(JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: id, title, status: "pending", items: qr.items })) : null;
		if (id && parsed && parsed.kind === "questionnaire") {
			questionnaire = { id, ...(asString(qr.description, TEXT_MAX) ? { description: asString(qr.description, TEXT_MAX)! } : {}), items: parsed.items };
		}
	}
	const optional = (key: string, max: number): Record<string, string> => {
		const value = asString(row[key], max);
		return value ? { [key]: value } : {};
	};
	return {
		handle,
		kind: row.kind as BotPendingKind,
		title,
		options,
		...optional("preview", PREVIEW_MAX),
		...optional("reason", TEXT_MAX),
		...optional("hardDeny", 200),
		...optional("confirmId", 200),
		...optional("confirmLabel", 80),
		...optional("cancelLabel", 80),
		...(row.irreversible === true ? { irreversible: true } : {}),
		...(devApproval ? { devApproval } : {}),
		...(questionnaire ? { questionnaire } : {}),
	};
}

/** Texto estruturado que o orquestrador lê junto da resposta do bot de destino. */
export const PENDING_ITEMS_OPEN = "[pending_items]";
export const PENDING_ITEMS_CLOSE = "[/pending_items]";

export function formatPendingItemsForModel(items: readonly BotPendingItem[]): string {
	if (items.length === 0) return "";
	const payload = items.map((item) => ({
		handle: item.handle,
		kind: item.kind,
		title: item.title,
		...(item.preview ? { preview: item.preview } : {}),
		...(item.reason ? { reason: item.reason } : {}),
		options: item.options.map((option) => option.value),
		...(item.hardDeny ? { hardDeny: item.hardDeny } : {}),
		...(item.irreversible ? { irreversible: true } : {}),
		...(item.questionnaire
			? {
					questions: item.questionnaire.items.map((question) => ({
						name: question.name,
						prompt: question.prompt,
						...(question.required ? { required: true } : {}),
						...(question.multiple ? { multiple: true } : {}),
						...(question.choices ? { choices: question.choices.map((choice) => choice.value) } : {}),
					})),
				}
			: {}),
	}));
	return `${PENDING_ITEMS_OPEN}\n${JSON.stringify(payload)}\n${PENDING_ITEMS_CLOSE}`;
}

/** Extrai o bloco `[pending_items]` de um texto (para testes e para a UI esconder o JSON). */
export function splitPendingItemsBlock(text: string): { text: string; items: unknown[] } {
	const start = text.indexOf(PENDING_ITEMS_OPEN);
	const end = text.indexOf(PENDING_ITEMS_CLOSE);
	if (start < 0 || end < start) return { text, items: [] };
	const json = text.slice(start + PENDING_ITEMS_OPEN.length, end).trim();
	let items: unknown[] = [];
	try {
		const parsed = JSON.parse(json) as unknown;
		if (Array.isArray(parsed)) items = parsed;
	} catch {
		items = [];
	}
	return { text: (text.slice(0, start) + text.slice(end + PENDING_ITEMS_CLOSE.length)).trim(), items };
}

// ---------------------------------------------------------------------------
// Decisão
// ---------------------------------------------------------------------------

export const PENDING_AUTO_THRESHOLD = 0.8;
/** Abaixo disto o Jev considera "claramente fora do pedido / inseguro" (para recusar). */
export const PENDING_AUTO_REJECT_CEILING = 0.2;

export type PendingProposal = { decision: "approve" | "reject"; reason: string; confidence: number };

/** Probabilidades "sim" do Jev; `null` = indisponível (desligado, sem chave ou falhou). */
export type PendingJevVerdict = { withinScope: number; reversible: number; harmlessOutward: number } | null;

export type PendingDecision =
	| { action: "auto-approve"; why: string }
	| { action: "auto-reject"; why: string }
	| { action: "relay"; why: PendingRelayReason };

export type PendingRelayReason =
	| "setting-off"
	| "unattended"
	| "not-decidable"
	| "hard-deny"
	| "irreversible"
	| "jev-unavailable"
	| "no-proposal"
	| "low-confidence"
	| "disagree";

/**
 * Matriz de decisão de aprovações (comando, escrita, MCP). Automático só quando o
 * orquestrador e o Jev concordam com alta confiança; todo o resto vai para o usuário.
 */
export function decideBotPending(input: {
	enabled: boolean;
	unattended: boolean;
	item: BotPendingItem;
	proposal: PendingProposal | null;
	jev: PendingJevVerdict;
}): PendingDecision {
	if (!input.enabled) return { action: "relay", why: "setting-off" };
	if (input.unattended) return { action: "relay", why: "unattended" };
	const { item } = input;
	if (item.kind !== "command" && item.kind !== "write" && item.kind !== "mcp") return { action: "relay", why: "not-decidable" };
	if (item.hardDeny) return { action: "relay", why: "hard-deny" };
	if (item.irreversible) return { action: "relay", why: "irreversible" };
	if (!input.jev) return { action: "relay", why: "jev-unavailable" };
	const proposal = input.proposal;
	if (!proposal) return { action: "relay", why: "no-proposal" };
	if (!Number.isFinite(proposal.confidence) || proposal.confidence < PENDING_AUTO_THRESHOLD) return { action: "relay", why: "low-confidence" };
	const { withinScope, reversible, harmlessOutward } = input.jev;
	if (proposal.decision === "approve") {
		const jevApproves = withinScope >= PENDING_AUTO_THRESHOLD && reversible >= PENDING_AUTO_THRESHOLD && harmlessOutward >= PENDING_AUTO_THRESHOLD;
		return jevApproves ? { action: "auto-approve", why: proposal.reason } : { action: "relay", why: "disagree" };
	}
	const jevRejects = withinScope <= PENDING_AUTO_REJECT_CEILING || harmlessOutward <= PENDING_AUTO_REJECT_CEILING;
	return jevRejects ? { action: "auto-reject", why: proposal.reason } : { action: "relay", why: "disagree" };
}

/** Respostas do questionário válidas contra os itens do card (obrigatórios preenchidos, escolhas existentes). */
export function validateQuestionnaireAnswers(
	items: readonly QuestionnaireCardItem[],
	answers: Record<string, unknown>,
): Record<string, string | string[]> | null {
	const out: Record<string, string | string[]> = {};
	for (const item of items) {
		const raw = answers[item.name];
		const values = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
		if (values.length === 0) {
			if (item.required) return null;
			continue;
		}
		if (item.choices && item.choices.length > 0 && !item.input) {
			if (!values.every((value) => item.choices!.some((choice) => choice.value === value))) return null;
		}
		if (!item.multiple && values.length > 1) return null;
		out[item.name] = item.multiple ? values : values[0]!;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** Questionário: o orquestrador responde sozinho só com respostas válidas (informação do pedido do usuário). */
export function decideBotQuestionnaire(input: {
	enabled: boolean;
	unattended: boolean;
	item: BotPendingItem;
	answers: Record<string, unknown> | null;
}): { action: "auto-answer"; answers: Record<string, string | string[]> } | { action: "relay"; why: PendingRelayReason } {
	if (!input.enabled) return { action: "relay", why: "setting-off" };
	if (input.unattended) return { action: "relay", why: "unattended" };
	if (input.item.kind !== "questionnaire" || !input.item.questionnaire) return { action: "relay", why: "not-decidable" };
	if (!input.answers) return { action: "relay", why: "no-proposal" };
	const valid = validateQuestionnaireAnswers(input.item.questionnaire.items, input.answers);
	return valid ? { action: "auto-answer", answers: valid } : { action: "relay", why: "no-proposal" };
}

// ---------------------------------------------------------------------------
// Nota de auditoria (conversa do orquestrador)
// ---------------------------------------------------------------------------

export type BotAutoDecisionKind = "approved" | "rejected" | "answered";

/**
 * Marcador neutro "Aprovado por <bot> + Jev: ...". Também é a fila de aplicação:
 * `queued` até a API responder o card do destino; depois `applied`/`failed`.
 */
export type BotAutoDecisionCard = {
	v: 1;
	kind: "auto-decision";
	botMessageId: string;
	/** Bot de destino (dono do card). */
	botId: string;
	botName: string;
	/** Bot que decidiu (orquestrador). */
	deciderName: string;
	decision: BotAutoDecisionKind;
	/** Comando/título decidido, já redigido. */
	subject: string;
	reason: string;
	withJev: boolean;
	need: BotNeed;
	status: "queued" | "applied" | "failed";
	/** Recusa: comentário enviado ao destino. Questionário: respostas dadas. */
	feedback?: string;
	answers?: Record<string, string | string[]>;
};

export function autoDecisionNote(card: Pick<BotAutoDecisionCard, "decision" | "deciderName" | "subject" | "reason" | "withJev">): string {
	const who = card.withJev ? `${card.deciderName} + Jev` : card.deciderName;
	const verb = card.decision === "approved" ? "Aprovado" : card.decision === "rejected" ? "Recusado" : "Respondido";
	return `${verb} por ${who}: ${card.subject}${card.reason ? ` — ${card.reason}` : ""}`;
}

export function buildAutoDecisionCard(input: Omit<BotAutoDecisionCard, "v" | "kind" | "status" | "subject" | "reason"> & { subject: string; reason: string }): BotAutoDecisionCard {
	return {
		...input,
		v: 1,
		kind: "auto-decision",
		status: "queued",
		subject: clip(input.subject.replace(/\s+/g, " ").trim(), 200),
		reason: clip(input.reason.replace(/\s+/g, " ").trim(), 300),
		...(input.feedback ? { feedback: clip(input.feedback, 400) } : {}),
	};
}
