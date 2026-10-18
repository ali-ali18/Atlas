"use client";

import { useState } from "react";
import type { ProviderStatus, Resolved } from "@workspace/shared";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";
import { Button } from "@workspace/ui/components/button";
import { Switch } from "@workspace/ui/components/switch";
import { LinkIcon, UnplugIcon } from "lucide-react";
import { OpenAIIcon } from "@/components/icons/openai";
import { useChatgptConnection } from "@/hooks/use-chatgpt-connection";
import { useChatgptProvider } from "@/hooks/use-chatgpt-provider";
import type { useAccountSettings } from "@/hooks/use-account-settings";
import type { SaveStatus } from "../account-settings-state";
import {
	type ProvidersViewState,
	canDisconnect,
	chatgptSwitchHint,
	providerConnectionLabel,
	providersViewState,
} from "../providers-state";
import { SaveIndicator, SettingRow, SettingsGroup } from "../setting-row";

export { providerConnectionLabel };

export function ProvidersSettingsView({
	state,
	enabled,
	status,
	busy,
	error,
	notice,
	saveStatus = "idle",
	saveError,
	loadError,
	onToggle,
	onInherit,
	onConnect,
	onDisconnect,
	onReload,
	device = null,
	expired = false,
	onCancelDevice,
	isVisible = () => true,
}: {
	state: ProvidersViewState;
	/** `null` enquanto carrega. */
	enabled: Resolved<boolean> | null;
	status: ProviderStatus | null;
	busy: boolean;
	error?: string | null;
	notice?: string | null;
	saveStatus?: SaveStatus;
	saveError?: string | null;
	loadError?: string | null;
	onToggle: (enabled: boolean) => void;
	/** Voltar a herdar o padrão (remove a escolha do usuário). */
	onInherit: () => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onReload: () => void;
	/** Código de dispositivo em espera (login sem redirect). */
	device?: { userCode: string; verificationUrl: string; expiresAt: string } | null;
	expired?: boolean;
	onCancelDevice?: () => void;
	isVisible?: (itemId: string) => boolean;
}) {
	if (state === "hidden") return null;
	const connectLabel = state === "needs_login" ? "Reconectar ChatGPT" : "Conectar ChatGPT";
	const showConnect = (state === "disconnected" || state === "needs_login") && !device;
	return (
		<SettingsGroup>
			{isVisible("provedores.chatgpt") ? (
				<SettingRow
					caption={
						<>
							{enabled ? (
								<p className="text-xs text-muted-foreground" id="settings-chatgpt-hint">
									{chatgptSwitchHint(enabled)}
								</p>
							) : null}
							{loadError ? (
								<p className="text-xs text-destructive" role="alert">
									{loadError}
								</p>
							) : (
								<SaveIndicator error={saveError} status={saveStatus} />
							)}
						</>
					}
					control="inline"
					description="Uso pessoal: consome a cota do seu plano ChatGPT. Recurso em preview."
					htmlFor="settings-chatgpt-enabled"
					icon={OpenAIIcon}
					label="Usar plano ChatGPT"
				>
					{enabled?.source === "user" ? (
						<Button onClick={onInherit} size="xs" variant="ghost">
							Voltar ao padrão
						</Button>
					) : null}
					<Switch
						aria-describedby="settings-chatgpt-hint"
						checked={enabled?.value ?? false}
						disabled={!enabled}
						id="settings-chatgpt-enabled"
						onCheckedChange={onToggle}
					/>
				</SettingRow>
			) : null}

			{isVisible("provedores.conexao") && state !== "loading" ? (
				<SettingRow
					caption={
						<>
							<p className="text-xs text-muted-foreground">
								{state === "off"
									? "Plano desligado. A conexão e os tokens ficam guardados até você desconectar."
									: providerConnectionLabel(status, error)}
							</p>
							{notice ? (
								<p className="text-xs text-muted-foreground" role="status">
									{notice}
								</p>
							) : null}
							{error ? (
								<p className="text-xs text-destructive" role="alert">
									{error}
								</p>
							) : null}
						</>
					}
					control="inline"
					icon={LinkIcon}
					label="Conexão com o ChatGPT"
				>
					{showConnect ? (
						<Button disabled={busy} onClick={onConnect} size="sm" variant="outline">
							{busy ? "Aguarde…" : connectLabel}
						</Button>
					) : null}
					{error ? (
						<Button disabled={busy} onClick={onReload} size="sm" variant="ghost">
							Tentar novamente
						</Button>
					) : null}
				</SettingRow>
			) : null}

			{device || expired ? (
				<div className="flex flex-col gap-3 px-4 py-3" data-testid="chatgpt-device-step">
					{device ? (
						<>
							<p className="text-sm font-medium">Digite este código no ChatGPT</p>
							<p
								aria-label={`Código ${device.userCode}`}
								className="select-all font-mono text-3xl font-semibold tracking-widest"
							>
								{device.userCode}
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									onClick={() => {
										try {
											void navigator.clipboard?.writeText(device.userCode);
										} catch {
											/* Sem permissão de área de transferência: o código é selecionável. */
										}
									}}
									size="sm"
									variant="outline"
								>
									Copiar código
								</Button>
								<Button
									onClick={() => window.open(device.verificationUrl, "_blank", "noopener,noreferrer")}
									size="sm"
								>
									Abrir página de login
								</Button>
								{onCancelDevice ? (
									<Button onClick={onCancelDevice} size="sm" variant="ghost">
										Cancelar
									</Button>
								) : null}
							</div>
							<p className="text-xs text-muted-foreground" role="status">
								Aguardando confirmação… O código vale por 15 minutos. Continue só se foi você quem
								iniciou este login.
							</p>
						</>
					) : (
						<>
							<p className="text-sm text-muted-foreground" role="status">
								O código expirou.
							</p>
							<div>
								<Button disabled={busy} onClick={onConnect} size="sm" variant="outline">
									Gerar novo código
								</Button>
							</div>
						</>
					)}
				</div>
			) : null}

			{isVisible("provedores.desconectar") && canDisconnect(state, enabled?.source) ? (
				<SettingRow
					control="inline"
					description="Remove a conexão e apaga os tokens salvos. Para só pausar o uso, desligue o plano acima."
					icon={UnplugIcon}
					label="Desconectar da conta"
				>
					<Button disabled={busy} onClick={onDisconnect} size="sm" variant="destructive">
						Desconectar da conta
					</Button>
				</SettingRow>
			) : null}
		</SettingsGroup>
	);
}

export function DisconnectChatgptDialog({
	open,
	busy,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog onOpenChange={onOpenChange} open={open}>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>Desconectar o ChatGPT da conta?</AlertDialogTitle>
					<AlertDialogDescription>
						Os tokens são apagados e deixamos de usar seu plano. Os bots seguirão o fallback
						configurado. Para voltar, será preciso conectar de novo.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancelar</AlertDialogCancel>
					<AlertDialogAction disabled={busy} onClick={onConfirm}>
						Desconectar
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Seção Provedores (só dono): switch do plano, conexão e "Desconectar da conta". */
export function ProvidersSettings({
	account,
	isVisible,
}: {
	account: ReturnType<typeof useAccountSettings>;
	isVisible?: (itemId: string) => boolean;
}) {
	const enabled = account.view?.effective.providers.chatgptEnabled ?? null;
	const isOwner = account.view ? account.view.capabilities.isOwner : null;
	// Plano desligado: a API responde 404; nem consulta (e o status só aparece ligado).
	const provider = useChatgptProvider(undefined, false, enabled?.value === true && isOwner === true);
	const connection = useChatgptConnection();
	const [confirm, setConfirm] = useState(false);
	const error = connection.error ?? provider.error;
	const state = providersViewState({ enabled, isOwner, status: provider.status, error });
	return (
		<>
			<ProvidersSettingsView
				busy={connection.busy}
				enabled={enabled}
				error={error}
				isVisible={isVisible}
				loadError={account.loadError}
				notice={connection.notice}
				onConnect={() => void connection.connect()}
				onDisconnect={() => setConfirm(true)}
				onInherit={() => void account.save({ providers: { chatgptEnabled: null } })}
				onReload={provider.reload}
				device={connection.device}
				expired={connection.expired}
				onCancelDevice={connection.cancel}
				onToggle={(next) => void account.save({ providers: { chatgptEnabled: next } })}
				saveError={account.saveError}
				saveStatus={account.status}
				state={provider.loading && state === "disconnected" ? "loading" : state}
				status={provider.status}
			/>
			<DisconnectChatgptDialog
				busy={connection.busy}
				onConfirm={() => {
					setConfirm(false);
					void connection.disconnect();
				}}
				onOpenChange={setConfirm}
				open={confirm}
			/>
		</>
	);
}
