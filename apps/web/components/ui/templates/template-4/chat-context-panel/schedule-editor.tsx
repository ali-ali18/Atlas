"use client";

import { Input } from "@workspace/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@workspace/ui/components/select";
import { cn } from "@workspace/ui/lib/utils";

import { formatTime } from "@/lib/format";
import type { UiLocale } from "@/lib/i18n/locales";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import type { ScheduleState } from "../data";

const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
	const hours = Math.floor(index / 4);
	const minutes = (index % 4) * 15;
	return `${hours}:${String(minutes).padStart(2, "0")}`;
});

const MINUTE_OPTIONS = [":00", ":15", ":30", ":45"];

// Os valores abaixo são o que `scheduleStateToCron` (shared) entende: ficam em pt-BR. Só o rótulo na tela é traduzido.
const WEEKDAYS = [
	"segunda-feira",
	"terça-feira",
	"quarta-feira",
	"quinta-feira",
	"sexta-feira",
	"sábado",
	"domingo",
];

const WEEKDAY_IDS: Record<string, "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> = {
	"segunda-feira": "mon",
	"terça-feira": "tue",
	"quarta-feira": "wed",
	"quinta-feira": "thu",
	"sexta-feira": "fri",
	sábado: "sat",
	domingo: "sun",
};

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => String(index + 1));

const MONTHS = [
	"Qualquer mês",
	"Janeiro",
	"Fevereiro",
	"Março",
	"Abril",
	"Maio",
	"Junho",
	"Julho",
	"Agosto",
	"Setembro",
	"Outubro",
	"Novembro",
	"Dezembro",
];

const DAYS = ["Todos os dias", "Dias úteis", "Fins de semana"];

const INTERVAL_UNITS = ["minutos", "horas"];

const COUNTS = Array.from({ length: 60 }, (_, index) => String(index + 1));

const CADENCES = ["A cada", "A cada hora"];

const FREQUENCY_IDS = ["hourly", "daily", "weekdays", "weekly", "monthly", "interval", "advanced", "personalized"] as const;

export type { ScheduleState };

export const DEFAULT_SCHEDULE: ScheduleState = {
	frequency: "daily",
	time: "9:00",
	minute: ":00",
	weekday: "segunda-feira",
	monthDay: "1",
	intervalValue: "30",
	intervalUnit: "minutos",
	month: "Qualquer mês",
	days: "Todos os dias",
	cadence: "A cada",
	everyValue: "30",
	everyUnit: "minutos",
	from: "0:00",
	to: "23:00",
	expression: "@every 30m",
};

/** "9:00" no relógio do idioma: 24 h fica como está; 12 h (en) vira "9:00 AM". O valor guardado não muda. */
export function scheduleTimeLabel(value: string, locale: UiLocale): string {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (!match) return value;
	const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
	if (cycle !== "h12" && cycle !== "h11") return value;
	return formatTime(new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2]))), locale, { timeZone: "UTC" });
}

/** Rótulo do dia da semana guardado em pt ("segunda-feira"). */
export function weekdayLabel(value: string, { t }: Translator = defaultTranslator): string {
	const id = WEEKDAY_IDS[value];
	return id ? t(`routines.weekday.${id}`) : value;
}

const DAYS_KEYS: Record<string, "routines.days.all" | "routines.days.weekdays" | "routines.days.weekends"> = {
	"Todos os dias": "routines.days.all",
	"Dias úteis": "routines.days.weekdays",
	"Fins de semana": "routines.days.weekends",
};
const CADENCE_KEYS: Record<string, "routines.cadence.every" | "routines.cadence.hourly"> = {
	"A cada": "routines.cadence.every",
	"A cada hora": "routines.cadence.hourly",
};
const UNIT_KEYS: Record<string, "routines.unit.minutos" | "routines.unit.horas"> = {
	minutos: "routines.unit.minutos",
	horas: "routines.unit.horas",
};

export function scheduleUnitLabel(value: string, { t }: Translator = defaultTranslator): string {
	const key = UNIT_KEYS[value];
	return key ? t(key) : value;
}

/** Frase do agendamento ("nos dias úteis às 9:00"), no idioma da tela. */
export function scheduleLabel(state: ScheduleState, translator: Translator = defaultTranslator): string {
	const { t, locale } = translator;
	const time = scheduleTimeLabel(state.time, locale);
	switch (state.frequency) {
		case "hourly":
			return t("routines.sched.label.hourly", { minute: state.minute });
		case "weekdays":
			return t("routines.sched.label.weekdays", { time });
		case "weekly":
			return t("routines.sched.label.weekly", { weekday: weekdayLabel(state.weekday, translator), time });
		case "monthly":
			return t("routines.sched.label.monthly", { day: state.monthDay, time });
		case "interval":
			return t("routines.sched.label.interval", { value: state.intervalValue, unit: scheduleUnitLabel(state.intervalUnit, translator) });
		case "advanced":
			return t("routines.sched.label.advanced");
		case "personalized":
			return state.expression;
		default:
			return t("routines.sched.label.daily", { time });
	}
}

function MiniSelect({
	className,
	label,
	onChange,
	options,
	value,
}: {
	className?: string;
	/** Texto mostrado para cada valor; o valor guardado não muda. */
	label?: (value: string) => string;
	onChange: (value: string) => void;
	options: string[];
	value: string;
}) {
	const show = label ?? ((option: string) => option);
	return (
		<Select onValueChange={(next) => onChange(next as string)} value={value}>
			<SelectTrigger className={cn("h-7 text-xs", className)} size="sm">
				<SelectValue>{(current) => show(String(current ?? value))}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option} value={option}>
						{show(option)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function ScheduleEditor({
	onChange,
	value,
}: {
	onChange: (patch: Partial<ScheduleState>) => void;
	value: ScheduleState;
}) {
	const translator = useTranslations();
	const { t, locale } = translator;
	const timeOptions =
		value.frequency === "hourly" ? MINUTE_OPTIONS : TIME_OPTIONS;
	const timeText = (option: string) => scheduleTimeLabel(option, locale);
	const monthText = (option: string) => (option === "Qualquer mês" ? t("routines.month.any") : t(`routines.month.${MONTHS.indexOf(option)}` as "routines.month.1"));
	const daysText = (option: string) => (DAYS_KEYS[option] ? t(DAYS_KEYS[option]) : option);
	const cadenceText = (option: string) => (CADENCE_KEYS[option] ? t(CADENCE_KEYS[option]) : option);

	const frequencySelect = (
		<Select
			onValueChange={(next) => onChange({ frequency: next as string })}
			value={value.frequency}
		>
			<SelectTrigger className="h-7 w-fit text-xs" size="sm">
				<SelectValue>
					{(current) => (FREQUENCY_IDS.includes(current as (typeof FREQUENCY_IDS)[number]) ? t(`routines.freq.${current as (typeof FREQUENCY_IDS)[number]}`) : undefined)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{FREQUENCY_IDS.map((id) => (
					<SelectItem key={id} value={id}>
						{t(`routines.freq.${id}`)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	const inlineDetails =
		value.frequency === "hourly" ||
		value.frequency === "daily" ||
		value.frequency === "weekdays" ||
		value.frequency === "weekly" ||
		value.frequency === "monthly" ||
		value.frequency === "interval";

	return (
		<div className="flex flex-col gap-2">
			{inlineDetails ? (
				<div className="flex flex-wrap items-center gap-2">
					{frequencySelect}
					{value.frequency === "weekly" ? (
						<>
							<span className="text-muted-foreground text-xs">{t("routines.sched.on")}</span>
							<MiniSelect
								label={(option) => weekdayLabel(option, translator)}
								onChange={(weekday) => onChange({ weekday })}
								options={WEEKDAYS}
								value={value.weekday}
							/>
						</>
					) : null}
					{value.frequency === "monthly" ? (
						<>
							<span className="text-muted-foreground text-xs">{t("routines.sched.onDay")}</span>
							<MiniSelect
								onChange={(monthDay) => onChange({ monthDay })}
								options={MONTH_DAYS}
								value={value.monthDay}
							/>
						</>
					) : null}
					{value.frequency === "interval" ? (
						<>
							<span className="text-muted-foreground text-xs">{t("routines.sched.every")}</span>
							<MiniSelect
								onChange={(intervalValue) => onChange({ intervalValue })}
								options={COUNTS}
								value={value.intervalValue}
							/>
							<MiniSelect
								label={(option) => scheduleUnitLabel(option, translator)}
								onChange={(intervalUnit) => onChange({ intervalUnit })}
								options={INTERVAL_UNITS}
								value={value.intervalUnit}
							/>
						</>
					) : (
						<>
							<span className="text-muted-foreground text-xs">{t("routines.sched.at")}</span>
							<MiniSelect
								label={value.frequency === "hourly" ? undefined : timeText}
								onChange={(time) => onChange({ time })}
								options={timeOptions}
								value={value.frequency === "hourly" ? value.minute : value.time}
							/>
						</>
					)}
				</div>
			) : (
				frequencySelect
			)}

			{value.frequency === "advanced" ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<span className="w-14 text-muted-foreground text-xs">{t("routines.sched.months")}</span>
						<MiniSelect
							className="flex-1"
							label={monthText}
							onChange={(month) => onChange({ month })}
							options={MONTHS}
							value={value.month}
						/>
					</div>
					<div className="flex items-center gap-2">
						<span className="w-14 text-muted-foreground text-xs">{t("routines.sched.days")}</span>
						<MiniSelect
							className="flex-1"
							label={daysText}
							onChange={(days) => onChange({ days })}
							options={DAYS}
							value={value.days}
						/>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="w-14 text-muted-foreground text-xs">{t("routines.sched.time")}</span>
						<MiniSelect
							label={cadenceText}
							onChange={(cadence) => onChange({ cadence })}
							options={CADENCES}
							value={value.cadence}
						/>
						<MiniSelect
							onChange={(everyValue) => onChange({ everyValue })}
							options={COUNTS}
							value={value.everyValue}
						/>
						<MiniSelect
							label={(option) => scheduleUnitLabel(option, translator)}
							onChange={(everyUnit) => onChange({ everyUnit })}
							options={INTERVAL_UNITS}
							value={value.everyUnit}
						/>
						<span className="text-muted-foreground text-xs">{t("routines.sched.between")}</span>
						<MiniSelect
							label={timeText}
							onChange={(from) => onChange({ from })}
							options={TIME_OPTIONS}
							value={value.from}
						/>
						<span className="text-muted-foreground text-xs">{t("routines.sched.and")}</span>
						<MiniSelect
							label={timeText}
							onChange={(to) => onChange({ to })}
							options={TIME_OPTIONS}
							value={value.to}
						/>
					</div>
				</div>
			) : null}

			{value.frequency === "personalized" ? (
				<Input
					className="h-8 text-sm"
					onChange={(event) => onChange({ expression: event.target.value })}
					placeholder="@every 30m"
					value={value.expression}
				/>
			) : null}
		</div>
	);
}
