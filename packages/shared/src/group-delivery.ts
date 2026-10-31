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
const SHORTEST_DELIVERY = 12;

export type UndeliveredReason = "empty" | "waiting" | "asks_input";

const WAITING = [
	/\baguard(ando|o|amos|ar|aremos)\b/i,
	/\bwaiting (for|on)\b/i,
	/\bpreciso (que|d[oae]s?|de)\b/i,
	/\bpreciso\s+(primeiro|antes)\b/i,
	/\bi need (you|the|a|an)\b/i,
	/\bme (envie|envia|mande|manda|passe|passa|forne[cç]a|informe|diga)\b/i,
	/\bse (voc[eê]|vc|tu) (me )?(enviar|mandar|passar|fornecer|informar|der)\b/i,
	/\bsend me\b/i,
	/\bassim que (voc[eê]|vc|eu receber|receber|tiver)\b/i,
	/\bn[aã]o (consigo|tenho como|d[aá] para) .{0,60}\bsem (o|a|os|as|um|uma)\b/i,
];

const lastLine = (text: string): string =>
	text
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.pop() ?? "";

/**
 * A resposta do membro devolve o problema em vez de entregar? `null` = entregou (ou há conteúdo útil).
 * Heurística conservadora: resposta longa/estruturada nunca conta como "sem entrega".
 */
export function detectUndelivered(text: string | null | undefined): UndeliveredReason | null {
	const body = (text ?? "").trim();
	if (body.length < SHORTEST_DELIVERY) return "empty";
	const lines = body.split("\n").filter((line) => line.trim()).length;
	if (body.length >= SUBSTANTIAL_CHARS || lines >= SUBSTANTIAL_LINES) return null;
	if (WAITING.some((pattern) => pattern.test(body))) return "waiting";
	if (/\?["')\]*_\s]*$/.test(lastLine(body))) return "asks_input";
	return null;
}

/** Código gravado em `GroupReply.error` quando a resposta terminou mas não entregou. */
export const UNDELIVERED_ERROR_PREFIX = "undelivered:";
export const undeliveredError = (reason: UndeliveredReason | "pending_approval"): string => `${UNDELIVERED_ERROR_PREFIX}${reason}`;

const REASON_TEXT: Record<string, string> = {
	empty: "replied with nothing useful",
	waiting: "replied that it is waiting for something instead of delivering",
	asks_input: "replied with a question instead of delivering",
	pending_approval: "its approval request was not answered in time",
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
