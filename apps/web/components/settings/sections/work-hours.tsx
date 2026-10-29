"use client";

import { CalendarDaysIcon, BriefcaseIcon } from "lucide-react";
import { useState } from "react";
import { parseWorkHours, readWorkHours, type WorkHours } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { ButtonGroup } from "@workspace/ui/components/button-group";
import { Input } from "@workspace/ui/components/input";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";
import type { SaveStatus } from "../account-settings-state";

/** Segunda a domingo na tela; o valor salvo usa 0 = domingo. */
export const WORK_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

const DAY_LABEL_KEYS = {
	0: "settings.workHours.day.0",
	1: "settings.workHours.day.1",
	2: "settings.workHours.day.2",
	3: "settings.workHours.day.3",
	4: "settings.workHours.day.4",
	5: "settings.workHours.day.5",
	6: "settings.workHours.day.6",
} as const;

const DAY_SHORT_KEYS = {
	0: "settings.workHours.dayShort.0",
	1: "settings.workHours.dayShort.1",
	2: "settings.workHours.dayShort.2",
	3: "settings.workHours.dayShort.3",
	4: "settings.workHours.dayShort.4",
	5: "settings.workHours.dayShort.5",
	6: "settings.workHours.dayShort.6",
} as const;

/** Nome e inicial de cada dia, no idioma da tela. */
export function workDayOptions({ t }: Translator = defaultTranslator) {
	return WORK_DAYS.map((day) => ({ day, short: t(DAY_SHORT_KEYS[day]), label: t(DAY_LABEL_KEYS[day]) }));
}

export const WORK_HOURS_ORDER_ERROR = defaultTranslator.t("settings.workHours.orderError");
export const WORK_HOURS_DAYS_ERROR = defaultTranslator.t("settings.workHours.daysError");

/** Próximo valor depois de uma edição, ou o motivo de não salvar. Pura, para testar sem tela. */
export function nextWorkHours(
	current: WorkHours,
	change: { start?: string; end?: string; toggleDay?: number },
	{ t }: Translator = defaultTranslator,
): { ok: true; value: WorkHours } | { ok: false; error: string } {
	const days =
		change.toggleDay === undefined
			? current.days
			: current.days.includes(change.toggleDay)
				? current.days.filter((d) => d !== change.toggleDay)
				: [...current.days, change.toggleDay];
	if (days.length === 0) return { ok: false, error: t("settings.workHours.daysError") };
	const candidate = { start: change.start ?? current.start, end: change.end ?? current.end, days };
	const parsed = parseWorkHours(candidate);
	return parsed ? { ok: true, value: parsed } : { ok: false, error: t("settings.workHours.orderError") };
}

/**
 * O que o container faz a cada edição: valor válido vai para salvar e limpa o erro; inválido não é enviado e
 * devolve o motivo para a tela. Pura, para testar o fluxo sem DOM.
 */
export function resolveWorkHoursEdit(
	current: WorkHours,
	change: { start?: string; end?: string; toggleDay?: number },
	translator: Translator = defaultTranslator,
): { save: WorkHours | null; error: string | null } {
	const next = nextWorkHours(current, change, translator);
	return next.ok ? { save: next.value, error: null } : { save: null, error: next.error };
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
	const translator = useTranslations();
	const { t } = translator;
	if (!isVisible("geral.horario")) return null;
	return (
		<SettingsGroup title={t("settings.workHours.group")}>
			<SettingRow
				caption={localError ? <p role="alert">{localError}</p> : <SaveIndicator error={saveError} status={status} />}
				control="inline"
				description={t("settings.workHours.hint")}
				icon={BriefcaseIcon}
				label={t("settings.workHours.label")}
				wrap
			>
				<Input
					aria-label={t("settings.workHours.startAria")}
					className="h-8 w-[9rem] px-2.5 text-body"
					disabled={disabled}
					onChange={(event) => event.target.value && onChange({ start: event.target.value })}
					type="time"
					value={value.start}
				/>
				<span aria-hidden className="text-muted-foreground">
					–
				</span>
				<Input
					aria-label={t("settings.workHours.endAria")}
					className="h-8 w-[9rem] px-2.5 text-body"
					disabled={disabled}
					onChange={(event) => event.target.value && onChange({ end: event.target.value })}
					type="time"
					value={value.end}
				/>
			</SettingRow>
			<SettingRow
				control="inline"
				description={t("settings.workHours.daysHint")}
				icon={CalendarDaysIcon}
				label={t("settings.workHours.days")}
				wrap
			>
				<ButtonGroup aria-label={t("settings.workHours.days")}>
					{workDayOptions(translator).map((option) => {
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
	const translator = useTranslations();
	const [localError, setLocalError] = useState<string | null>(null);
	return (
		<WorkHoursSettingsView
			disabled={!account.view}
			isVisible={isVisible}
			localError={localError}
			onChange={(change) => {
				const edit = resolveWorkHoursEdit(value, change, translator);
				setLocalError(edit.error);
				if (edit.save) void account.save({ general: { workHours: edit.save } });
			}}
			saveError={account.saveError}
			status={account.status}
			value={value}
		/>
	);
}
