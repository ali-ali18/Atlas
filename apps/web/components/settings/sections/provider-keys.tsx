"use client";

import { useState } from "react";
import type { ApiKeyProvider, ApiKeyProviderStatus } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { AnthropicIcon, OpencodeIcon } from "@/components/icons/ai-providers";
import { useProviderKeys } from "@/hooks/use-provider-keys";
import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";
import { SettingRow } from "../setting-row";

export type KeyProviderCopy = {
	label: string;
	/** Nota curta sob o rótulo. */
	note: string;
	/** Dica (tooltip) com o que o provedor oferece. */
	hint: string;
	itemId: string;
};

/** Textos de cada provedor de chave no idioma da tela (os nomes de marca não mudam). */
export function keyProviderCopy(provider: ApiKeyProvider, { t }: Translator = defaultTranslator): KeyProviderCopy {
	if (provider === "anthropic") {
		return {
			label: "Anthropic (API)",
			note: t("settings.keys.anthropicNote"),
			hint: t("settings.keys.anthropicHint"),
			itemId: "provedores.anthropic",
		};
	}
	return {
		label: t("settings.keys.opencodeLabel"),
		note: t("settings.keys.opencodeNote"),
		hint: t("settings.keys.opencodeHint"),
		itemId: "provedores.opencode-go",
	};
}

export const KEY_PROVIDER_ITEM_IDS: Record<ApiKeyProvider, string> = {
	anthropic: "provedores.anthropic",
	"opencode-go": "provedores.opencode-go",
};

/** Texto de estado da linha (status, quantidade de modelos ou erro do último teste). */
export function keyProviderCaption(status: ApiKeyProviderStatus | undefined, { t, tn }: Translator = defaultTranslator): string {
	if (!status || status.status === "disconnected") return t("settings.keys.notConnected");
	if (status.status === "error" || status.lastError === "auth_failed") return t("settings.keys.refused");
	const count = status.modelCount;
	return count === null ? t("settings.providers.connected") : tn("settings.keys.connectedWith", count);
}

/** Uma linha: rótulo à esquerda; à direita, colar+conectar ou testar+remover. A chave nunca é exibida. */
export function ProviderKeyRow({
	provider,
	status,
	busy,
	error,
	vaultReady = true,
	onSave,
	onTest,
	onRemove,
}: {
	provider: ApiKeyProvider;
	status?: ApiKeyProviderStatus;
	busy: boolean;
	error?: string | null;
	vaultReady?: boolean;
	onSave: (apiKey: string) => void;
	onTest: () => void;
	onRemove: () => void;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const copy = keyProviderCopy(provider, translator);
	const [value, setValue] = useState("");
	const connected = status?.status === "connected";
	const inputId = `settings-key-${provider}`;
	return (
		<SettingRow
			caption={
				<>
					<p className="text-xs text-muted-foreground" data-testid={`${provider}-status`}>
						{keyProviderCaption(status, translator)}
					</p>
					<p className="text-xs text-muted-foreground">{copy.note}</p>
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
			description={copy.hint}
			htmlFor={connected ? undefined : inputId}
			icon={provider === "anthropic" ? AnthropicIcon : OpencodeIcon}
			label={copy.label}
			wrap={!connected}
		>
			{connected ? (
				<>
					<Button disabled={busy} onClick={onTest} size="sm" variant="outline">
						{busy ? t("settings.providers.wait") : t("settings.keys.test")}
					</Button>
					<Button disabled={busy} onClick={onRemove} size="sm" variant="destructive">
						{t("settings.keys.remove")}
					</Button>
				</>
			) : (
				<form
					className="flex w-full items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						// Mantém o campo se falhar, para não colar de novo; limpa só no sucesso (status muda).
						if (value.trim()) onSave(value.trim());
					}}
				>
					<Input
						aria-label={t("settings.keys.apiKeyAria", { provider: copy.label })}
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
						{busy ? t("settings.keys.testing") : t("settings.keys.connect")}
					</Button>
				</form>
			)}
		</SettingRow>
	);
}

/** Linhas das chaves próprias, para o grupo "Provedores e chaves" (Avançado). */
export function ProviderKeysRows({ isVisible = () => true }: { isVisible?: (itemId: string) => boolean }) {
	const keys = useProviderKeys();
	const providers: ApiKeyProvider[] = ["anthropic", "opencode-go"];
	return (
		<>
			{providers
				.filter((provider) => isVisible(KEY_PROVIDER_ITEM_IDS[provider]))
				.map((provider) => (
					<ProviderKeyRow
						busy={keys.busy === provider}
						error={keys.errors[provider]}
						key={provider}
						onRemove={() => void keys.remove(provider)}
						onSave={(apiKey) => void keys.save(provider, apiKey)}
						onTest={() => void keys.test(provider)}
						provider={provider}
						status={keys.statuses[provider]}
						vaultReady={keys.vaultReady}
					/>
				))}
		</>
	);
}

