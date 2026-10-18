/** Gatilho de intervalo ("a cada N minutos") — repetição por tempo decorrido, sem cron (ver `schedule-cron.ts`). */

export const INTERVAL_EVERY_MINUTES_MIN = 5;
export const INTERVAL_EVERY_MINUTES_MAX = 1440;

export type IntervalTriggerJson = {
	kind: "interval";
	/** A cada quantos minutos (inteiro de 5 a 1440). */
	everyMinutes: number;
};

export function isIntervalTrigger(value: unknown): value is IntervalTriggerJson {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.kind === "interval" &&
		typeof row.everyMinutes === "number" &&
		Number.isInteger(row.everyMinutes) &&
		row.everyMinutes >= INTERVAL_EVERY_MINUTES_MIN &&
		row.everyMinutes <= INTERVAL_EVERY_MINUTES_MAX
	);
}

export type ParseIntervalEveryMinutesOk = { ok: true; everyMinutes: number };
export type ParseIntervalEveryMinutesError = { ok: false; error: string };
export type ParseIntervalEveryMinutesResult =
	| ParseIntervalEveryMinutesOk
	| ParseIntervalEveryMinutesError;

/**
 * Valida e normaliza `every_minutes` de `propose_routine` (trigger_type=interval)
 * ou do parse da API. Aceita número ou string numérica; exige inteiro de 5 a
 * 1440. Mensagens de erro em PT-BR (viram `tool_result` acionável pro agente).
 */
export function parseIntervalEveryMinutes(input: {
	everyMinutes: unknown;
}): ParseIntervalEveryMinutesResult {
	const raw = input.everyMinutes;
	const num =
		typeof raw === "number"
			? raw
			: typeof raw === "string" && raw.trim().length > 0
				? Number(raw.trim())
				: Number.NaN;
	if (!Number.isFinite(num)) {
		return {
			ok: false,
			error: "every_minutes inválido: informe a cada quantos minutos (número de 5 a 1440)",
		};
	}
	if (!Number.isInteger(num)) {
		return {
			ok: false,
			error: "every_minutes deve ser um número inteiro de minutos (5 a 1440)",
		};
	}
	if (num < INTERVAL_EVERY_MINUTES_MIN) {
		return {
			ok: false,
			error: "intervalo mínimo é a cada 5 minutos",
		};
	}
	if (num > INTERVAL_EVERY_MINUTES_MAX) {
		return {
			ok: false,
			error: "intervalo máximo é a cada 24 horas (1440 minutos)",
		};
	}
	return { ok: true, everyMinutes: num };
}

/**
 * "A cada 50 min" / "A cada 2 h" (múltiplos exatos de 60 viram horas).
 * Nunca lança; valor inválido vira "A cada —".
 */
export function formatIntervalSummary(everyMinutes: number): string {
	if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return "A cada —";
	const whole = Math.trunc(everyMinutes);
	if (whole % 60 === 0) {
		const hours = whole / 60;
		return `A cada ${hours} h`;
	}
	return `A cada ${whole} min`;
}
