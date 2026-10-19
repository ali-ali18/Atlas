"use client";

import { useCallback, useEffect, useState } from "react";
import { MailIcon } from "lucide-react";
import type { EmailAccountStatus } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { AtlasApiError, getEmailAccount, removeEmailAccountKey, saveEmailAccountKey } from "@/lib/atlas-api";
import { SettingRow } from "../setting-row";

export const EMAIL_KEY_HINT = "Chave da sua conta no OpenMail (openmail.sh). Com ela cada bot pode ter um endereço de e-mail próprio.";

/** Texto de estado da linha; a chave nunca é exibida. */
export function emailKeyCaption(status: EmailAccountStatus | null): string {
	if (!status || !status.configured) return "Não conectado";
	return status.source === "server" ? "Conectado · chave do servidor" : "Conectado";
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
						{emailKeyCaption(status)}
					</p>
					<p className="text-xs text-muted-foreground">Endereço de e-mail para os bots (OpenMail).</p>
					{!vaultReady ? (
						<p className="text-xs text-destructive" role="alert">
							Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker para guardar a chave.
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
			description={EMAIL_KEY_HINT}
			htmlFor={connected ? undefined : inputId}
			icon={MailIcon}
			label="E-mail dos bots"
			wrap={!connected}
		>
			{connected ? (
				removable ? (
					<Button disabled={busy} onClick={onRemove} size="sm" variant="destructive">
						Remover
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
						aria-label="Chave de API: OpenMail"
						autoComplete="off"
						disabled={busy || !vaultReady}
						id={inputId}
						onChange={(event) => setValue(event.target.value)}
						placeholder="Cole a chave"
						spellCheck={false}
						type="password"
						value={value}
					/>
					<Button disabled={busy || !vaultReady || !value.trim()} size="sm" type="submit">
						{busy ? "Salvando…" : "Conectar"}
					</Button>
				</form>
			)}
		</SettingRow>
	);
}

/** Linha da chave do OpenMail, para o grupo "Provedores e chaves". */
export function EmailKeyRowConnected() {
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
		<EmailKeyRow
			busy={busy}
			error={error}
			onRemove={() => void run(removeEmailAccountKey, "Não foi possível remover a chave.")}
			onSave={(apiKey) => void run(() => saveEmailAccountKey(apiKey), "Não foi possível guardar a chave. Tente novamente.")}
			status={status}
			vaultReady={status?.vaultReady ?? true}
		/>
	);
}
