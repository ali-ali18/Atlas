import { isValidTimeZone } from "@workspace/shared";

/**
 * Data e hora de agora para o modelo principal (camada volátil, depois do histórico).
 * Sem ela o modelo não resolve "mês anterior", "até agora" nem "esta semana"
 * e consulta o período errado nas tools de dados.
 */
export const DEFAULT_NOTE_TIMEZONE = "America/Sao_Paulo";

/** Fuso inválido ou ausente cai no padrão: a nota nunca quebra o run por causa de um valor ruim da conta. */
export function todayNote(now: Date, requestedTimeZone?: string | null): string {
	const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : DEFAULT_NOTE_TIMEZONE;
	const parts = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone, ...options }).format(now);
	const [day, month, year] = parts({ day: "2-digit", month: "2-digit", year: "numeric" }).split("/");
	const time = parts({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	return `Now is ${year}-${month}-${day} ${time} (${parts({ weekday: "long" })}), timezone ${timeZone}. Resolve relative dates and times (hoje, ontem, mês anterior, até agora, esta semana, daqui a N minutos) against it.`;
}
