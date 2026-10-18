/** Rotina de disparo único ("lembra só desta vez"), sem repetição (ver `schedule-cron.ts` para cron). */

const DEFAULT_ONCE_TIMEZONE = "America/Sao_Paulo";
/** Folga contra latência/clock-skew entre o pedido e a validação. */
const PAST_GRACE_MS = 60_000;
/** Teto de quão longe no futuro um lembrete pode ser marcado. */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** Até quanto tempo atrasada uma rotina `once` ainda roda "agora" no reconcile; passou disso, é perdida. */
const MISSED_GRACE_MS = 60 * 60 * 1000;

export type OnceTriggerJson = {
	kind: "once";
	/** Sempre ISO 8601 em UTC (com "Z"). */
	runAt: string;
};

export function isOnceTrigger(value: unknown): value is OnceTriggerJson {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.kind === "once" &&
		typeof row.runAt === "string" &&
		!Number.isNaN(Date.parse(row.runAt))
	);
}

function formatPartsMap(date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
	const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
	const map: Record<string, string> = {};
	for (const part of parts) {
		if (part.type !== "literal") map[part.type] = part.value;
	}
	return map;
}

/** Offset (ms) do fuso `timeZone` no instante `date` (positivo = a leste de UTC). */
export function tzOffsetMs(date: Date, timeZone: string): number {
	const map = formatPartsMap(date, {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const asUtc = Date.UTC(
		Number(map.year),
		Number(map.month) - 1,
		Number(map.day),
		Number(map.hour) === 24 ? 0 : Number(map.hour),
		Number(map.minute),
		Number(map.second),
	);
	return asUtc - date.getTime();
}

/** Converte um horário "de parede" (sem fuso) no fuso `timeZone` pro instante UTC correspondente. */
export function zonedWallTimeToUtc(
	parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
	timeZone: string,
): Date {
	const naiveUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	// Uma correção já cobre os fusos relevantes aqui (sem saltos de DST > 1h);
	// America/Sao_Paulo não observa horário de verão desde 2019 (offset fixo -03:00).
	const offset = tzOffsetMs(new Date(naiveUtc), timeZone);
	return new Date(naiveUtc - offset);
}

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export type ParseOnceRunAtOk = { ok: true; runAtIso: string };
export type ParseOnceRunAtError = { ok: false; error: string };
export type ParseOnceRunAtResult = ParseOnceRunAtOk | ParseOnceRunAtError;

/**
 * Valida e normaliza `run_at` de `propose_routine` (trigger_type=once).
 * Aceita ISO 8601 com offset explícito (usa como está) OU "de parede" sem
 * fuso — nesse caso interpreta no fuso informado (padrão
 * America/Sao_Paulo). Exige futuro (folga de 1 min pra latência) e no
 * máximo 1 ano à frente. Mensagens de erro em PT-BR (viram `tool_result`
 * acionável pro agente).
 */
export function parseOnceRunAt(
	input: { runAt: unknown; timezone?: string },
	now: Date = new Date(),
): ParseOnceRunAtResult {
	const raw = typeof input.runAt === "string" ? input.runAt.trim() : "";
	if (!raw) {
		return {
			ok: false,
			error: "run_at vazio: informe data e hora (ISO 8601, ex.: 2026-10-03T10:00)",
		};
	}
	const timezone = input.timezone?.trim() || DEFAULT_ONCE_TIMEZONE;
	let parsed: Date;
	if (OFFSET_SUFFIX.test(raw)) {
		const ms = Date.parse(raw);
		if (Number.isNaN(ms)) {
			return { ok: false, error: `run_at inválido: "${raw}" não é uma data ISO 8601 válida` };
		}
		parsed = new Date(ms);
	} else {
		const match = raw.match(NAIVE_DATETIME);
		if (!match) {
			return {
				ok: false,
				error: `run_at inválido: "${raw}" — use ISO 8601 (ex.: 2026-10-03T10:00, opcionalmente com fuso)`,
			};
		}
		try {
			parsed = zonedWallTimeToUtc(
				{
					year: Number(match[1]),
					month: Number(match[2]),
					day: Number(match[3]),
					hour: Number(match[4]),
					minute: Number(match[5]),
					second: match[6] ? Number(match[6]) : 0,
				},
				timezone,
			);
		} catch {
			return { ok: false, error: `run_at inválido: fuso "${timezone}" não reconhecido` };
		}
	}
	if (Number.isNaN(parsed.getTime())) {
		return { ok: false, error: `run_at inválido: "${raw}"` };
	}
	if (parsed.getTime() < now.getTime() - PAST_GRACE_MS) {
		return { ok: false, error: "run_at precisa ser no futuro (a data/hora informada já passou)" };
	}
	if (parsed.getTime() > now.getTime() + MAX_AHEAD_MS) {
		return { ok: false, error: "run_at não pode passar de 1 ano à frente" };
	}
	return { ok: true, runAtIso: parsed.toISOString() };
}

/** "Uma vez · 03/10 às 10:00" (data dd/MM, hora HH:mm, no fuso informado). */
export function formatOnceSummary(
	runAtIso: string,
	timeZone: string = DEFAULT_ONCE_TIMEZONE,
): string {
	const date = new Date(runAtIso);
	if (Number.isNaN(date.getTime())) return "Uma vez · —";
	const map = formatPartsMap(date, {
		timeZone,
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return `Uma vez · ${map.day}/${map.month} às ${map.hour}:${map.minute}`;
}

export type PlanOnceRoutineResult =
	| { action: "schedule"; delayMs: number }
	| { action: "run-now" }
	| { action: "missed" };

/**
 * Decide o que fazer com uma rotina `once` a partir do horário salvo (usada
 * na criação/edição e no reconcile de boot do worker): ainda no futuro →
 * agenda com o delay certo; já passou mas ≤1h → roda agora (latência de
 * boot/redis); passou de 1h → perdida (worker apaga a rotina e avisa na
 * conversa).
 */
export function planOnceRoutine(runAtIso: string, now: Date = new Date()): PlanOnceRoutineResult {
	const runAt = Date.parse(runAtIso);
	if (Number.isNaN(runAt)) return { action: "missed" };
	const delayMs = runAt - now.getTime();
	if (delayMs > 0) return { action: "schedule", delayMs };
	if (delayMs >= -MISSED_GRACE_MS) return { action: "run-now" };
	return { action: "missed" };
}

/** Tipos de gatilho que se auto-apagam depois de UMA execução (hoje só `once`). */
export function shouldAutoDeleteAfterRun(triggerType: string): boolean {
	return triggerType === "once";
}
