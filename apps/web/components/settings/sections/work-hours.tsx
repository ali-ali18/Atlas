"use client";

import { CalendarDaysIcon, BriefcaseIcon } from "lucide-react";
import { parseWorkHours, readWorkHours, type WorkHours } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import { Input } from "@workspace/ui/components/input";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";
import type { SaveStatus } from "../account-settings-state";

/** Segunda a domingo na tela; o valor salvo usa 0 = domingo. */
export const WORK_DAY_OPTIONS = [
	{ day: 1, short: "S", label: "Segunda" },
	{ day: 2, short: "T", label: "Terça" },
	{ day: 3, short: "Q", label: "Quarta" },
	{ day: 4, short: "Q", label: "Quinta" },
	{ day: 5, short: "S", label: "Sexta" },
	{ day: 6, short: "S", label: "Sábado" },
	{ day: 0, short: "D", label: "Domingo" },
] as const;

export const WORK_HOURS_ORDER_ERROR = "O início precisa ser antes do fim.";
export const WORK_HOURS_DAYS_ERROR = "Escolha ao menos um dia.";

/** Próximo valor depois de uma edição, ou o motivo de não salvar. Pura, para testar sem tela. */
export function nextWorkHours(
	current: WorkHours,
	change: { start?: string; end?: string; toggleDay?: number },
): { ok: true; value: WorkHours } | { ok: false; error: string } {
	const days =
		change.toggleDay === undefined
			? current.days
			: current.days.includes(change.toggleDay)
				? current.days.filter((d) => d !== change.toggleDay)
				: [...current.days, change.toggleDay];
	if (days.length === 0) return { ok: false, error: WORK_HOURS_DAYS_ERROR };
	const candidate = { start: change.start ?? current.start, end: change.end ?? current.end, days };
	const parsed = parseWorkHours(candidate);
	return parsed ? { ok: true, value: parsed } : { ok: false, error: WORK_HOURS_ORDER_ERROR };
}

/**
 * Horário de trabalho da conta: janela do dia e dias úteis, no fuso da conta. Os dois campos de
 * hora e os dias salvam na hora; valor inválido não é enviado e mostra o motivo.
 */
export function WorkHoursSettingsView({
	value,
	onChange,
	status,
	saveError,
	localError,
	disabled = false,
	isVisible = () => true,
}: {
	value: WorkHours;
	onChange: (change: { start?: string; end?: string; toggleDay?: number }) => void;
	status: SaveStatus;
	saveError?: string | null;
	/** Erro de validação local (não enviado ao servidor). */
	localError?: string | null;
	disabled?: boolean;
	isVisible?: (itemId: string) => boolean;
}) {
	if (!isVisible("geral.horario")) return null;
	return (
		<SettingsGroup title="Expediente">
			<SettingRow
				caption={localError ? <p role="alert">{localError}</p> : <SaveIndicator error={saveError} status={status} />}
				control="inline"
				description="Início e fim do expediente, no fuso da conta. O bot usa para escolher quando chamar você."
				icon={BriefcaseIcon}
				label="Horário de trabalho"
				wrap
			>
				<Input
					aria-label="Início do expediente"
					className="h-8 w-[7rem] px-2.5 text-[13px]"
					disabled={disabled}
					onChange={(event) => event.target.value && onChange({ start: event.target.value })}
					type="time"
					value={value.start}
				/>
				<span aria-hidden className="text-muted-foreground">
					–
				</span>
				<Input
					aria-label="Fim do expediente"
					className="h-8 w-[7rem] px-2.5 text-[13px]"
					disabled={disabled}
					onChange={(event) => event.target.value && onChange({ end: event.target.value })}
					type="time"
					value={value.end}
				/>
			</SettingRow>
			<SettingRow
				control="inline"
				description="Dias da semana em que você trabalha."
				icon={CalendarDaysIcon}
				label="Dias úteis"
				wrap
			>
				<ButtonGroup aria-label="Dias úteis">
					{WORK_DAY_OPTIONS.map((option) => {
						const selected = value.days.includes(option.day);
						return (
							<Button
								aria-label={option.label}
								aria-pressed={selected}
								className="w-8 px-0"
								disabled={disabled}
								key={option.day}
								onClick={() => onChange({ toggleDay: option.day })}
								size="sm"
								title={option.label}
								type="button"
								variant={selected ? "default" : "outline"}
							>
								{option.short}
							</Button>
						);
					})}
				</ButtonGroup>
			</SettingRow>
		</SettingsGroup>
	);
}

export function WorkHoursSettings({
	account,
	isVisible,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
}) {
	const value = readWorkHours(account.view?.config);
	return (
		<WorkHoursSettingsView
			disabled={!account.view}
			isVisible={isVisible}
			onChange={(change) => {
				const next = nextWorkHours(value, change);
				if (next.ok) void account.save({ general: { workHours: next.value } });
			}}
			saveError={account.saveError}
			status={account.status}
			value={value}
		/>
	);
}
