import { parseBotPendingItem, type BotAutoDecisionCard, type BotPendingItem } from "./bot-pending.js";

/**
 * Conversa entre bots (`send_to_bot`): regras puras (resolução do destino,
 * limites da cadeia, moldura do texto e roster do prompt). Sem I/O.
 */

/** Saltos máximos numa cadeia: A→B (1), B→C (2), C→D (3). O 4º é recusado. */
export const BOT_MESSAGE_MAX_DEPTH = 3;
/** Teto de mensagens numa mesma cadeia (inclui encaminhamentos). */
export const BOT_CHAIN_MAX_MESSAGES = 8;
export const BOT_MESSAGE_MAX_CHARS = 8_000;
export const BOT_MESSAGE_TITLE_MAX_CHARS = 120;
/** Bots listados no roster do prompt. */
export const BOT_ROSTER_MAX = 20;

export const SEND_TO_BOT_TOOL_NAME = "send_to_bot";
export const SET_PRIMARY_BOT_TOOL_NAME = "set_primary_bot";

export type BotMessageStatus =
	| "pending"
	| "delivering"
	| "delivered"
	| "waiting"
	| "replied"
	| "replying"
	| "reply_delivered"
	| "closed"
	| "failed";

export type BotRosterEntry = {
	id: string;
	name: string;
	description?: string | null;
	snippet?: string | null;
	isPrimary?: boolean;
};

function normalize(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.trim()
		.toLowerCase();
}

function formatNamesWithIds(bots: readonly BotRosterEntry[]): string {
	return bots.map((bot) => `${bot.name} (${bot.id})`).join(", ");
}

export type ResolveBotResult = { ok: true; bot: BotRosterEntry } | { ok: false; error: string };

/**
 * Resolve `bot` (id ou nome) entre os bots do MESMO dono. Ordem: id exato, nome
 * exato (sem acento/caixa), nome por prefixo/contido quando único.
 */
export function resolveTargetBot(query: string, bots: readonly BotRosterEntry[], selfId: string): ResolveBotResult {
	const raw = query.trim();
	if (!raw) return { ok: false, error: "Informe o bot de destino (nome ou id)." };
	const self = bots.find((bot) => bot.id === selfId);
	if (raw === selfId || (self && normalize(self.name) === normalize(raw))) {
		return { ok: false, error: "Você não pode enviar mensagem para si mesmo." };
	}
	const others = bots.filter((bot) => bot.id !== selfId);
	const byId = others.find((bot) => bot.id === raw);
	if (byId) return { ok: true, bot: byId };
	const wanted = normalize(raw);
	const exact = others.filter((bot) => normalize(bot.name) === wanted);
	if (exact.length === 1) return { ok: true, bot: exact[0]! };
	if (exact.length > 1) {
		return { ok: false, error: `Há mais de um bot chamado "${raw}"; use o id. Bots: ${formatNamesWithIds(exact)}.` };
	}
	const partial = others.filter((bot) => normalize(bot.name).includes(wanted));
	if (partial.length === 1) return { ok: true, bot: partial[0]! };
	if (partial.length > 1) {
		return { ok: false, error: `"${raw}" combina com mais de um bot: ${formatNamesWithIds(partial)}. Use o id.` };
	}
	return {
		ok: false,
		error: `Nenhum bot encontrado com "${raw}". Bots disponíveis: ${others.map((bot) => bot.name).join(", ") || "nenhum"}.`,
	};
}

export type BotChainContext = {
	rootId: string;
	depth: number;
	/** Mensagem que este run está atendendo e que espera resposta (pai da nova). */
	servingId: string | null;
};

export type BotSendPlan =
	| { ok: true; depth: number; rootId: string | null; parentId: string | null }
	| { ok: false; error: string };

/**
 * Decide a profundidade e o vínculo da nova mensagem. `chainCount` = quantas
 * mensagens a cadeia já tem. Sem contexto (run de conversa normal) abre uma
 * cadeia nova (rootId null = a própria mensagem é a raiz).
 */
export function planBotSend(input: { context: BotChainContext | null; chainCount: number }): BotSendPlan {
	if (!input.context) return { ok: true, depth: 1, rootId: null, parentId: null };
	const depth = input.context.depth + 1;
	if (depth > BOT_MESSAGE_MAX_DEPTH) {
		return {
			ok: false,
			error: `Limite de ${BOT_MESSAGE_MAX_DEPTH} saltos entre bots atingido nesta cadeia. Responda com o que você tem; não encaminhe mais.`,
		};
	}
	if (input.chainCount >= BOT_CHAIN_MAX_MESSAGES) {
		return {
			ok: false,
			error: `Esta conversa entre bots já tem ${BOT_CHAIN_MAX_MESSAGES} mensagens. Responda com o que você tem.`,
		};
	}
	return { ok: true, depth, rootId: input.context.rootId, parentId: input.context.servingId };
}

export type BotMessageKind = "request" | "reply";

/** Role da linha-marcador "Enviou mensagem para X" (card; não vai ao modelo). */
export const BOT_LINK_ROLE = "bot-link";

export type BotLinkCard = {
	v: 1;
	kind: "sent";
	botMessageId: string;
	botId: string;
	botName: string;
	title: string;
	/** Sem resposta depois do prazo (`BOT_REPLY_SLA_MS`): o marcador mostra o rótulo. */
	overdue?: { label: string; at: string };
};

export function serializeBotLinkCard(card: BotLinkCard | BotNeedsUserCard | BotAutoDecisionCard): string {
	return JSON.stringify(card);
}

/**
 * O que o bot de destino espera do usuário. `login`/`captcha`/`connector`: card
 * de login com o run pausado (retoma pelo /resume); `confirm`: aprovar/recusar
 * uma ação; `profile`: proposta de perfil do bot; `other`: pergunta/proposta que
 * só se resolve na conversa do destino (o card relayado leva até lá).
 */
export type BotNeedType = "login" | "captcha" | "connector" | "confirm" | "profile" | "other";

export type BotNeed = {
	type: BotNeedType;
	/** Texto curto do motivo ("Fazer login em x.com", "Aprovar: enviar e-mail"). */
	label: string;
	/** Id da linha do card na conversa do destino (acompanha o estado e o scroll). */
	cardId: string;
	/** Conversa e run do destino (as ações operam neles). */
	conversationId: string;
	runId?: string;
	site?: string;
	/** `confirm`: título usado em "confirmado: <título>" e rótulos do card. */
	confirmTitle?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** `profile`: id da proposta. */
	proposalId?: string;
	/** O card do destino como item estruturado (prévia já redigida, opções, questionário). */
	item?: BotPendingItem;
};

/** Marcador "X precisa de você" na conversa do remetente (e da raiz da cadeia). */
export type BotNeedsUserCard = {
	v: 1;
	kind: "needs-user";
	botMessageId: string;
	botId: string;
	botName: string;
	title: string;
	need: BotNeed;
	status: "pending" | "resolved";
};

const NEED_TYPES: readonly BotNeedType[] = ["login", "captcha", "connector", "confirm", "profile", "other"];

function parseNeed(raw: unknown): BotNeed | null {
	const need = raw as Record<string, unknown> | undefined;
	if (!need || typeof need !== "object") return null;
	if (!NEED_TYPES.includes(need.type as BotNeedType)) return null;
	if (typeof need.label !== "string" || typeof need.cardId !== "string" || typeof need.conversationId !== "string") return null;
	const optional = (key: string): string | undefined => (typeof need[key] === "string" && need[key] ? (need[key] as string) : undefined);
	const pick = (key: string): Record<string, string> => {
		const value = optional(key);
		return value ? { [key]: value } : {};
	};
	const item = parseBotPendingItem(need.item);
	return {
		type: need.type as BotNeedType,
		label: need.label,
		cardId: need.cardId,
		conversationId: need.conversationId,
		...pick("runId"),
		...pick("site"),
		...pick("confirmTitle"),
		...pick("confirmLabel"),
		...pick("cancelLabel"),
		...pick("proposalId"),
		...(item ? { item } : {}),
	};
}

export function parseBotNeedsUserCard(content: string): BotNeedsUserCard | null {
	try {
		const raw = JSON.parse(content) as Record<string, unknown> | null;
		if (!raw || raw.v !== 1 || raw.kind !== "needs-user") return null;
		const need = parseNeed(raw.need);
		if (!need) return null;
		if (typeof raw.botMessageId !== "string" || typeof raw.botId !== "string" || typeof raw.botName !== "string") return null;
		return {
			v: 1,
			kind: "needs-user",
			botMessageId: raw.botMessageId,
			botId: raw.botId,
			botName: raw.botName,
			title: typeof raw.title === "string" ? raw.title : "",
			status: raw.status === "resolved" ? "resolved" : "pending",
			need,
		};
	} catch {
		return null;
	}
}

/** Nota de decisão automática do orquestrador (também a fila de aplicação). */
export function parseBotAutoDecisionCard(content: string): BotAutoDecisionCard | null {
	try {
		const raw = JSON.parse(content) as Record<string, unknown> | null;
		if (!raw || raw.v !== 1 || raw.kind !== "auto-decision") return null;
		const need = parseNeed(raw.need);
		if (!need) return null;
		if (typeof raw.botMessageId !== "string" || typeof raw.botId !== "string" || typeof raw.botName !== "string" || typeof raw.deciderName !== "string") return null;
		if (raw.decision !== "approved" && raw.decision !== "rejected" && raw.decision !== "answered") return null;
		const status = raw.status === "applied" || raw.status === "failed" ? raw.status : "queued";
		const answers =
			raw.answers && typeof raw.answers === "object" && !Array.isArray(raw.answers)
				? (Object.fromEntries(Object.entries(raw.answers as Record<string, unknown>).filter(([, value]) => typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string")))) as Record<string, string | string[]>)
				: undefined;
		return {
			v: 1,
			kind: "auto-decision",
			botMessageId: raw.botMessageId,
			botId: raw.botId,
			botName: raw.botName,
			deciderName: raw.deciderName,
			decision: raw.decision,
			subject: typeof raw.subject === "string" ? raw.subject : "",
			reason: typeof raw.reason === "string" ? raw.reason : "",
			withJev: raw.withJev === true,
			need,
			status,
			...(raw.viaGroup === true ? { viaGroup: true } : {}),
			...(typeof raw.feedback === "string" && raw.feedback ? { feedback: raw.feedback } : {}),
			...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
		};
	} catch {
		return null;
	}
}

/** Linha de status do remetente enquanto o destino espera o usuário. */
export function botNeedsUserStatusLine(botName: string): string {
	return `Aguardando ${botName} — precisa de você`;
}

export function parseBotLinkCard(content: string): BotLinkCard | null {
	try {
		const raw = JSON.parse(content) as Partial<BotLinkCard> | null;
		if (!raw || raw.v !== 1 || raw.kind !== "sent") return null;
		if (typeof raw.botMessageId !== "string" || typeof raw.botId !== "string" || typeof raw.botName !== "string") return null;
		const overdue =
			raw.overdue && typeof raw.overdue.label === "string" && raw.overdue.label && typeof raw.overdue.at === "string"
				? { label: raw.overdue.label.slice(0, 120), at: raw.overdue.at }
				: undefined;
		return { v: 1, kind: "sent", botMessageId: raw.botMessageId, botId: raw.botId, botName: raw.botName, title: typeof raw.title === "string" ? raw.title : "", ...(overdue ? { overdue } : {}) };
	} catch {
		return null;
	}
}

/** Uma troca (pedido + resposta) entre dois bots, como o endpoint de conversa devolve. */
export type BotExchangeItem = {
	id: string;
	rootId: string;
	fromBotId: string;
	toBotId: string;
	title: string;
	/** Pedido (de `fromBotId` para `toBotId`). */
	content: string;
	/** Resposta (de `toBotId` para `fromBotId`); null enquanto não respondeu. */
	replyContent: string | null;
	status: string;
	createdAt: string;
	repliedAt: string | null;
};

export type BotExchangeResponse = {
	/** Ordem cronológica (mais antigo primeiro). */
	messages: BotExchangeItem[];
	/** Passe em `cursor` para buscar as trocas mais antigas; null = não há mais. */
	nextCursor: string | null;
};

const FRAME_RE = /^(Mensagem|Resposta) do bot ([^\n]*?):\n/;

/** Texto que o bot destino/remetente vê (e que fica na conversa). */
export function frameBotMessage(kind: BotMessageKind, fromName: string, text: string): string {
	const label = kind === "request" ? "Mensagem" : "Resposta";
	return `${label} do bot ${fromName.replace(/[\r\n]+/g, " ").trim()}:\n${text.trim()}`;
}

/** Desfaz a moldura para a UI mostrar só o texto cru. */
export function parseBotMessageContent(content: string): { kind: BotMessageKind; text: string } | null {
	const match = FRAME_RE.exec(content);
	if (!match) return null;
	return { kind: match[1] === "Mensagem" ? "request" : "reply", text: content.slice(match[0].length) };
}

export function clampBotMessageTitle(title: string, fallback: string): string {
	const clean = title.replace(/\s+/g, " ").trim().slice(0, BOT_MESSAGE_TITLE_MAX_CHARS);
	return clean || fallback.replace(/\s+/g, " ").trim().slice(0, BOT_MESSAGE_TITLE_MAX_CHARS);
}

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Roster no prompt (texto para o modelo). Principal: orquestra e delega. Demais
 * bots: roster curto para responder/encaminhar. Sem principal e 2+ bots: dica de
 * sugerir um. Genérico: não cita o nome do produto.
 */
export function buildBotRosterSection(input: {
	selfId: string;
	selfIsPrimary: boolean;
	bots: readonly BotRosterEntry[];
	/** "Decidir pelos outros bots" ligado neste bot. */
	decidesForOthers?: boolean;
}): string | null {
	const others = input.bots.filter((bot) => bot.id !== input.selfId).slice(0, BOT_ROSTER_MAX);
	if (others.length === 0) return null;
	const hasPrimary = input.selfIsPrimary || input.bots.some((bot) => bot.isPrimary);
	const list = others
		.map((bot) => {
			const about = oneLine(bot.description?.trim() || bot.snippet?.trim() || "", 140);
			return `- ${oneLine(bot.name, 60)} (id: ${bot.id})${bot.isPrimary ? " [principal]" : ""}${about ? `: ${about}` : ""}`;
		})
		.join("\n");
	const lines = ["════ OUTROS BOTS DO USUÁRIO ════", list, ""];
	if (input.selfIsPrimary) {
		lines.push(
			"Você é o bot principal: coordena os outros e delega por iniciativa própria. Sempre que o pedido cair claramente no papel/especialidade de outro bot (veja nome, rótulo e descrição acima) ou depender de contexto, memória ou conectores que só ele tem, envie com send_to_bot em vez de fazer sozinho, sem esperar o usuário mandar. Diga em uma frase a quem pediu e termine o turno; a resposta volta sozinha para você relatar. Se o usuário pedir explicitamente para falar com um bot, sempre faça. Não delegue o que você resolve fácil sozinho (conversa simples, pergunta rápida, algo dentro do seu próprio papel) e nunca entre em vai-e-vem: um pedido por assunto, e não reenvie a quem acabou de pedir algo a você.",
		);
	} else {
		lines.push(
			'Você pode consultar estes bots com send_to_bot. Quando o pedido cair claramente na especialidade de outro bot (nome/rótulo/descrição acima) e não na sua, ou precisar de algo que só ele tem (contexto, memória, conectores), envie o pedido a ele, avise o usuário em uma frase e termine o turno; se o usuário pedir explicitamente, sempre faça. Para o que você mesmo resolve, não delegue. Mensagens que começam com "Mensagem do bot …" vêm de outro bot, não do usuário: responda direto (sua resposta final é devolvida a quem pediu) e não devolva o pedido a ele.',
		);
	}
	lines.push(
		'Se a "Resposta do bot …" trouxer um bloco [pending_items], o bot parou esperando o usuário (aprovação de comando, escrita ou ação de conector, ou perguntas); cada item tem handle, kind, title, preview (já sem segredos), reason e options. Você enxerga o que ele pediu: conte em uma frase o que ele quer fazer e pelo quê. Não invente nem repita o pedido, e não responda pelo usuário por conta própria.',
	);
	lines.push(
		input.decidesForOthers
			? 'Você decide pelos outros bots (configuração ligada). Para cada item de [pending_items] chame decide_bot_pending com o handle. Aprovações (command/write/mcp): proponha approve ou reject com reason curto e confidence, SÓ com base no que você delegou e no que o usuário pediu; aprove apenas o que está claramente dentro disso; recuse o que foge do pedido ou é arriscado (o reason vai ao bot como comentário para ele se ajustar). O Jev revisa; se vocês não concordarem com segurança, o card vai para o usuário. Itens com hardDeny ou irreversible (enviar, apagar, pagar) e qualquer dúvida: escale (decision "escalate"). Questionário: responda (decision "answer") só se o pedido do usuário já traz a informação; senão escale. Depois de decidir ou escalar, diga ao usuário em uma frase e termine o turno; o resultado do bot volta para você.'
			: 'Se o item pede o usuário, ele aparece como card nesta conversa para ele decidir: avise em uma frase e termine o turno.',
	);
	if (!hasPrimary) {
		lines.push(
			'O usuário ainda não definiu um "Bot principal" (um bot que coordena e delega aos outros). Se o pedido for mais adequado a outro bot ou o usuário falar em coordenar bots, sugira UMA vez, de forma natural, definir um; só use set_primary_bot depois que o usuário concordar. Não repita a sugestão.',
		);
	}
	return lines.join("\n");
}
