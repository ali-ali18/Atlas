"use client";

import { BellIcon, BellRingIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import type { PushDevice } from "@/lib/atlas-api";
import { PUSH_STATE_TEXT, lastUsedLabel, type PushState } from "@/lib/push-client";
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
	const on = state === "on";
	const blocked = BLOCKED.includes(state);
	return (
		<SettingsGroup title="Notificações no celular">
			{isVisible("notificacoes.celular") ? (
				<SettingRow
					caption={
						<>
							<p data-slot="push-state">{PUSH_STATE_TEXT[state]}</p>
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
					label="Notificações no celular"
				>
					<Button disabled={busy || blocked} onClick={on ? onDisable : onEnable} size="sm" variant={on ? "outline" : "default"}>
						{on ? "Desativar" : "Ativar"}
					</Button>
				</SettingRow>
			) : null}
			{isVisible("notificacoes.celular") && on ? (
				<SettingRow control="inline" description="Envia uma notificação para os seus aparelhos." icon={BellRingIcon} label="Testar">
					<Button disabled={busy} onClick={onTest} size="sm" variant="outline">
						Testar
					</Button>
				</SettingRow>
			) : null}
			{isVisible("notificacoes.aparelhos") ? (
				devices.length === 0 ? (
					<SettingRow caption={<p>Nenhum aparelho ativado ainda.</p>} icon={SmartphoneIcon} label="Aparelhos" />
				) : (
					devices.map((device) => (
						<SettingRow
							caption={
								<p data-slot="push-device-meta">
									{[device.id === currentDeviceId ? "Este aparelho" : null, lastUsedLabel(device.lastUsedAt, now) || null, device.failing ? "com falhas" : null]
										.filter(Boolean)
										.join(" · ")}
								</p>
							}
							control="inline"
							icon={SmartphoneIcon}
							key={device.id}
							label={device.label}
						>
							<Button aria-label={`Remover ${device.label}`} disabled={busy} onClick={() => onRemove(device.id)} size="icon-sm" variant="ghost">
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
