"use client";

import { BellIcon, BellRingIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import type { PushDevice } from "@/lib/atlas-api";
import type { PushState } from "@/lib/push-client";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { SettingRow, SettingsGroup } from "../setting-row";

const PUSH_STATE_KEYS = {
	"server-off": "settings.push.state.serverOff",
	unsupported: "settings.push.state.unsupported",
	"needs-install": "settings.push.state.needsInstall",
	denied: "settings.push.state.denied",
	off: "settings.push.state.off",
	on: "settings.push.state.on",
} as const satisfies Record<PushState, string>;

/** Texto do estado das notificações no idioma da tela (os de `lib/push-client` são só pt-BR). */
export function pushStateText(state: PushState, { t }: Translator = defaultTranslator): string {
	return t(PUSH_STATE_KEYS[state]);
}

/** "agora", "há 30 min", "há 5 h", "há 4 d"; data inválida = "". */
export function lastUsedText(iso: string, now: number = Date.now(), { t }: Translator = defaultTranslator): string {
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return "";
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return t("settings.push.now");
	if (minutes < 60) return t("settings.push.minutesAgo", { n: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return t("settings.push.hoursAgo", { n: hours });
	return t("settings.push.daysAgo", { n: Math.floor(hours / 24) });
}

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
									{[device.id === currentDeviceId ? t("settings.push.thisDevice") : null, lastUsedText(device.lastUsedAt, now, translator) || null, device.failing ? t("settings.push.failing") : null]
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
