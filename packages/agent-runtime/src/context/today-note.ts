import { EPHEMERAL_CONTEXT_MARK } from "@workspace/llm";
import { isValidTimeZone } from "@workspace/shared";

/**
 * Data e hora de agora para o modelo principal (camada volátil, depois do histórico).
 * Sem ela o modelo não resolve "mês anterior", "até agora" nem "esta semana"
 * e consulta o período errado nas tools de dados.
 */
export const DEFAULT_NOTE_TIMEZONE = "America/Sao_Paulo";

/** Fuso inválido ou ausente cai no padrão: a nota nunca quebra o run por causa de um valor ruim da conta. */
export function resolveNoteTimeZone(requested?: string | null): string {
	return isValidTimeZone(requested) ? requested : DEFAULT_NOTE_TIMEZONE;
}

/** Relógio de parede no fuso (fonte única da nota de hora e da tool `current_time`). */
export function localClock(now: Date, timeZone: string) {
	const parts = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone, ...options }).format(now);
	const [day, month, year] = parts({ day: "2-digit", month: "2-digit", year: "numeric" }).split("/");
	const time = parts({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	return { date: `${year}-${month}-${day}`, time, weekday: parts({ weekday: "long" }), timeZone };
}

export function todayNote(now: Date, requestedTimeZone?: string | null): string {
	const clock = localClock(now, resolveNoteTimeZone(requestedTimeZone));
	return `${EPHEMERAL_CONTEXT_MARK} do not reply to it, thank for it or mention it unless it matters to the request (dates, scheduling, reminders). Now is ${clock.date} ${clock.time} (${clock.weekday}), timezone ${clock.timeZone}. Resolve relative dates and times (hoje, ontem, mês anterior, até agora, esta semana, daqui a N minutos) against it.`;
}
