/**
 * Horário do pregão da B3 (puro, com `now` injetado) para os alertas de cotação: o servidor só confere a cotação
 * durante o pregão e uma vez depois do fechamento; fora disso (noite, fim de semana, feriado) não gasta chamada
 * da cota do provedor.
 *
 * Fontes (conferir a cada ano; a B3 pode alterar com aviso prévio):
 * - Horários: comunicados da B3 sobre o fim do horário de verão dos EUA. A partir de 03/11/2026 (primeiro dia útil
 *   depois do fim do horário de verão americano, 01/11) o pregão regular de ações vai das 10h às 17h55, com leilão
 *   de fechamento até as 18h e SEM after-market de ações (exceto dias de vencimento de opções). No horário de verão
 *   dos EUA (março a novembro) o regular é 10h–16h55, leilão até as 17h e after-market 17h30–18h.
 * - Feriados 2026: Ofício Circular 054/2025-VNC da B3 (calendário de feriados em 2026) e errata 041/2026-VNC. Não há
 *   pregão em 24/12 e 31/12; o feriado municipal de SP (09/07) não fecha a B3.
 *
 * O Brasil não tem horário de verão desde 2019: usa UTC-3 fixo.
 */

const BRT_OFFSET_MS = 3 * 3_600_000;

/** Dias sem pregão em 2026 (YYYY-MM-DD, calendário de Brasília), além dos fins de semana. */
export const B3_HOLIDAYS_2026: readonly string[] = [
	"2026-01-01", // Confraternização Universal
	"2026-02-16", // Carnaval
	"2026-02-17", // Carnaval
	"2026-04-03", // Sexta-feira Santa
	"2026-04-21", // Tiradentes
	"2026-05-01", // Dia do Trabalho
	"2026-06-04", // Corpus Christi
	"2026-09-07", // Independência
	"2026-10-12", // Nossa Senhora Aparecida
	"2026-11-02", // Finados
	"2026-11-20", // Consciência Negra
	"2026-12-24", // véspera de Natal (sem sessão)
	"2026-12-25", // Natal
	"2026-12-31", // véspera de Ano Novo (sem sessão)
];

/** Grade de horários em minutos desde 00:00 de Brasília. */
export type B3Schedule = {
	preOpen: number;
	open: number;
	/** Fim do pregão regular. */
	regularEnd: number;
	/** Fim do leilão de fechamento (último instante com preço de fechamento saindo). */
	closeCallEnd: number;
	/** After-market de ações (null = não há). */
	afterMarket: { from: number; to: number } | null;
};

const at = (hour: number, minute = 0) => hour * 60 + minute;

/** Horário de verão dos EUA: 10h–16h55, leilão até 17h, after-market 17h30–18h. */
export const B3_SCHEDULE_US_DST: B3Schedule = { preOpen: at(9, 45), open: at(10), regularEnd: at(16, 55), closeCallEnd: at(17), afterMarket: { from: at(17, 30), to: at(18) } };
/** Fora do horário de verão dos EUA: 10h–17h55, leilão até 18h, sem after-market. */
export const B3_SCHEDULE_STANDARD: B3Schedule = { preOpen: at(9, 45), open: at(10), regularEnd: at(17, 55), closeCallEnd: at(18), afterMarket: null };

type Brt = { year: number; month: number; day: number; weekday: number; minutes: number; key: string };

/** Data e hora de Brasília a partir de um instante. */
function toBrasilia(now: Date): Brt {
	const shifted = new Date(now.getTime() - BRT_OFFSET_MS);
	const year = shifted.getUTCFullYear();
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return { year, month, day, weekday: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), key };
}

function nthSunday(year: number, monthIndex: number, nth: number): number {
	const first = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
	return 1 + ((7 - first) % 7) + (nth - 1) * 7;
}

/**
 * A B3 está na grade de verão dos EUA nesta data? Da segunda-feira depois do 2º domingo de março até o 1º domingo
 * de novembro (a grade nova vale a partir do primeiro dia útil seguinte).
 */
export function isB3UsDstSchedule(dateKey: string): boolean {
	const year = Number(dateKey.slice(0, 4));
	const start = `${year}-03-${String(nthSunday(year, 2, 2) + 1).padStart(2, "0")}`;
	const end = `${year}-11-${String(nthSunday(year, 10, 1)).padStart(2, "0")}`;
	return dateKey >= start && dateKey <= end;
}

export function b3ScheduleFor(dateKey: string): B3Schedule {
	return isB3UsDstSchedule(dateKey) ? B3_SCHEDULE_US_DST : B3_SCHEDULE_STANDARD;
}

/** Dia de pregão: dia útil que não está na lista de feriados. Anos sem lista só excluem fim de semana. */
export function isB3TradingDay(dateKey: string, weekday: number): boolean {
	if (weekday === 0 || weekday === 6) return false;
	return !B3_HOLIDAYS_2026.includes(dateKey);
}

export type B3Phase = "closed" | "pre_open" | "open" | "after_close";

export type B3Session = {
	tradingDay: boolean;
	phase: B3Phase;
	schedule: B3Schedule;
	/** Dia (YYYY-MM-DD, Brasília) avaliado. */
	dateKey: string;
};

/** Estado do pregão num instante: `open` vale do começo do regular até o fim do leilão de fechamento. */
export function b3Session(now: Date): B3Session {
	const brt = toBrasilia(now);
	const schedule = b3ScheduleFor(brt.key);
	const tradingDay = isB3TradingDay(brt.key, brt.weekday);
	let phase: B3Phase = "closed";
	if (tradingDay) {
		if (brt.minutes >= schedule.open && brt.minutes < schedule.closeCallEnd) phase = "open";
		else if (brt.minutes >= schedule.preOpen && brt.minutes < schedule.open) phase = "pre_open";
		else if (brt.minutes >= schedule.closeCallEnd) phase = "after_close";
	}
	return { tradingDay, phase, schedule, dateKey: brt.key };
}

export function isB3Open(now: Date): boolean {
	return b3Session(now).phase === "open";
}

/** Instante (UTC) do fim do leilão de fechamento do dia de Brasília dado. */
function closeInstant(dateKey: string, schedule: B3Schedule): number {
	const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
	return Date.UTC(y, m - 1, d, 0, 0, 0) + BRT_OFFSET_MS + schedule.closeCallEnd * 60_000;
}

/** Depois do fechamento, até quando a conferência "de fechamento" ainda vale (mesmo dia útil). */
const AFTER_CLOSE_WINDOW_MS = 3 * 3_600_000;

export type QuoteCheckDecision = { check: true; phase: B3Phase } | { check: false; reason: string };

/**
 * Deve conferir a cotação agora? Durante o pregão, sempre; depois do fechamento, uma vez (a que pega o preço de
 * fechamento: só se a última conferência foi antes do fechamento); fora disso, não (noite, fim de semana, feriado).
 */
export function quoteCheckDecision(now: Date, lastCheckedAt?: string | null): QuoteCheckDecision {
	const session = b3Session(now);
	if (session.phase === "open") return { check: true, phase: "open" };
	if (session.phase === "after_close") {
		const close = closeInstant(session.dateKey, session.schedule);
		const last = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
		const alreadyClosed = Number.isFinite(last) && last >= close;
		if (!alreadyClosed && now.getTime() - close <= AFTER_CLOSE_WINDOW_MS) return { check: true, phase: "after_close" };
	}
	return { check: false, reason: "Mercado fechado: a cotação volta a ser conferida no próximo pregão" };
}
