"use client";

import { useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { cn } from "@workspace/ui/lib/utils";
import { useT } from "@/lib/i18n/provider";

/**
 * Campo mascarado + "Salvar" da chave do Composio. Compartilhado entre
 * Configurações e a aba Composio do Marketplace (mesma API, mesmo hook).
 */
export function ComposioKeyForm({
	busy,
	disabled,
	inputId,
	onSave,
	className,
}: {
	busy: boolean;
	/** Cofre indisponível: nada para salvar. */
	disabled: boolean;
	inputId: string;
	onSave: (apiKey: string) => void;
	className?: string;
}) {
	const t = useT();
	const [value, setValue] = useState("");
	return (
		<form
			className={cn("flex w-full items-center gap-2", className)}
			onSubmit={(event) => {
				event.preventDefault();
				// Não limpa o campo: se o salvamento falhar, o usuário não precisa colar de novo.
				if (value.trim()) onSave(value.trim());
			}}
		>
			<Input
				aria-label={t("settings.composio.keyAria")}
				autoComplete="off"
				disabled={busy || disabled}
				id={inputId}
				onChange={(event) => setValue(event.target.value)}
				placeholder={t("settings.composio.paste")}
				spellCheck={false}
				type="password"
				value={value}
			/>
			<Button disabled={busy || disabled || !value.trim()} size="sm" type="submit">
				{busy ? t("settings.composio.saving") : t("settings.composio.save")}
			</Button>
		</form>
	);
}
