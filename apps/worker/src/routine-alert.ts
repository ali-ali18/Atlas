import {
	buildAlertRunText,
	decideAlertNotification,
	firstLine,
	nextAlertState,
	planAlertBackoff,
	redactSecrets,
	type AlertDecision,
	type AlertVerdict,
	type RoutineAlert,
} from "@workspace/shared";

/**
 * Fim de uma execução de rotina de alerta: decide (com debounce) se o usuário é avisado e qual é o novo
 * estado da rotina. O modelo só entrega o veredito (`report_alert`); aqui está a regra de aviso.
 */
export type AlertRunPlan = {
	decision: AlertDecision;
	/** Estado a gravar na rotina. */
	next: RoutineAlert;
	/** Resultado da execução: histórico da rotina sempre; conversa só quando avisa. */
	text: string;
	/** Novo intervalo (backoff) a gravar junto do estado; ausente = não muda. Só rotina por intervalo. */
	everyMinutes?: number;
	/** Vai para a conversa e vira push. Falso = execução silenciosa (nada na conversa, sem push). */
	notify: boolean;
};

const REASON_MAX = 140;

/** Primeira linha do que o modelo escreveu ao não conseguir verificar (já no idioma do usuário), sem segredo. */
function failureReason(modelText: string | null | undefined): string | undefined {
	const line = firstLine(redactSecrets(modelText ?? ""), REASON_MAX).replace(/[.\s]+$/, "");
	return line || undefined;
}

export function planAlertRun(input: {
	alert: RoutineAlert;
	routineName: string;
	verdict: AlertVerdict | null;
	/** Texto final do modelo (só usado como motivo quando não houve veredito). */
	modelText?: string | null;
	/** Intervalo atual da rotina (só por intervalo): habilita o backoff; cron já tem horários escolhidos. */
	interval?: { everyMinutes: number } | null;
	now: Date;
}): AlertRunPlan {
	const decision = decideAlertNotification({ wasActive: input.alert.active, wasUnverified: input.alert.unverified === true, verdict: input.verdict });
	const base = nextAlertState(input.alert, decision, input.verdict, input.now);
	let next = base;
	let everyMinutes: number | undefined;
	if (input.interval) {
		const backoff = planAlertBackoff({ everyMinutes: input.interval.everyMinutes, alert: input.alert, decision, verdict: input.verdict });
		const { quietStreak: _q, backoff: _b, ...clean } = base;
		next = { ...clean, ...(backoff.quietStreak > 0 ? { quietStreak: backoff.quietStreak } : {}), ...(backoff.backoff ? { backoff: backoff.backoff } : {}) };
		if (backoff.everyMinutes !== input.interval.everyMinutes) everyMinutes = backoff.everyMinutes;
	}
	return {
		decision,
		next,
		...(everyMinutes !== undefined ? { everyMinutes } : {}),
		text: buildAlertRunText(decision, input.verdict, { name: input.routineName, reason: failureReason(input.modelText) }),
		notify: decision.notify,
	};
}

export type AlertSettleDeps = {
	/** Grava o estado só se a condição ainda é a avaliada (db escopado pelo dono). */
	record: (userId: string, routineId: string, next: RoutineAlert, everyMinutes?: number) => Promise<boolean>;
	/** Sincroniza o agendador depois de mudar o intervalo (backoff). Falha não derruba o alerta. */
	reschedule?: () => Promise<unknown>;
	/** Push (ausente = sem chaves VAPID). Respeita o switch do bot, quem está olhando e a coalescência. */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
	log?: (line: string) => void;
};

/**
 * Grava o estado e avisa. O push só sai para o dono do run e só se o estado foi gravado (condição editada
 * no meio da verificação descarta o resultado velho). Falha ao gravar não engole o alerta: avisa mesmo assim.
 */
export async function settleAlertRun(
	plan: AlertRunPlan,
	target: { userId: string; routineId: string; conversationId: string | null },
	deps: AlertSettleDeps,
): Promise<{ recorded: boolean; pushed: boolean }> {
	const log = deps.log ?? ((line: string) => console.log(line));
	let recorded = true;
	try {
		recorded = await deps.record(target.userId, target.routineId, plan.next, plan.everyMinutes);
	} catch (error) {
		console.error(`[alert] estado não gravado routine=${target.routineId}`, error);
	}
	if (!recorded) {
		log(`[alert] routine=${target.routineId} resultado descartado (condição mudou durante a verificação)`);
		return { recorded: false, pushed: false };
	}
	log(`[alert] routine=${target.routineId} transition=${plan.decision.transition} notify=${plan.notify}${plan.everyMinutes ? ` everyMinutes=${plan.everyMinutes}` : ""}`);
	if (plan.everyMinutes && deps.reschedule) {
		await deps.reschedule().catch((error) => console.error(`[alert] agendador não sincronizado routine=${target.routineId}`, error instanceof Error ? error.message : "erro"));
	}
	if (!plan.notify || !deps.push || !target.conversationId) return { recorded: true, pushed: false };
	await deps.push(target.userId, target.conversationId, plan.text).catch((error) => {
		console.error(`[alert] push falhou routine=${target.routineId}`, error instanceof Error ? error.message : "erro");
	});
	return { recorded: true, pushed: true };
}
