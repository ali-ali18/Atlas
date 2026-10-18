"use client";

import { useState, type FormEvent } from "react";
import type { McpConnectionView } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import { Switch } from "@workspace/ui/components/switch";
import { createMcpConnection } from "@/lib/atlas-api";
import type { CustomMcpDraft } from "@/lib/open-marketplace";
import { CustomMcpIcon, customMcpHost } from "@/components/ai-elements/connectors/custom-mcp-icon";

export function CustomConnectorForm({
	initial,
	busy: oauthBusy,
	onBack,
	onConnected,
	onOAuth,
}: {
	/** Pré-preenchimento vindo de um card no chat. */
	initial?: CustomMcpDraft;
	busy: boolean;
	onBack: () => void;
	onConnected: (connection: McpConnectionView) => void;
	/** Login OAuth: o Marketplace abre o popup e cuida do resultado. */
	onOAuth: (custom: { name: string; url: string }) => void;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [url, setUrl] = useState(initial?.url ?? "");
	const [useOAuth, setUseOAuth] = useState(initial?.auth === "oauth");
	const [headerName, setHeaderName] = useState("");
	const [headerValue, setHeaderValue] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busy = submitting || oauthBusy;

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		if (useOAuth) {
			// Síncrono no clique: o popup precisa abrir antes de qualquer await.
			onOAuth({ name: name.trim(), url: url.trim() });
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const connection = await createMcpConnection({
				custom: {
					name: name.trim(),
					url: url.trim(),
					...(headerName.trim() ? { headerName: headerName.trim() } : {}),
					...(headerValue ? { headerValue } : {}),
				},
			});
			setHeaderValue("");
			onConnected(connection);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível conectar.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form className="space-y-4" onSubmit={(event) => void submit(event)}>
			<p className="text-sm text-muted-foreground">
				Informe a URL de um servidor MCP remoto. HTTP é aceito apenas em localhost.
			</p>
			{initial?.name ? (
				<div className="flex items-center gap-3 rounded-xl border bg-muted/20 p-3 text-sm">
					<span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-background">
						<CustomMcpIcon className="size-6" name={name || initial.name} url={url} />
					</span>
					<p className="min-w-0 text-muted-foreground">
						Conectar <span className="font-medium text-foreground">{initial.name}</span>
						{customMcpHost(initial.url) ? <> em <span className="font-mono text-xs">{customMcpHost(initial.url)}</span></> : null}. Confira os dados e confirme.
					</p>
				</div>
			) : null}
			<Field>
				<FieldLabel htmlFor="mcp-custom-name">Nome</FieldLabel>
				<Input id="mcp-custom-name" maxLength={60} onChange={(event) => setName(event.target.value)} required value={name} />
			</Field>
			<Field>
				<FieldLabel htmlFor="mcp-custom-url">URL do servidor</FieldLabel>
				<Input id="mcp-custom-url" onChange={(event) => setUrl(event.target.value)} placeholder="https://exemplo.com/mcp" required type="url" value={url} />
			</Field>
			<div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/20 p-4">
				<div className="min-w-0">
					<p className="text-sm font-medium">Entrar com OAuth</p>
					<p className="text-xs text-muted-foreground">Abre a tela de login do serviço. Use quando o servidor pede conta em vez de chave.</p>
				</div>
				<Switch aria-label="Entrar com OAuth" checked={useOAuth} disabled={busy} onCheckedChange={setUseOAuth} />
			</div>
			{useOAuth ? null : (
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="mcp-header-name">Nome do header (opcional)</FieldLabel>
						<Input id="mcp-header-name" onChange={(event) => setHeaderName(event.target.value)} placeholder="Authorization" value={headerName} />
					</Field>
					<Field>
						<FieldLabel htmlFor="mcp-header-value">Valor do header</FieldLabel>
						<Input autoComplete="off" id="mcp-header-value" onChange={(event) => setHeaderValue(event.target.value)} type="password" value={headerValue} />
					</Field>
				</div>
			)}
			{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
			<div className="flex justify-end gap-2">
				<Button disabled={busy} onClick={onBack} type="button" variant="outline">Voltar</Button>
				<Button disabled={busy || !name.trim() || !url.trim()} type="submit">
					{busy ? "Conectando…" : useOAuth ? "Entrar e conectar" : "Conectar"}
				</Button>
			</div>
		</form>
	);
}
