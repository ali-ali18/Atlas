export type ScheduleCronInput = {
	frequency: string;
	time: string;
	minute: string;
	weekday: string;
	monthDay: string;
	intervalValue: string;
	intervalUnit: string;
	expression: string;
};

const WEEKDAY_CRON: Record<string, string> = {
	domingo: "0",
	"segunda-feira": "1",
	"terça-feira": "2",
	"quarta-feira": "3",
	"quinta-feira": "4",
	"sexta-feira": "5",
	sábado: "6",
};

function parseClock(value: string): { minute: number; hour: number } {
	const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return { hour: 9, minute: 0 };
	const hour = Math.min(23, Math.max(0, Number(match[1])));
	const minute = Math.min(59, Math.max(0, Number(match[2])));
	return { hour, minute };
}

function minuteFromColon(value: string): number {
	const n = Number(String(value).replace(":", ""));
	if (!Number.isFinite(n)) return 0;
	return Math.min(59, Math.max(0, n));
}

export function isCronFive(value: string): boolean {
	const parts = value.trim().split(/\s+/);
	return parts.length === 5 && parts.every((part) => part.length > 0 && part.length < 80);
}

const emptySchedule = (): ScheduleCronInput => ({
	frequency: "daily",
	time: "9:00",
	minute: ":00",
	weekday: "segunda-feira",
	monthDay: "1",
	intervalValue: "30",
	intervalUnit: "minutos",
	expression: "",
});

function padClock(hour: string, minute: string): string {
	const h = Number.parseInt(hour, 10);
	const m = Number.parseInt(minute, 10);
	if (!Number.isFinite(h) || !Number.isFinite(m)) return "9:00";
	return `${h}:${String(m).padStart(2, "0")}`;
}

const CRON_WEEKDAY: Record<string, string> = Object.fromEntries(
	Object.entries(WEEKDAY_CRON).map(([name, value]) => [value, name]),
);

/** Reabre o editor a partir do cron persistido. */
export function cronToScheduleInput(cron: string): ScheduleCronInput {
	const trimmed = cron.trim();
	const base = { ...emptySchedule(), expression: trimmed };
	if (!isCronFive(trimmed)) {
		return { ...base, frequency: "advanced" };
	}
	const parts = trimmed.split(/\s+/);
	const minute = parts[0] ?? "*";
	const hour = parts[1] ?? "*";
	const dom = parts[2] ?? "*";
	const month = parts[3] ?? "*";
	const dow = parts[4] ?? "*";
	if (minute.startsWith("*/") && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		return {
			...base,
			frequency: "interval",
			intervalValue: minute.slice(2) || "30",
			intervalUnit: "minutos",
		};
	}
	if (minute === "0" && hour.startsWith("*/") && dom === "*" && month === "*" && dow === "*") {
		return {
			...base,
			frequency: "interval",
			intervalValue: hour.slice(2) || "6",
			intervalUnit: "horas",
		};
	}
	if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		return {
			...base,
			frequency: "hourly",
			minute: `:${minute.padStart(2, "0")}`,
		};
	}
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "1-5") {
		return { ...base, frequency: "weekdays", time: padClock(hour, minute) };
	}
	if (
		/^\d+$/.test(minute) &&
		/^\d+$/.test(hour) &&
		dom === "*" &&
		month === "*" &&
		CRON_WEEKDAY[dow]
	) {
		return {
			...base,
			frequency: "weekly",
			time: padClock(hour, minute),
			weekday: CRON_WEEKDAY[dow] ?? "segunda-feira",
		};
	}
	if (
		/^\d+$/.test(minute) &&
		/^\d+$/.test(hour) &&
		/^\d+$/.test(dom) &&
		month === "*" &&
		dow === "*"
	) {
		return {
			...base,
			frequency: "monthly",
			time: padClock(hour, minute),
			monthDay: dom,
		};
	}
	if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") {
		return { ...base, frequency: "daily", time: padClock(hour, minute) };
	}
	return { ...base, frequency: "advanced" };
}

/** Converte o editor de agenda da UI para cron de 5 campos. */
export function scheduleStateToCron(schedule: ScheduleCronInput): string {
	const { hour, minute } = parseClock(schedule.time || "9:00");
	const interval = Math.max(1, Number.parseInt(schedule.intervalValue || "30", 10) || 30);
	switch (schedule.frequency) {
		case "hourly":
			return `${minuteFromColon(schedule.minute || ":00")} * * * *`;
		case "weekdays":
			return `${minute} ${hour} * * 1-5`;
		case "weekly": {
			const dow = WEEKDAY_CRON[schedule.weekday] ?? "1";
			return `${minute} ${hour} * * ${dow}`;
		}
		case "monthly": {
			const day = Math.min(31, Math.max(1, Number.parseInt(schedule.monthDay || "1", 10) || 1));
			return `${minute} ${hour} ${day} * *`;
		}
		case "interval":
			if (schedule.intervalUnit === "horas") {
				return `0 */${interval} * * *`;
			}
			return `*/${Math.min(59, interval)} * * * *`;
		case "advanced":
		case "personalized":
			if (schedule.expression && isCronFive(schedule.expression)) {
				return schedule.expression.trim();
			}
			return `${minute} ${hour} * * *`;
		default:
			return `${minute} ${hour} * * *`;
	}
}
