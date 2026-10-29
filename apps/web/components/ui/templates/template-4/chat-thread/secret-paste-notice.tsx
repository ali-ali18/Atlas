"use client";

import { KeyRoundIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";

/**
 * Aviso discreto acima do campo de mensagem quando o texto parece conter uma senha/chave.
 * "Guardar no cofre" troca o valor por um marcador {{secret:nome}} antes de enviar.
 */
export function SecretPasteNotice({
	count,
	busy,
	error,
	attention,
	onSave,
	onSendAnyway,
}: {
	count: number;
	busy?: boolean;
	error?: string | null;
	/** O envio foi barrado pelo aviso: destaca. */
	attention?: boolean;
	onSave: () => void;
	onSendAnyway: () => void;
}) {
	return (
		<div
			aria-live="polite"
			className={cn(
				"mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl px-3 py-2 text-xs",
				attention ? "bg-warning/10" : "bg-muted/60",
			)}
			data-secret-paste-notice
			role="status"
		>
			<KeyRoundIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1 basis-40 text-foreground">
				{count > 1 ? "Isso parece conter senhas/chaves." : "Isso parece uma senha/chave."}
				<span className="text-muted-foreground"> O bot não precisa ver o valor: guarde no cofre e eu uso por referência.</span>
			</span>
			<span className="flex shrink-0 items-center gap-1">
				<Button disabled={busy} onClick={onSave} size="sm" type="button">
					{busy ? "Guardando…" : "Guardar no cofre"}
				</Button>
				<Button disabled={busy} onClick={onSendAnyway} size="sm" type="button" variant="ghost">
					Enviar mesmo assim
				</Button>
			</span>
			{error ? (
				<p className="m-0 basis-full text-destructive" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
