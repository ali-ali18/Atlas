"use client";

import { BellIcon, BellRingIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import type { PushDevice } from "@/lib/atlas-api";
import { lastUsedLabel, pushStateText, type PushState } from "@/lib/push-client";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { SettingRow, SettingsGroup } from "../setting-row";

const BLOCKED: readonly PushState[] = ["server-off", "unsupported", "needs-install", "denied"];

/** Conta: "Notificações no celular" (ativar/desativar, testar) e a lista de aparelhos. */
export function NotificationsSettingsView({
	state,
	devices,
	currentDeviceId,
	busy = false,
	error,
	notice,
	onEnable,
	onDisable,
	onTest,
	onRemove,
	now,
	isVisible = () => true,
}: {
	state: PushState;
	devices: readonly PushDevice[];
	currentDeviceId: string | null;
	busy?: boolean;
	error?: string | null;
	notice?: string | null;
	onEnable: () => void;
	onDisable: () => void;
	onTest: () => void;
	onRemove: (id: string) => void;
	now?: number;
	isVisible?: (itemId: string) => boolean;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const on = state === "on";
	const blocked = BLOCKED.includes(state);
	return (
		<SettingsGroup title={t("settings.push.group")}>
			{isVisible("notificacoes.celular") ? (
				<SettingRow
					caption={
						<>
							<p data-slot="push-state">{pushStateText(state, translator)}</p>
							{error ? (
								<p className="text-destructive" role="alert">
									{error}
								</p>
							) : notice ? (
								<p role="status">{notice}</p>
							) : null}
						</>
					}
					control="inline"
					icon={BellIcon}
					label={t("settings.push.group")}
				>
					<Button disabled={busy || blocked} onClick={on ? onDisable : onEnable} size="sm" variant={on ? "outline" : "default"}>
						{on ? t("settings.push.disable") : t("settings.push.enable")}
					</Button>
				</SettingRow>
			) : null}
			{isVisible("notificacoes.celular") && on ? (
				<SettingRow control="inline" description={t("settings.push.testHint")} icon={BellRingIcon} label={t("settings.push.test")}>
					<Button disabled={busy} onClick={onTest} size="sm" variant="outline">
						{t("settings.push.test")}
					</Button>
				</SettingRow>
			) : null}
			{isVisible("notificacoes.aparelhos") ? (
				devices.length === 0 ? (
					<SettingRow caption={<p>{t("settings.push.noDevices")}</p>} icon={SmartphoneIcon} label={t("settings.push.devices")} />
				) : (
					devices.map((device) => (
						<SettingRow
							caption={
								<p data-slot="push-device-meta">
									{[device.id === currentDeviceId ? t("settings.push.thisDevice") : null, lastUsedLabel(device.lastUsedAt, now, translator) || null, device.failing ? t("settings.push.failing") : null]
										.filter(Boolean)
										.join(" · ")}
								</p>
							}
							control="inline"
							icon={SmartphoneIcon}
							key={device.id}
							label={device.label}
						>
							<Button aria-label={t("settings.push.removeAria", { device: device.label })} disabled={busy} onClick={() => onRemove(device.id)} size="icon-sm" variant="ghost">
								<Trash2Icon aria-hidden />
							</Button>
						</SettingRow>
					))
				)
			) : null}
		</SettingsGroup>
	);
}

export function NotificationsSettings({ isVisible }: { isVisible: (itemId: string) => boolean }) {
	const push = usePushNotifications();
	return (
		<NotificationsSettingsView
			busy={push.busy || push.loading}
			currentDeviceId={push.currentDeviceId}
			devices={push.devices}
			error={push.error}
			isVisible={isVisible}
			notice={push.notice}
			onDisable={() => void push.disable()}
			onEnable={() => void push.enable()}
			onRemove={(id) => void push.remove(id)}
			onTest={() => void push.test()}
			state={push.state}
		/>
	);
}
