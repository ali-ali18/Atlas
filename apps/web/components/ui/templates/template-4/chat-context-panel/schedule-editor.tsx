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

import type { ScheduleState } from "../data";

const TIME_OPTIONS = Array.from({ length: 96 }, (_, index) => {
	const hours = Math.floor(index / 4);
	const minutes = (index % 4) * 15;
	return `${hours}:${String(minutes).padStart(2, "0")}`;
});

const MINUTE_OPTIONS = [":00", ":15", ":30", ":45"];

const WEEKDAYS = [
	"segunda-feira",
	"terça-feira",
	"quarta-feira",
	"quinta-feira",
	"sexta-feira",
	"sábado",
	"domingo",
];

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

const FREQUENCIES = [
	{ id: "hourly", label: "A cada hora" },
	{ id: "daily", label: "Todos os dias" },
	{ id: "weekdays", label: "Dias úteis" },
	{ id: "weekly", label: "Toda semana" },
	{ id: "monthly", label: "Todos os meses" },
	{ id: "interval", label: "Intervalo" },
	{ id: "advanced", label: "Avançado" },
	{ id: "personalized", label: "Personalizado" },
];

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

export function scheduleLabel(state: ScheduleState): string {
	switch (state.frequency) {
		case "hourly":
			return `a cada hora aos ${state.minute}`;
		case "weekdays":
			return `nos dias úteis às ${state.time}`;
		case "weekly":
			return `a cada ${state.weekday} às ${state.time}`;
		case "monthly":
			return `todo dia ${state.monthDay} às ${state.time}`;
		case "interval":
			return `a cada ${state.intervalValue} ${state.intervalUnit}`;
		case "advanced":
			return "em um agendamento";
		case "personalized":
			return state.expression;
		default:
			return `todos os dias às ${state.time}`;
	}
}

function MiniSelect({
	className,
	onChange,
	options,
	value,
}: {
	className?: string;
	onChange: (value: string) => void;
	options: string[];
	value: string;
}) {
	return (
		<Select onValueChange={(next) => onChange(next as string)} value={value}>
			<SelectTrigger className={cn("h-7 text-xs", className)} size="sm">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option} value={option}>
						{option}
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
	const timeOptions =
		value.frequency === "hourly" ? MINUTE_OPTIONS : TIME_OPTIONS;

	const frequencySelect = (
		<Select
			onValueChange={(next) => onChange({ frequency: next as string })}
			value={value.frequency}
		>
			<SelectTrigger className="h-7 w-fit text-xs" size="sm">
				<SelectValue>
					{(current) => FREQUENCIES.find((item) => item.id === current)?.label}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{FREQUENCIES.map((frequency) => (
					<SelectItem key={frequency.id} value={frequency.id}>
						{frequency.label}
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
							<span className="text-muted-foreground text-xs">em</span>
							<MiniSelect
								onChange={(weekday) => onChange({ weekday })}
								options={WEEKDAYS}
								value={value.weekday}
							/>
						</>
					) : null}
					{value.frequency === "monthly" ? (
						<>
							<span className="text-muted-foreground text-xs">no dia</span>
							<MiniSelect
								onChange={(monthDay) => onChange({ monthDay })}
								options={MONTH_DAYS}
								value={value.monthDay}
							/>
						</>
					) : null}
					{value.frequency === "interval" ? (
						<>
							<span className="text-muted-foreground text-xs">a cada</span>
							<MiniSelect
								onChange={(intervalValue) => onChange({ intervalValue })}
								options={COUNTS}
								value={value.intervalValue}
							/>
							<MiniSelect
								onChange={(intervalUnit) => onChange({ intervalUnit })}
								options={INTERVAL_UNITS}
								value={value.intervalUnit}
							/>
						</>
					) : (
						<>
							<span className="text-muted-foreground text-xs">às</span>
							<MiniSelect
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
						<span className="w-14 text-muted-foreground text-xs">Meses</span>
						<MiniSelect
							className="flex-1"
							onChange={(month) => onChange({ month })}
							options={MONTHS}
							value={value.month}
						/>
					</div>
					<div className="flex items-center gap-2">
						<span className="w-14 text-muted-foreground text-xs">Dias</span>
						<MiniSelect
							className="flex-1"
							onChange={(days) => onChange({ days })}
							options={DAYS}
							value={value.days}
						/>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="w-14 text-muted-foreground text-xs">Horário</span>
						<MiniSelect
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
							onChange={(everyUnit) => onChange({ everyUnit })}
							options={INTERVAL_UNITS}
							value={value.everyUnit}
						/>
						<span className="text-muted-foreground text-xs">entre</span>
						<MiniSelect
							onChange={(from) => onChange({ from })}
							options={TIME_OPTIONS}
							value={value.from}
						/>
						<span className="text-muted-foreground text-xs">e</span>
						<MiniSelect
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
