"use client";

import { useCallback, useEffect, useState } from "react";
import { MailIcon } from "lucide-react";
import type { EmailAccountStatus } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { AtlasApiError, getEmailAccount, removeEmailAccountKey, saveEmailAccountKey } from "@/lib/atlas-api";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { SettingRow } from "../setting-row";
import { EmailDomainsConnected } from "./email-domains";

/** Texto de estado da linha; a chave nunca é exibida. */
export function emailKeyCaption(status: EmailAccountStatus | null, { t }: Translator = defaultTranslator): string {
	if (!status || !status.configured) return t("settings.keys.notConnected");
	return status.source === "server" ? t("settings.email.connectedServer") : t("settings.email.connected");
}

/** Uma linha: colar+conectar, ou remover. A chave só vai no PUT e nunca volta. */
export function EmailKeyRow({
	status,
	busy,
	error,
	vaultReady = true,
	onSave,
	onRemove,
}: {
	status: EmailAccountStatus | null;
	busy: boolean;
	error?: string | null;
	vaultReady?: boolean;
	onSave: (apiKey: string) => void;
	onRemove: () => void;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const [value, setValue] = useState("");
	// Chave do servidor (env) não se remove por aqui: só a guardada na conta.
	const removable = status?.configured === true && status.source === "account";
	const connected = status?.configured === true;
	const inputId = "settings-key-openmail";
	return (
		<SettingRow
			caption={
				<>
					<p className="text-xs text-muted-foreground" data-testid="openmail-status">
						{emailKeyCaption(status, translator)}
					</p>
					<p className="text-xs text-muted-foreground">{t("settings.email.note")}</p>
					{!vaultReady ? (
						<p className="text-xs text-destructive" role="alert">
							{t("settings.keys.vaultMissing")}
						</p>
					) : null}
					{error ? (
						<p className="text-xs text-destructive" role="alert">
							{error}
						</p>
					) : null}
				</>
			}
			control={connected ? "inline" : "field"}
			description={t("settings.email.hint")}
			htmlFor={connected ? undefined : inputId}
			icon={MailIcon}
			label={t("settings.email.label")}
			wrap={!connected}
		>
			{connected ? (
				removable ? (
					<Button disabled={busy} onClick={onRemove} size="sm" variant="destructive">
						{t("settings.keys.remove")}
					</Button>
				) : null
			) : (
				<form
					className="flex w-full items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (value.trim()) onSave(value.trim());
					}}
				>
					<Input
						aria-label={t("settings.email.apiKeyAria")}
						autoComplete="off"
						disabled={busy || !vaultReady}
						id={inputId}
						onChange={(event) => setValue(event.target.value)}
						placeholder={t("settings.keys.paste")}
						spellCheck={false}
						type="password"
						value={value}
					/>
					<Button disabled={busy || !vaultReady || !value.trim()} size="sm" type="submit">
						{busy ? t("settings.email.saving") : t("settings.keys.connect")}
					</Button>
				</form>
			)}
		</SettingRow>
	);
}

/** Linha da chave do OpenMail, para o grupo "Provedores e chaves". */
export function EmailKeyRowConnected() {
	const t = useT();
	const [status, setStatus] = useState<EmailAccountStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		void getEmailAccount(controller.signal).then(setStatus, () => undefined);
		return () => controller.abort();
	}, []);

	const run = useCallback(async (action: () => Promise<EmailAccountStatus>, fallback: string) => {
		setBusy(true);
		setError(null);
		try {
			setStatus(await action());
		} catch (cause) {
			setError(cause instanceof AtlasApiError && cause.message ? cause.message : fallback);
		} finally {
			setBusy(false);
		}
	}, []);

	return (
		<>
			<EmailKeyRow
				busy={busy}
				error={error}
				onRemove={() => void run(removeEmailAccountKey, t("settings.email.removeError"))}
				onSave={(apiKey) => void run(() => saveEmailAccountKey(apiKey), t("settings.email.saveError"))}
				status={status}
				vaultReady={status?.vaultReady ?? true}
			/>
			<EmailDomainsConnected enabled={status?.configured === true} />
		</>
	);
}
