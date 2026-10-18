"use client";

import { useState, type FormEvent } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { McpCatalogEntry, McpConnectionView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import { createMcpConnection } from "@/lib/atlas-api";

export function ApiKeyDialog({
	entry,
	newAccount = false,
	onBack,
	onConnected,
}: {
	entry: McpCatalogEntry;
	/** Outra conta do mesmo conector: cria uma conexão nova em vez de reconectar a existente. */
	newAccount?: boolean;
	onBack: () => void;
	onConnected: (connection: McpConnectionView) => void;
}) {
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!key.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const connection = await createMcpConnection({
				catalogId: entry.id,
				apiKey: key.trim(),
				...(newAccount ? { newAccount: true } : {}),
			});
			setKey("");
			onConnected(connection);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível conectar.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="space-y-5" onSubmit={(event) => void submit(event)}>
			<p className="text-sm text-muted-foreground">{entry.description}</p>
			<Field>
				<FieldLabel htmlFor="mcp-api-key">{entry.apiKey?.label ?? "Chave de API"}</FieldLabel>
				<Input
					autoComplete="off"
					id="mcp-api-key"
					onChange={(event) => setKey(event.target.value)}
					required
					type="password"
					value={key}
				/>
			</Field>
			{entry.apiKey?.helpUrl ? (
				<a
					className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
					href={entry.apiKey.helpUrl}
					rel="noopener noreferrer"
					target="_blank"
				>
					Onde consigo? <ExternalLinkIcon className="size-3.5" />
				</a>
			) : null}
			{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
			<div className="flex justify-end gap-2">
				<Button disabled={busy} onClick={onBack} type="button" variant="outline">Voltar</Button>
				<Button disabled={busy || !key.trim()} type="submit">
					{busy ? "Conectando…" : "Conectar"}
				</Button>
			</div>
		</form>
	);
}
