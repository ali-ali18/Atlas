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
	if (!proactiveAvailable(agent)) return null;
	const policyJson = (agent as { policyJson?: unknown }).policyJson;
	const settings = readProactiveSettings(policyJson, accountTimezone);
	const change = (next: ProactiveChange) =>
		onChange({ policyJson: applyProactiveChange(policyJson, next, accountTimezone) });
	const routineHint = ROUTINE_MODE_OPTIONS.find((option) => option.value === settings.routineMode)?.hint;

	return (
		<SettingsStack>
			<SettingsGroup>
				<SettingRow
					caption={<p>Cria lembretes e sugere rotinas sozinho. Só fala no chat.</p>}
					control="inline"
					description="O bot principal pode falar primeiro: lembra de prazos e sugere rotinas."
					htmlFor="proactive-enabled"
					icon={SparklesIcon}
					label="Modo proativo"
				>
					<Switch
						aria-label="Modo proativo"
						checked={settings.enabled}
						id="proactive-enabled"
						onCheckedChange={(checked) => change({ type: "enabled", value: checked })}
					/>
				</SettingRow>
			</SettingsGroup>

			{settings.enabled ? (
				<div data-proactive-options>
					<SettingsGroup title="Opções">
						<SettingRow
							caption={routineHint ? <p>{routineHint}</p> : null}
							description="O que o bot faz quando percebe algo que vale virar rotina."
							htmlFor="proactive-routine-mode"
							icon={CalendarClockIcon}
							label="Rotinas"
						>
							<SettingsPicker
								id="proactive-routine-mode"
								onChange={(value) => change({ type: "routineMode", value })}
								options={ROUTINE_MODE_OPTIONS.map(({ value, label }) => ({ value, label }))}
								value={settings.routineMode}
							/>
						</SettingRow>

						<SettingRow
							description="Teto de mensagens que o bot começa sozinho em um dia."
							htmlFor="proactive-max-per-day"
							icon={MessageSquareIcon}
							label="Máx. mensagens proativas por dia"
						>
							<SettingsPicker
								id="proactive-max-per-day"
								onChange={(value) => change({ type: "maxPerDay", value: Number(value) })}
								options={MAX_PER_DAY_OPTIONS}
								value={String(settings.maxPerDay)}
							/>
						</SettingRow>

						<SettingRow
							caption={<p>O bot não escreve sozinho nesse período.</p>}
							control="inline"
							htmlFor="proactive-quiet-start"
							icon={MoonIcon}
							label="Horário de silêncio"
							wrap
						>
							<div className="flex items-center gap-2">
								<Input
									aria-label="Início do silêncio"
									className="h-8 w-[7rem] px-2.5 text-body"
									id="proactive-quiet-start"
									onChange={(event) => change({ type: "quiet", start: event.target.value })}
									type="time"
									value={settings.quietStart.padStart(5, "0")}
								/>
								<span className="text-muted-foreground text-xs">até</span>
								<Input
									aria-label="Fim do silêncio"
									className="h-8 w-[7rem] px-2.5 text-body"
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
									{accountTimezone ? "Das configurações da conta." : "Do navegador, ao ligar."}
								</p>
							}
							control="inline"
							icon={GlobeIcon}
							label="Fuso horário"
						>
							<span className="text-body text-muted-foreground">{timeZoneLabel(settings.timezone)}</span>
						</SettingRow>
					</SettingsGroup>
				</div>
			) : null}
		</SettingsStack>
	);
}
