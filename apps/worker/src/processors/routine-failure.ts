import type { ExecuteRoutineJobPayload, RoutineTriggeredBy } from "@workspace/shared";

/** Aviso curto ao usuário quando uma rotina não rodou. Sem a palavra do produto na UI. */
export function formatRoutineFailureNotice(input: {
	name: string;
	at: Date;
	timezone?: string | null;
	reason: string;
}): string {
	let hhmm: string;
	try {
		hhmm = new Intl.DateTimeFormat("pt-BR", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			timeZone: input.timezone || "America/Sao_Paulo",
		}).format(input.at);
	} catch {
		hhmm = input.at.toISOString().slice(11, 16);
	}
	const reason = shortReason(input.reason);
	return `A rotina “${input.name}” não rodou às ${hhmm}: ${reason}. Abra a rotina para tentar de novo.`;
}

/** Primeira linha, sem ponto final repetido, no máximo ~120 caracteres. */
export function shortReason(reason: string): string {
	const line = (reason.split("\n")[0] ?? "").trim().replace(/[.\s]+$/, "");
	if (!line) return "erro inesperado";
	return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

export type RoutineFailureDeps = {
	loadRoutine: (
		routineId: string,
	) => Promise<{ id: string; name: string; timezone: string | null; userId: string | null; conversationId: string | null } | null>;
	/** Transição atômica queued/running -> failed; false se já estava terminal (aviso já dado). */
	markRunFailed: (routineRunId: string, reason: string) => Promise<boolean>;
	/** Último disparo ainda em aberto da rotina (para falha antes de existir routineRunId no payload). */
	findOpenRun: (routineId: string, triggeredBy: RoutineTriggeredBy, since: Date) => Promise<string | null>;
	createFailedRun: (routineId: string, triggeredBy: RoutineTriggeredBy, reason: string) => Promise<string>;
	appendMessage: (conversationId: string, text: string) => Promise<void>;
	/** Push (respeita o switch de notificação do bot; ausente = sem chaves VAPID). */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
};

/**
 * Falha final (ou pulo por esgotar a espera) de um disparo de rotina: marca a RoutineRun
 * como falha e avisa UMA vez — mensagem na conversa do bot + push. Idempotente: se a
 * execução já estava finalizada, não avisa de novo.
 */
export async function reportRoutineFailure(
	input: {
		payload: ExecuteRoutineJobPayload;
		reason: string;
		at: Date;
		openedAfter: Date;
		/** `skipped` quando a RoutineRun já foi fechada como pulada pelo processor (só avisar). */
		alreadyClosedRunId?: string;
	},
	deps: RoutineFailureDeps,
): Promise<{ notified: boolean }> {
	const routine = await deps.loadRoutine(input.payload.routineId);
	if (!routine) return { notified: false };
	let fresh: boolean;
	if (input.alreadyClosedRunId) {
		fresh = true;
	} else {
		const openId =
			input.payload.routineRunId ??
			(await deps.findOpenRun(routine.id, input.payload.triggeredBy, input.openedAfter));
		fresh = openId
			? await deps.markRunFailed(openId, input.reason)
			: Boolean(await deps.createFailedRun(routine.id, input.payload.triggeredBy, input.reason));
	}
	if (!fresh) return { notified: false };
	if (!routine.conversationId) return { notified: false };
	const text = formatRoutineFailureNotice({ name: routine.name, at: input.at, timezone: routine.timezone, reason: input.reason });
	await deps.appendMessage(routine.conversationId, text).catch((error) => {
		console.error(`[routine] aviso na conversa falhou routine=${routine.id}`, error);
	});
	if (deps.push && routine.userId) {
		await deps.push(routine.userId, routine.conversationId, text).catch(() => undefined);
	}
	return { notified: true };
}
