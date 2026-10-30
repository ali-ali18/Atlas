"use client";

import { CalendarClockIcon, GlobeIcon, MessageSquareIcon, MoonIcon, SparklesIcon } from "lucide-react";
import { Input } from "@workspace/ui/components/input";
import { Switch } from "@workspace/ui/components/switch";
import { timeZoneLabel } from "@/components/settings/timezone-state";
import { SettingRow, SettingsGroup, SettingsStack } from "@/components/settings/setting-row";
import {
	MAX_PER_DAY_OPTIONS,
	ROUTINE_MODE_OPTIONS,
	applyProactiveChange,
	proactiveAvailable,
	readProactiveSettings,
	type ProactiveChange,
} from "@/lib/proactive-settings";
import { useTranslations } from "@/lib/i18n/provider";
import type { Agent } from "../data";
import { SettingsPicker } from "../settings-picker";

/**
 * Subtela "Modo proativo" do bot principal: o bot lembra sozinho de prazos, sugere rotinas e só
 * fala no chat. Tudo salva na hora. Fora do bot principal não há nada para mostrar.
 * `accountTimezone` (das configurações da conta) manda sobre o fuso guardado no bot.
 */
export function ProactiveSettingsSection({
	agent,
	onChange,
	accountTimezone,
}: {
	agent: Agent;
	onChange: (patch: { policyJson: unknown }) => void;
	accountTimezone?: string;
}) {
	const { t } = useTranslations();
	if (!proactiveAvailable(agent)) return null;
	const policyJson = (agent as { policyJson?: unknown }).policyJson;
	const settings = readProactiveSettings(policyJson, accountTimezone);
	const change = (next: ProactiveChange) =>
		onChange({ policyJson: applyProactiveChange(policyJson, next, accountTimezone) });
	const routineHint = ROUTINE_MODE_OPTIONS.find((option) => option.value === settings.routineMode)
		? t(settings.routineMode === "auto" ? "botSettings.pro.hint.auto" : "botSettings.pro.hint.suggest")
		: undefined;

	return (
		<SettingsStack>
			<SettingsGroup>
				<SettingRow
					caption={<p>{t("botSettings.pro.enabledCaption")}</p>}
					control="inline"
					description={t("botSettings.pro.enabledDesc")}
					htmlFor="proactive-enabled"
					icon={SparklesIcon}
					label={t("botSettings.proactive")}
				>
					<Switch
						aria-label={t("botSettings.proactive")}
						checked={settings.enabled}
						id="proactive-enabled"
						onCheckedChange={(checked) => change({ type: "enabled", value: checked })}
					/>
				</SettingRow>
			</SettingsGroup>

			{settings.enabled ? (
				<div data-proactive-options>
					<SettingsGroup title={t("botSettings.pro.options")}>
						<SettingRow
							caption={routineHint ? <p>{routineHint}</p> : null}
							description={t("botSettings.pro.routinesDesc")}
							htmlFor="proactive-routine-mode"
							icon={CalendarClockIcon}
							label={t("botSettings.pro.routines")}
						>
							<SettingsPicker
								id="proactive-routine-mode"
								onChange={(value) => change({ type: "routineMode", value })}
								options={ROUTINE_MODE_OPTIONS.map(({ value }) => ({ value, label: t(value === "auto" ? "botSettings.pro.mode.auto" : "botSettings.pro.mode.suggest") }))}
								value={settings.routineMode}
							/>
						</SettingRow>

						<SettingRow
							description={t("botSettings.pro.maxPerDayDesc")}
							htmlFor="proactive-max-per-day"
							icon={MessageSquareIcon}
							label={t("botSettings.pro.maxPerDay")}
						>
							<SettingsPicker
								id="proactive-max-per-day"
								onChange={(value) => change({ type: "maxPerDay", value: Number(value) })}
								options={MAX_PER_DAY_OPTIONS}
								value={String(settings.maxPerDay)}
							/>
						</SettingRow>

						<SettingRow
							caption={<p>{t("botSettings.pro.quietHelp")}</p>}
							control="inline"
							htmlFor="proactive-quiet-start"
							icon={MoonIcon}
							label={t("botSettings.pro.quiet")}
							wrap
						>
							<div className="flex items-center gap-2">
								<Input
									aria-label={t("botSettings.pro.quietStart")}
									className="h-8 w-[9rem] px-2.5 text-body"
									id="proactive-quiet-start"
									onChange={(event) => change({ type: "quiet", start: event.target.value })}
									type="time"
									value={settings.quietStart.padStart(5, "0")}
								/>
								<span className="text-muted-foreground text-xs">{t("botSettings.pro.until")}</span>
								<Input
									aria-label={t("botSettings.pro.quietEnd")}
									className="h-8 w-[9rem] px-2.5 text-body"
									id="proactive-quiet-end"
									onChange={(event) => change({ type: "quiet", end: event.target.value })}
									type="time"
									value={settings.quietEnd.padStart(5, "0")}
								/>
							</div>
						</SettingRow>

						<SettingRow
							caption={
								<p>
									{accountTimezone ? t("botSettings.pro.tzAccount") : t("botSettings.pro.tzBrowser")}
								</p>
							}
							control="inline"
							icon={GlobeIcon}
							label={t("botSettings.pro.timezone")}
						>
							<span className="text-body text-muted-foreground">{timeZoneLabel(settings.timezone)}</span>
						</SettingRow>
					</SettingsGroup>
				</div>
			) : null}
		</SettingsStack>
	);
}
