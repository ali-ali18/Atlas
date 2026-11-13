// Cron de 5 campos de VERDADE (C4 da auditoria F9): `isCronFive` só conta pedaços (`a b c d e` passava e a rotina nunca rodava).
// Aceita o subconjunto que o agendador (BullMQ/cron-parser) roda: `*`, número, faixa `a-b`, passo `/n`, lista `a,b`, nomes de mês
// e de dia. Recusa `?`, `L`, `#`, faixa invertida, passo zero e valor fora da faixa. E recusa o que roda mais de uma vez a cada
// `INTERVAL_EVERY_MINUTES_MIN` minutos (o piso que o produto já tem para intervalo; este módulo não o muda). Puro.
import { INTERVAL_EVERY_MINUTES_MIN } from "./routine-interval.js";

export type CronCheck = { ok: true } | { ok: false; reason: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldSpec = { label: string; min: number; max: number; names?: readonly string[]; nameBase?: number };
const FIELDS: readonly FieldSpec[] = [
	{ label: "minute", min: 0, max: 59 },
	{ label: "hour", min: 0, max: 23 },
	{ label: "day of month", min: 1, max: 31 },
	{ label: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
	{ label: "weekday", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

/** Um valor (número ou nome) → número, ou `null`. */
function valueOf(token: string, spec: FieldSpec): number | null {
	if (/^\d{1,2}$/.test(token)) {
		const n = Number(token);
		return n >= spec.min && n <= spec.max ? n : null;
	}
	const index = spec.names?.indexOf(token.toLowerCase()) ?? -1;
	return index >= 0 ? index + (spec.nameBase ?? 0) : null;
}

/** Valores que o campo dispara (só para minuto e hora precisamos da lista; os demais só são validados). `null` = campo inválido. */
function expandField(text: string, spec: FieldSpec): number[] | null {
	const out = new Set<number>();
	for (const item of text.split(",")) {
		if (item.length === 0) return null;
		const [rangePart, stepPart, ...extra] = item.split("/");
		if (extra.length > 0 || rangePart === undefined || rangePart.length === 0) return null;
		let step = 1;
		if (stepPart !== undefined) {
			if (!/^\d{1,2}$/.test(stepPart)) return null;
			step = Number(stepPart);
			if (step < 1) return null;
		}
		let from: number;
		let to: number;
		if (rangePart === "*") {
			from = spec.min;
			to = spec.label === "weekday" ? 6 : spec.max;
		} else if (rangePart.includes("-")) {
			const [a, b, ...more] = rangePart.split("-");
			if (more.length > 0 || a === undefined || b === undefined) return null;
			const lo = valueOf(a, spec);
			const hi = valueOf(b, spec);
			if (lo === null || hi === null || lo > hi) return null;
			from = lo;
			to = hi;
		} else {
			const single = valueOf(rangePart, spec);
			if (single === null) return null;
			from = single;
			// `5/10` = a partir de 5 de 10 em 10 até o fim do campo.
			to = stepPart !== undefined ? spec.max : single;
		}
		for (let n = from; n <= to; n += step) out.add(spec.label === "weekday" && n === 7 ? 0 : n);
	}
	return [...out].sort((x, y) => x - y);
}

const tooOften = `This cron runs more often than every ${INTERVAL_EVERY_MINUTES_MIN} minutes, which is the fastest a routine may run.`;

/** O cron é de 5 campos válidos e não passa do piso de frequência do produto? */
export function validateCronExpression(value: string): CronCheck {
	const parts = value.trim().split(/\s+/);
	if (parts.length !== 5) return { ok: false, reason: "A cron needs exactly 5 fields: minute hour day-of-month month weekday." };
	const sets: number[][] = [];
	for (const [index, part] of parts.entries()) {
		const spec = FIELDS[index]!;
		if (part.length === 0 || part.length > 80) return { ok: false, reason: `The ${spec.label} field is empty or too long.` };
		const values = expandField(part, spec);
		if (!values || values.length === 0) return { ok: false, reason: `The ${spec.label} field "${part.slice(0, 40)}" is not valid (allowed ${spec.min}-${spec.max}, lists, ranges a-b and steps /n).` };
		sets.push(values);
	}
	const minutes = sets[0]!;
	const hours = sets[1]!;
	for (let i = 1; i < minutes.length; i++) if (minutes[i]! - minutes[i - 1]! < INTERVAL_EVERY_MINUTES_MIN) return { ok: false, reason: tooOften };
	// Horas seguidas (inclusive 23 → 0): o último minuto de uma hora e o primeiro da seguinte também contam.
	const consecutiveHours = hours.some((h) => hours.includes((h + 1) % 24)) && hours.length > 1;
	if (consecutiveHours && minutes.length > 0 && minutes[0]! + 60 - minutes[minutes.length - 1]! < INTERVAL_EVERY_MINUTES_MIN) return { ok: false, reason: tooOften };
	return { ok: true };
}
