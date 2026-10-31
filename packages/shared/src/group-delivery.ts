/**
 * Grupos de bots: "ninguém fica preso esperando". Regras puras (sem I/O) para
 * 1) reconhecer a resposta de membro que NÃO entregou (devolveu pergunta ou "aguardando X"),
 * 2) decidir se o resumo do coordenador deve esperar um membro com aprovação pendente / continuação ativa,
 * 3) descrever, para o prompt do resumo, quem não entregou e por quê.
 */

/** Cobranças (rodada extra com "não espere, entregue") por membro em cada turno. */
export const GROUP_MAX_NUDGES_PER_MEMBER = 1;
/** Resposta a partir deste tamanho já traz conteúdo útil: pergunta no fim não conta como "sem entrega". */
const SUBSTANTIAL_CHARS = 600;
const SUBSTANTIAL_LINES = 6;
/** Letras/dígitos fora das frases de pedido a partir dos quais a resposta já traz conteúdo (a pergunta no fim é só cortesia). */
const SUBSTANCE_CHARS = 20;

export type UndeliveredReason = "empty" | "waiting" | "asks_input";

const WAITING = [
	/\baguard(ando|o|amos|ar|aremos)\b/i,
	/\bwaiting (for|on)\b/i,
	/\bpreciso (que|d[oae]s?|de)\b/i,
	/\bpreciso\s+(primeiro|antes)\b/i,
	/\bi need (you|the|a|an)\b/i,
	/\bme (envie|envia|mande|manda|passe|passa|forne[cç]a)\b/i,
	/\bse (voc[eê]|vc|tu) (me )?(enviar|mandar|passar|fornecer|informar|der)\b/i,
	/\bsend me\b/i,
	/\bassim que (voc[eê]|vc|eu receber|receber|tiver)\b/i,
	/\bn[aã]o (consigo|tenho como|d[aá] para) .{0,60}\bsem (o|a|os|as|um|uma)\b/i,
];

const letters = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
const isAsk = (sentence: string): boolean => WAITING.some((pattern) => pattern.test(sentence)) || /\?["')\]*_\s]*$/.test(sentence.trim());

/**
 * A resposta do membro devolve o problema em vez de entregar? `null` = entregou (ou há conteúdo útil).
 * Conservadora: resposta longa/estruturada, ou com conteúdo antes do pedido ("A, B, C. Quer que eu aprofunde?"), é entrega.
 * `empty` só para vazio ou só marcador; entrega curta ("Feito.") passa.
 */
export function detectUndelivered(text: string | null | undefined): UndeliveredReason | null {
	const body = (text ?? "").trim();
	if (letters(body) === 0) return "empty";
	const lines = body.split("\n").filter((line) => line.trim()).length;
	if (body.length >= SUBSTANTIAL_CHARS || lines >= SUBSTANTIAL_LINES) return null;
	const sentences = body.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim());
	const asks = sentences.filter(isAsk);
	if (asks.length === 0) return null;
	const substance = letters(sentences.filter((sentence) => !isAsk(sentence)).join(" "));
	if (substance >= SUBSTANCE_CHARS) return null;
	return asks.some((sentence) => WAITING.some((pattern) => pattern.test(sentence))) ? "waiting" : "asks_input";
}

/** Código gravado em `GroupReply.error` quando a resposta terminou mas não entregou. */
export const UNDELIVERED_ERROR_PREFIX = "undelivered:";
export const undeliveredError = (reason: UndeliveredReason | "pending_approval" | "still_running"): string => `${UNDELIVERED_ERROR_PREFIX}${reason}`;

const REASON_TEXT: Record<string, string> = {
	empty: "replied with nothing useful",
	waiting: "replied that it is waiting for something instead of delivering",
	asks_input: "replied with a question instead of delivering",
	pending_approval: "its approval request was not answered in time",
	still_running: "was still running when the deadline came",
	no_progress: "did not finish in time",
};

export type WorkerDeliveryRow = { botId: string; createdAt: Date; status: string; error: string | null };

/** Quem não entregou no turno (a tentativa mais recente de cada membro) e o motivo curto, em inglês para o prompt. */
export function describeMissingDeliveries(rows: readonly WorkerDeliveryRow[]): Array<{ botId: string; reason: string }> {
	const latest = new Map<string, WorkerDeliveryRow>();
	for (const row of rows) {
		const current = latest.get(row.botId);
		if (!current || row.createdAt.getTime() >= current.createdAt.getTime()) latest.set(row.botId, row);
	}
	const out: Array<{ botId: string; reason: string }> = [];
	for (const row of latest.values()) {
		const code = row.error?.startsWith(UNDELIVERED_ERROR_PREFIX) ? row.error.slice(UNDELIVERED_ERROR_PREFIX.length) : row.error === "no_progress" ? "no_progress" : null;
		if (code) out.push({ botId: row.botId, reason: REASON_TEXT[code] ?? "did not deliver" });
		else if (row.status === "failed") out.push({ botId: row.botId, reason: "could not run" });
		else if (row.status === "skipped") out.push({ botId: row.botId, reason: "was not able to answer" });
	}
	return out;
}

export type SummaryHoldInput = {
	/** Tentativa mais recente de cada membro já encerrada no turno. */
	workers: ReadonlyArray<{ botId: string; finishedAt: Date | null }>;
	/** Membros com cartão de aprovação ainda decidível (intenção não expirada) na conversa do grupo. */
	pendingBotIds: ReadonlySet<string>;
	/** Membros com run ativo (continuação depois do aceite) na conversa do grupo. */
	activeBotIds: ReadonlySet<string>;
	now: Date;
	holdMs: number;
};

/**
 * O resumo espera enquanto algum membro tem aprovação decidível ou continuação ativa, até `holdMs`
 * depois de ele terminar. Passado o prazo o resumo segue sem ele (`timedOut` = marcar a parte que faltou).
 */
export function decideSummaryHold(input: SummaryHoldInput): { hold: boolean; timedOut: string[] } {
	let hold = false;
	const timedOut: string[] = [];
	for (const worker of input.workers) {
		if (!input.pendingBotIds.has(worker.botId) && !input.activeBotIds.has(worker.botId)) continue;
		const waitedMs = worker.finishedAt ? input.now.getTime() - worker.finishedAt.getTime() : 0;
		if (waitedMs < input.holdMs) hold = true;
		else timedOut.push(worker.botId);
	}
	return { hold, timedOut: hold ? [] : timedOut };
}
