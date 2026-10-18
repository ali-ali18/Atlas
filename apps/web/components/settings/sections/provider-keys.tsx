"use client";

import { useState } from "react";
import type { ApiKeyProvider, ApiKeyProviderStatus } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { AnthropicIcon, OpencodeIcon } from "@/components/icons/ai-providers";
import { useProviderKeys } from "@/hooks/use-provider-keys";
import { SettingRow } from "../setting-row";

export type KeyProviderCopy = {
	label: string;
	/** Nota curta sob o rótulo. */
	note: string;
	/** Dica (tooltip) com o que o provedor oferece. */
	hint: string;
	itemId: string;
};

export const KEY_PROVIDER_COPY: Record<ApiKeyProvider, KeyProviderCopy> = {
	anthropic: {
		label: "Anthropic (API)",
		note: "Chave da sua conta da API da Anthropic (console.anthropic.com).",
		hint: "Usa a API da Anthropic diretamente, cobrando na sua conta. Os modelos aparecem nos seletores de modelo.",
		itemId: "provedores.anthropic",
	},
	"opencode-go": {
		label: "OpenCode Go",
		note: "Assinatura do OpenCode Go: modelos com limite de uso por janela.",
		hint: "Cole a chave do console do OpenCode. Ao atingir o limite, o bot segue com o modelo padrão.",
		itemId: "provedores.opencode-go",
	},
};

/** Texto de estado da linha (status, quantidade de modelos ou erro do último teste). */
export function keyProviderCaption(status: ApiKeyProviderStatus | undefined): string {
	if (!status || status.status === "disconnected") return "Não conectado";
	if (status.status === "error" || status.lastError === "auth_failed") return "Chave recusada. Cole uma nova chave.";
	const count = status.modelCount;
	return count === null ? "Conectado" : `Conectado · ${count} ${count === 1 ? "modelo" : "modelos"}`;
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
	const copy = KEY_PROVIDER_COPY[provider];
	const [value, setValue] = useState("");
	const connected = status?.status === "connected";
	const inputId = `settings-key-${provider}`;
	return (
		<SettingRow
			caption={
				<>
					<p className="text-xs text-muted-foreground" data-testid={`${provider}-status`}>
						{keyProviderCaption(status)}
					</p>
					<p className="text-xs text-muted-foreground">{copy.note}</p>
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
			description={copy.hint}
			htmlFor={connected ? undefined : inputId}
			icon={provider === "anthropic" ? AnthropicIcon : OpencodeIcon}
			label={copy.label}
			wrap={!connected}
		>
			{connected ? (
				<>
					<Button disabled={busy} onClick={onTest} size="sm" variant="outline">
						{busy ? "Aguarde…" : "Testar conexão"}
					</Button>
					<Button disabled={busy} onClick={onRemove} size="sm" variant="destructive">
						Remover
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
						aria-label={`Chave de API: ${copy.label}`}
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
						{busy ? "Testando…" : "Conectar"}
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
				.filter((provider) => isVisible(KEY_PROVIDER_COPY[provider].itemId))
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

