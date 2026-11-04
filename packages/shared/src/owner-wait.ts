/**
 * "Esperar o dono" do motor v3 (PR8a, pedidos do dono de 03/11). Funções puras: o que o MODELO recebe como resultado
 * da tool que estacionou (aprovação, login/VM, pergunta), o rótulo que o cartão mostra, o prazo opcional `waitMinutes`
 * e o planejamento do `schedule_return` ("Volto depois"). Nada aqui lê texto do usuário para decidir: a saída vem do
 * botão (protocolo), do prazo vencido ou do fato de o dono ter mandado outra mensagem.
 */

/** Saídas de uma espera pelo dono. `approved` só vem do botão "Permitir"; prazo vencido nunca aprova. */
export const OWNER_WAIT_OUTCOMES = ["done", "takeover", "skipped", "skipped_timeout", "ignored", "declined", "approved"] as const;
export type OwnerWaitOutcome = (typeof OWNER_WAIT_OUTCOMES)[number];

/** Saídas do cartão de login/VM (aprovar e recusar são do cartão de aprovação). */
export type LoginWaitOutcome = Exclude<OwnerWaitOutcome, "approved" | "declined">;

export function isOwnerWaitOutcome(value: unknown): value is OwnerWaitOutcome {
	return typeof value === "string" && (OWNER_WAIT_OUTCOMES as readonly string[]).includes(value);
}

/** Saídas que deixam o passo de fora: a tarefa segue sem ele e o mesmo pedido não volta neste trabalho. */
export function isRefusedOutcome(outcome: OwnerWaitOutcome): boolean {
	return outcome === "skipped" || outcome === "skipped_timeout" || outcome === "declined" || outcome === "ignored";
}

export const WAIT_MINUTES_MIN = 1;
export const WAIT_MINUTES_MAX = 1440;

/** Descrição (para o modelo) do campo opcional `waitMinutes` das tools que estacionam. */
export const WAIT_MINUTES_DESCRIPTION =
	"Optional deadline in minutes (1-1440) for the owner's answer. Set it when the step has an alternative and blocking would delay the task; when it passes, you get 'skipped' and continue without it (never approved). Omit when only the owner can decide: then you wait as long as needed.";

/** `waitMinutes` do modelo: ausente = espera sem prazo; fora de 1–1440 ou não inteiro = erro honesto com o aceito. */
export function parseWaitMinutes(value: unknown): { ok: true; minutes?: number } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true };
	const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < WAIT_MINUTES_MIN || minutes > WAIT_MINUTES_MAX) {
		return { ok: false, error: `waitMinutes must be a whole number of minutes from ${WAIT_MINUTES_MIN} to ${WAIT_MINUTES_MAX}, or omitted to wait without a deadline.` };
	}
	return { ok: true, minutes };
}

const quote = (text: string, max = 300) => {
	const clean = text.replace(/\s+/g, " ").trim();
	return `"${clean.length > max ? `${clean.slice(0, max)}…` : clean}"`;
};

const SKIP_TAIL =
	"Continue the rest of the task without it: do what does not depend on it, try another route if there is one, and at the end say in one line what was left out and why. Do not ask for this again in this task.";

/**
 * Resultado da tool que esperou o dono (texto para o modelo, em inglês). `what` é o pedido em palavras simples;
 * `message` é a fala nova do dono (só em `ignored`, como dado); `minutes` é o prazo que venceu.
 */
export function ownerWaitResultText(outcome: OwnerWaitOutcome, input: { what: string; message?: string; minutes?: number }): string {
	const what = quote(input.what, 200);
	switch (outcome) {
		case "done":
			return `Owner did it: ${what}. Check the result first (for example re-read the page), then continue the task.`;
		case "takeover":
			return `Owner has control of the computer for ${what}. Do not use the computer (browser, screen or its shell) until they hand it back. Continue with what does not need it, or end your turn saying you are waiting for them.`;
		case "skipped":
			return `Owner skipped this step: ${what}. ${SKIP_TAIL}`;
		case "skipped_timeout":
			return `No answer from the owner${input.minutes ? ` within ${input.minutes} min` : ""} on ${what}: treat it as skipped. It was NOT done and NOT approved. ${SKIP_TAIL}`;
		case "ignored":
			return `Owner did not answer the previous request (${what}) and sent: ${quote(input.message ?? "", 2_000)}. Handle their new message first. The previous request was not done; do not repeat it in this task unless they ask.`;
		case "declined":
			return `Owner declined: ${what}. It was not done. ${SKIP_TAIL}`;
		case "approved":
			return `Owner approved: ${what}.`;
	}
}

export const LOGIN_WAIT_OUTCOMES = ["done", "takeover", "skipped", "skipped_timeout", "ignored"] as const satisfies readonly LoginWaitOutcome[];

export function parseLoginWaitOutcome(value: unknown): LoginWaitOutcome | undefined {
	return typeof value === "string" && (LOGIN_WAIT_OUTCOMES as readonly string[]).includes(value) ? (value as LoginWaitOutcome) : undefined;
}

/** Prazo de um cartão (ISO válido) lido do evento ou do cartão gravado; lixo = sem prazo. */
/** Data e hora ISO 8601 completas, com fuso (`Z` ou `±hh:mm`): "1", "Mar 5" ou só a data não são prazo. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseOwnerWaitDeadline(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 40 || !ISO_DATE_TIME.test(value)) return undefined;
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * Qual cartão de confirmação do "esperar o dono" é (motor v3): aprovação genérica de uma ação, rascunho que um run sem
 * pessoa deixou para o dono (`prepare_for_owner`) ou "Cheguei no limite. Continuo?". A UI escolhe o desenho por aqui.
 */
export const OWNER_CONFIRM_CARD_KINDS = ["approval", "draft", "step-limit"] as const;
export type OwnerConfirmCardKind = (typeof OWNER_CONFIRM_CARD_KINDS)[number];

export function parseOwnerConfirmCardKind(value: unknown): OwnerConfirmCardKind | undefined {
	return typeof value === "string" && (OWNER_CONFIRM_CARD_KINDS as readonly string[]).includes(value) ? (value as OwnerConfirmCardKind) : undefined;
}

/** Cartão do limite: o que o run já fez até parar (passos usados, gasto, tarefas concluídas). */
export type StepLimitProgress = { steps: number; costUsd?: number; tasksDone?: string[]; tasksTotal?: number };

export const STEP_LIMIT_PROGRESS_MAX_TASKS = 8;

export function parseStepLimitProgress(raw: unknown): StepLimitProgress | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.steps !== "number" || !Number.isInteger(record.steps) || record.steps < 0 || record.steps > 10_000) return undefined;
	const costUsd = typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd > 0 ? Math.round(record.costUsd * 100) / 100 : undefined;
	const tasksDone = Array.isArray(record.tasksDone)
		? record.tasksDone.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, STEP_LIMIT_PROGRESS_MAX_TASKS).map((item) => item.trim().slice(0, 160))
		: [];
	const tasksTotal = typeof record.tasksTotal === "number" && Number.isInteger(record.tasksTotal) && record.tasksTotal > 0 && record.tasksTotal <= 1_000 ? record.tasksTotal : undefined;
	return { steps: record.steps, ...(costUsd !== undefined ? { costUsd } : {}), ...(tasksDone.length > 0 ? { tasksDone } : {}), ...(tasksTotal !== undefined ? { tasksTotal } : {}) };
}

/**
 * Decisão do dono sobre um cartão (recusa, prazo, ignorado) gravada na conversa como registro para o modelo (pedido
 * do dono, 04/11: recusar é comunicação interna). Role próprio e oculto: fica fora da tela (web e app), da prévia da
 * barra lateral e da busca, e nunca vira `system` (que `trimHistory`/`planSummary` do v1/v2 sobem para o início como
 * regra). O texto é gravado SEM prefixo; quem monta o histórico do modelo usa `ownerDecisionHistoryMessage`.
 */
export const OWNER_DECISION_ROLE = "owner_decision";

/** Prefixo das notas do runtime no histórico (o mesmo `[runtime]` do motor v3). */
export const OWNER_DECISION_PREFIX = "[runtime]";

/** A nota no histórico do modelo, na posição em que ocorreu: fala `user` curta com o prefixo, uma vez só. */
export function ownerDecisionHistoryMessage(content: string): { role: "user"; content: string } {
	const text = content.trim();
	return { role: "user", content: text.startsWith(OWNER_DECISION_PREFIX) ? text : `${OWNER_DECISION_PREFIX} ${text}` };
}

/** Rótulo do cartão depois da decisão (pt-BR, para o dono). */
export const OWNER_WAIT_CARD_DETAIL: Readonly<Record<OwnerWaitOutcome, string>> = {
	done: "Feito",
	takeover: "Você assumiu",
	skipped: "Pulado · segui sem isso",
	skipped_timeout: "Tempo esgotado · segui sem isso",
	ignored: "Dispensado",
	declined: "Agora não",
	approved: "Permitido",
};

function hhmm(at: Date, timeZone?: string): string {
	try {
		return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(at);
	} catch {
		return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(at);
	}
}

/**
 * Nota para o run ATIVO quando o dono responde a um cartão que não é o que esse run espera (atrasado/substituído):
 * entra como steer no próximo limite e nunca cancela o run. O modelo só muda o plano se dependia daquilo.
 */
export function lateOwnerDecisionNote(input: { outcome: OwnerWaitOutcome; what: string; at: Date; timeZone?: string }): string {
	const verb =
		input.outcome === "approved" ? "approved" : input.outcome === "declined" ? "declined" : input.outcome === "done" ? "finished" : "skipped";
	return `[runtime] The owner ${verb} an earlier request at ${hhmm(input.at, input.timeZone)}: ${quote(input.what, 200)}. It is not what you are working on now; change your plan only if you depended on it. Do not ask for it again.`;
}

/** Selo do rascunho de `prepare_for_owner` que o dono descartou ("Agora não"): nada executa, nenhum run novo. */
export const DRAFT_DISMISSED_DETAIL = "Descartado";

/** Rascunho decidido sem aprovar: "Agora não" ou o dono mandou outra mensagem com ele pendente. */
export type DraftDecision = { title: string; decision: "dismissed" | "ignored" };

/**
 * Nota interna (nunca balão) para o próximo run da conversa: rascunhos que o dono descartou ou deixou sem resposta
 * desde então. Sem ela o modelo, que só viu "rascunho esperando aprovação", tomaria o pedido como pendente ou o
 * recriaria às cegas. Nenhum foi feito; nenhum volta salvo pedido do dono.
 */
export function draftDecisionsNote(decisions: readonly DraftDecision[]): string {
	const list = (kind: DraftDecision["decision"]) =>
		decisions.filter((item) => item.decision === kind).slice(0, 5).map((item) => quote(item.title.replace(/\?$/, ""), 120)).join("; ");
	const dismissed = list("dismissed");
	const ignored = list("ignored");
	const lines = [
		...(dismissed ? [`The owner dismissed draft(s) you left for approval: ${dismissed}.`] : []),
		...(ignored ? [`The owner did not answer the draft(s) you left for approval and sent another message instead: ${ignored}.`] : []),
	];
	if (lines.length === 0) return "";
	return `${lines.join(" ")} None of them was done. Do not prepare them again unless the owner asks.`;
}

// --- "Volto depois" (`schedule_return`) ---

export const SCHEDULE_RETURN_MIN_MS = 60_000;
export const SCHEDULE_RETURN_MAX_MS = 7 * 24 * 60 * 60_000;
export const SCHEDULE_RETURN_MAX_PENDING = 3;
export const SCHEDULE_RETURN_REASON_MAX_CHARS = 300;

export type ScheduleReturnPlan = { ok: true; dueAt: Date; delayMs: number; reason: string; visible: boolean } | { ok: false; error: string };

/**
 * Valida o pedido do modelo: `at` (ISO com fuso) OU `inMinutes`, motivo curto, 1 min–7 dias, no máximo 3 pendentes
 * na conversa. Erro = texto honesto com o que é aceito (nada é descartado em silêncio).
 */
export function planScheduleReturn(input: { at?: unknown; inMinutes?: unknown; reason?: unknown; visible?: unknown; now: Date; pending: number }): ScheduleReturnPlan {
	const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
	if (!reason) return { ok: false, error: "reason is required: one short sentence saying what you will check or do when you come back." };
	if (reason.length > SCHEDULE_RETURN_REASON_MAX_CHARS) return { ok: false, error: `reason is too long (max ${SCHEDULE_RETURN_REASON_MAX_CHARS} characters).` };
	if (input.visible !== undefined && typeof input.visible !== "boolean") return { ok: false, error: "visible must be true or false." };
	const hasAt = input.at !== undefined && input.at !== null && input.at !== "";
	const hasIn = input.inMinutes !== undefined && input.inMinutes !== null && input.inMinutes !== "";
	if (hasAt === hasIn) return { ok: false, error: "Give exactly one of at (ISO date-time with timezone offset) or inMinutes (number)." };
	let dueAt: Date;
	if (hasAt) {
		if (typeof input.at !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input.at.trim())) {
			return { ok: false, error: "at must be an ISO date-time with a timezone offset, e.g. 2026-11-04T15:30:00-03:00." };
		}
		dueAt = new Date(input.at.trim());
		if (Number.isNaN(dueAt.getTime())) return { ok: false, error: "at is not a valid date-time." };
	} else {
		const minutes = typeof input.inMinutes === "string" ? Number(input.inMinutes) : input.inMinutes;
		if (typeof minutes !== "number" || !Number.isFinite(minutes)) return { ok: false, error: "inMinutes must be a number of minutes." };
		dueAt = new Date(input.now.getTime() + Math.round(minutes * 60_000));
	}
	const delayMs = dueAt.getTime() - input.now.getTime();
	if (delayMs < SCHEDULE_RETURN_MIN_MS) return { ok: false, error: "The return must be at least 1 minute from now." };
	if (delayMs > SCHEDULE_RETURN_MAX_MS) return { ok: false, error: "The return must be at most 7 days from now. For something repeated or later, propose a routine." };
	if (input.pending >= SCHEDULE_RETURN_MAX_PENDING) {
		return { ok: false, error: `This conversation already has ${SCHEDULE_RETURN_MAX_PENDING} pending returns (the maximum). Use one of them, or cancel one first.` };
	}
	return { ok: true, dueAt, delayMs, reason, visible: input.visible === true };
}

/** Marcador do retorno visível (pt-BR): "Volto às 15:30" no mesmo dia; "Volto em 05/11 às 15:30" depois. */
export function formatReturnMarker(dueAt: Date, now: Date, timeZone?: string): string {
	const day = (at: Date) => {
		try {
			return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(at);
		} catch {
			return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(at);
		}
	};
	const time = hhmm(dueAt, timeZone);
	return day(dueAt) === day(now) ? `Volto às ${time}` : `Volto em ${day(dueAt)} às ${time}`;
}

/**
 * Fala do run que o retorno acorda (texto para o modelo). Visível: o dono espera a volta, então o bot sempre posta.
 * Invisível: só posta se houver novidade; sem novidade responde exatamente `[NO_UPDATE]` (nada é postado).
 */
export function scheduledReturnPrompt(input: { reason: string; visible: boolean; scheduledAt: Date; noUpdateToken: string }): string {
	const head = `[Scheduled return] You scheduled this return at ${input.scheduledAt.toISOString()} to: ${quote(input.reason, SCHEDULE_RETURN_REASON_MAX_CHARS)}. The conversation above is the context.`;
	return input.visible
		? `${head} You told the user you would come back: do it now and post the result (or what is still pending).`
		: `${head} Do it now. Post only if there is news worth telling the user; if nothing relevant changed, reply exactly ${input.noUpdateToken} and nothing else (nothing is posted).`;
}

/** Linha que o modelo vê no turno seguinte enquanto há retorno pendente (não agenda de novo o mesmo). */
export function pendingReturnsNote(returns: ReadonlyArray<{ dueAt: Date; reason: string }>): string {
	if (returns.length === 0) return "";
	const list = returns.map((item) => `${item.dueAt.toISOString()} (${quote(item.reason, 120)})`).join("; ");
	return `Pending scheduled returns in this conversation: ${list}. Do not schedule the same again; if the user's new message already covers one, just answer.`;
}

// --- jobs da fila `ownerWait` (BullMQ, atrasados) ---

/** O que estacionou: cartão genérico de aprovação, questionário ou login/VM (run pausado). */
export type OwnerWaitCardKind = "tool-call" | "questionnaire" | "login";

export type OwnerWaitTimeoutJobPayload = {
	kind: "card_timeout";
	userId: string;
	conversationId: string;
	/** Run que estacionou (o do cartão). */
	runId: string;
	card: OwnerWaitCardKind;
	/** `confirmId`, `questionnaireId` ou `loginId`. */
	cardId: string;
	/** Tool cuja chamada parou (o resultado da espera vira o resultado dela). */
	toolName?: string;
	what: string;
	minutes: number;
};

export type ScheduledReturnJobPayload = { kind: "scheduled_return"; userId: string; returnId: string };

export type OwnerWaitJobPayload = OwnerWaitTimeoutJobPayload | ScheduledReturnJobPayload;
export type OwnerWaitJobResult = { outcome: "resumed" | "noop"; runId?: string; detail?: string };

/** jobId determinístico (sem ':', reservado pelo BullMQ): responder antes remove este job. */
export function ownerWaitTimeoutJobId(cardId: string): string {
	return `owner-wait-${cardId}`;
}

export function scheduledReturnJobId(returnId: string): string {
	return `return-${returnId}`;
}
