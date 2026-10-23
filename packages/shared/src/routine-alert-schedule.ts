/**
 * Quando um alerta confere: horários inteligentes em vez de um intervalo curto fixo. Funções puras, sem
 * relógio nem I/O (o worker aplica o resultado).
 *
 * - Intervalo mínimo: conferir de 30 em 30 minutos gasta o modelo à toa, então o agente escolhe horários
 *   (cron em dias úteis) ou um intervalo de pelo menos 2 h, salvo pedido explícito do usuário.
 * - Backoff: depois de N conferências tranquilas e iguais, o intervalo dobra (até 1 vez por dia); volta ao
 *   original quando a condição muda de lado, o valor muda ou o alerta dispara.
 * - Frase em pt-BR simples: "em dias úteis às 10h, 14h e 17h".
 */
import type { AlertDecision, AlertVerdict, RoutineAlert } from "./routine-alert.js";

export const ALERT_MIN_INTERVAL_MINUTES = 120;
export const ALERT_MAX_INTERVAL_MINUTES = 1440;
/** Conferências tranquilas e iguais, seguidas, antes de espaçar. */
export const ALERT_BACKOFF_AFTER = 3;

/** Erro (texto para o modelo) quando o intervalo de um alerta é curto demais e o usuário não pediu isso. */
export function validateAlertInterval(everyMinutes: number, explicitlyFrequent: boolean): string | null {
	if (explicitlyFrequent || everyMinutes >= ALERT_MIN_INTERVAL_MINUTES) return null;
	return `alert checks cost a model run each: an interval under ${ALERT_MIN_INTERVAL_MINUTES} minutes is only allowed when the user explicitly asked for that frequency (then pass alert.frequent=true). Otherwise use trigger_type cron with a few check times in business hours (e.g. "0 10,14,17 * * 1-5"), or every_minutes >= ${ALERT_MIN_INTERVAL_MINUTES}.`;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function expandField(field: string, min: number, max: number): number[] | null {
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!match) return null;
		const step = match[4] ? Number(match[4]) : 1;
		if (step < 1) return null;
		const from = match[1] ? min : Number(match[2]);
		const to = match[1] ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
		if (from < min || to > max || from > to) return null;
		for (let value = from; value <= to; value += step) out.add(value);
	}
	return [...out].sort((a, b) => a - b);
}

function clock(hour: number, minute: number): string {
	return minute === 0 ? `${hour}h` : `${hour}h${String(minute).padStart(2, "0")}`;
}

function joinList(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

/** "em dias úteis às 10h, 14h e 17h" / "todo dia às 17h"; null quando o cron não é desse formato (o chamador usa outra frase). */
export function describeAlertCron(cron: string | null | undefined): string | null {
	const fields = (cron ?? "").trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const [minuteField, hourField, dom, month, dow] = fields as [string, string, string, string, string];
	if (dom !== "*" || month !== "*" || !/^\d{1,2}$/.test(minuteField)) return null;
	const minute = Number(minuteField);
	const hours = expandField(hourField, 0, 23);
	if (minute > 59 || !hours || hours.length === 0) return null;
	let days: string;
	if (dow === "*") days = "todo dia";
	else {
		const list = expandField(dow.replace(/7/g, "0"), 0, 6);
		if (!list || list.length === 0) return null;
		const key = list.join(",");
		if (key === "1,2,3,4,5") days = "em dias úteis";
		else if (key === "0,6") days = "nos fins de semana";
		else days = `toda ${joinList(list.map((day) => WEEKDAYS[day]!))}`;
	}
	const step = hours.length > 4 ? hours[1]! - hours[0]! : 0;
	if (step > 0 && hours.every((hour, index) => index === 0 || hour - hours[index - 1]! === step)) {
		return `${days}, a cada ${step} h, das ${clock(hours[0]!, minute)} às ${clock(hours.at(-1)!, minute)}`;
	}
	return `${days} às ${joinList(hours.map((hour) => clock(hour, minute)))}`;
}

export type AlertBackoffPlan = {
	everyMinutes: number;
	/** Campos de estado do alerta (mescle em `RoutineAlert`): quietStreak 0 e sem backoff = limpos. */
	quietStreak: number;
	backoff: { base: number; to: number } | null;
};

const sameText = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Depois de cada verificação de um alerta por intervalo: espaça quando está tudo igual e tranquilo, volta
 * ao intervalo original quando algo muda. `everyMinutes` é o intervalo atual da rotina; se ele não for o
 * que o backoff gravou, o usuário/agente mexeu nele e o atual vira o novo original.
 */
export function planAlertBackoff(input: {
	everyMinutes: number;
	alert: Pick<RoutineAlert, "quietStreak" | "backoff" | "lastSummary">;
	decision: Pick<AlertDecision, "transition">;
	verdict: AlertVerdict | null;
}): AlertBackoffPlan {
	const { everyMinutes, alert, decision } = input;
	const base = alert.backoff && alert.backoff.to === everyMinutes ? alert.backoff.base : everyMinutes;
	const keep = (streak: number): AlertBackoffPlan => ({ everyMinutes, quietStreak: streak, backoff: alert.backoff && alert.backoff.to === everyMinutes ? alert.backoff : null });
	if (decision.transition === "inconclusive") return keep(alert.quietStreak ?? 0);
	if (decision.transition !== "quiet") return { everyMinutes: base, quietStreak: 0, backoff: null };
	// Tranquilo: só conta como "igual" se o resumo (com o valor) não mudou desde a conferência anterior.
	const streak = sameText(alert.lastSummary, input.verdict?.summary) ? (alert.quietStreak ?? 0) + 1 : 1;
	if (streak < ALERT_BACKOFF_AFTER) return keep(streak);
	const widened = Math.min(everyMinutes * 2, ALERT_MAX_INTERVAL_MINUTES);
	if (widened <= everyMinutes) return keep(0);
	return { everyMinutes: widened, quietStreak: 0, backoff: { base, to: widened } };
}
