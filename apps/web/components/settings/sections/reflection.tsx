"use client";

import { BrainIcon, ClockIcon, PlayIcon, SparklesIcon } from "lucide-react";
import { formatMemoryUsage, readReflectionSettings, resolveOrchestratorMemoryChars } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Switch } from "@workspace/ui/components/switch";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import { useReflectionStatus } from "@/hooks/use-reflection-status";
import type { ReflectionStatusView } from "@/lib/atlas-api";
import { SettingRow, SettingsGroup } from "../setting-row";
import { SettingsPicker } from "@/components/ui/templates/template-4/settings-picker";
import { memoryOptions, reflectionStatusLabel } from "../reflection-state";
import { timeZoneLabel } from "../timezone-state";

/**
 * Reflexão diária do orquestrador (bot principal): uma vez por dia, no horário escolhido (fuso da
 * conta), ele revisa a memória e as conversas de todos os bots, limpa o que está duplicado ou
 * vencido e avisa só do que importa. Cada escolha salva na hora.
 */
export function ReflectionSettingsView({
	enabled,
	time,
	timeZone,
	memoryChars,
	memoryUsed,
	onMemoryChars,
	hasPrimary,
	status,
	statusError,
	busy,
	disabled = false,
	onToggle,
	onTime,
	onRunNow,
	isVisible = () => true,
	now,
}: {
	enabled: boolean;
	time: string;
	timeZone: string | undefined;
	/** Limite de memória do bot principal e quanto já está usado (null = não lido). */
	memoryChars: number;
	memoryUsed: number | null;
	onMemoryChars: (chars: number) => void;
	hasPrimary: boolean;
	status: Pick<ReflectionStatusView, "active" | "last" | "timezone"> | null;
	statusError?: string | null;
	busy: boolean;
	disabled?: boolean;
	onToggle: (enabled: boolean) => void;
	onTime: (time: string) => void;
	onRunNow: () => void;
	isVisible?: (itemId: string) => boolean;
	/** Relógio injetável (testes); padrão: agora. */
	now?: Date;
}) {
	if (!isVisible("geral.reflexao")) return null;
	const statusLine = statusError ?? reflectionStatusLabel(status, now);
	return (
		<SettingsGroup title="Reflexão diária">
			<SettingRow
				caption={<p>{hasPrimary ? "O bot principal revisa a memória e as conversas de todos os bots e avisa só do que importa." : "Defina um bot principal para usar."}</p>}
				control="inline"
				description="Uma vez por dia o bot principal junta memórias repetidas, apaga o que venceu e guarda o que viu nas outras conversas."
				htmlFor="settings-reflection-enabled"
				icon={SparklesIcon}
				label="Refletir todo dia"
			>
				<Switch
					aria-label="Refletir todo dia"
					checked={enabled}
					disabled={disabled || !hasPrimary}
					id="settings-reflection-enabled"
					onCheckedChange={onToggle}
				/>
			</SettingRow>
			{enabled ? (
				<SettingRow
					caption={timeZone ? <p>{`No fuso ${timeZoneLabel(timeZone)}.`}</p> : null}
					control="inline"
					description="Horário em que a reflexão roda todos os dias."
					htmlFor="settings-reflection-time"
					icon={ClockIcon}
					label="Horário"
				>
					<Input
						aria-label="Horário da reflexão"
						className="h-8 w-[7rem] px-2.5 text-[13px]"
						disabled={disabled}
						id="settings-reflection-time"
						onChange={(event) => event.target.value && onTime(event.target.value)}
						type="time"
						value={time}
					/>
				</SettingRow>
			) : null}
			{hasPrimary ? (
				<SettingRow
					caption={<p>{memoryUsed === null ? "Quanto o bot principal pode guardar." : `Em uso: ${formatMemoryUsage(memoryUsed, memoryChars)} caracteres.`}</p>}
					control="inline"
					description="O bot principal acumula pendências e fatos dos outros bots, então pode guardar mais. Os outros bots seguem o limite normal."
					htmlFor="settings-reflection-memory"
					icon={BrainIcon}
					label="Memória do bot principal"
				>
					<SettingsPicker
						disabled={disabled}
						id="settings-reflection-memory"
						onChange={(value) => onMemoryChars(Number(value))}
						options={memoryOptions(memoryChars)}
						value={String(memoryChars)}
					/>
				</SettingRow>
			) : null}
			{hasPrimary ? (
				<SettingRow
					caption={statusLine ? <p role="status">{statusLine}</p> : null}
					control="inline"
					description="Roda a reflexão uma vez agora, para testar."
					icon={PlayIcon}
					label="Refletir agora"
				>
					<Button disabled={disabled || busy || status?.active === true} onClick={onRunNow} size="sm" variant="outline">
						Refletir agora
					</Button>
				</SettingRow>
			) : null}
		</SettingsGroup>
	);
}

export function ReflectionSettings({
	account,
	open = true,
	isVisible,
}: {
	account: ReturnType<typeof useAccountSettings>;
	open?: boolean;
	isVisible?: (itemId: string) => boolean;
	/** Relógio injetável (testes); padrão: agora. */
	now?: Date;
}) {
	const reflection = useReflectionStatus(open);
	const settings = readReflectionSettings(account.view?.config);
	const view = reflection.view;
	return (
		<ReflectionSettingsView
			busy={reflection.starting}
			disabled={!account.view}
			enabled={settings.enabled}
			hasPrimary={view?.hasPrimary ?? true}
			isVisible={isVisible}
			memoryChars={resolveOrchestratorMemoryChars(account.view?.config)}
			memoryUsed={view?.memory.used ?? null}
			onMemoryChars={(memoryChars) => {
				void account.save({ reflection: { memoryChars } }).then(() => reflection.refresh());
			}}
			onRunNow={() => void reflection.runNow()}
			onTime={(time) => void account.save({ reflection: { time } })}
			onToggle={(enabled) => void account.save({ reflection: { enabled } })}
			status={view}
			statusError={reflection.error}
			time={settings.time}
			timeZone={account.view?.effective.general.timezone.value ?? view?.timezone}
		/>
	);
}
