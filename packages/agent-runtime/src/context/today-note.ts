/**
 * Data de hoje para o modelo principal (camada volátil, depois do histórico).
 * Sem ela o modelo não resolve "mês anterior", "até agora" nem "esta semana"
 * e consulta o período errado nas tools de dados.
 */
export const DEFAULT_NOTE_TIMEZONE = "America/Sao_Paulo";

export function todayNote(now: Date, timeZone: string = DEFAULT_NOTE_TIMEZONE): string {
	const parts = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone, ...options }).format(now);
	const [day, month, year] = parts({ day: "2-digit", month: "2-digit", year: "numeric" }).split("/");
	return `Today is ${year}-${month}-${day} (${parts({ weekday: "long" })}), timezone ${timeZone}. Resolve relative dates (hoje, ontem, mês anterior, até agora, esta semana) against it.`;
}
