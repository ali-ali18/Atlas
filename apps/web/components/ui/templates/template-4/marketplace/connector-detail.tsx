"use client";

import { useState } from "react";
import type { McpConnectionView, McpToolInfo } from "@workspace/shared";
import { autonomyConnectorKey, isReadOnlyMcpTool } from "@workspace/shared";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert";
import { Switch } from "@workspace/ui/components/switch";
import { ConnectorGuide } from "./connector-guide";
import { mcpToolGuide, ToolGuide } from "./tool-guide";
import {
	deleteMcpConnection,
	refreshMcpConnection,
	updateMcpConnection,
} from "@/lib/atlas-api";

export function ConnectorDetail({
	connection,
	onChanged,
	onDeleted,
	onManageAutonomy,
	hideDisconnect = false,
}: {
	connection: McpConnectionView;
	/** A seção "Contas" da página já desconecta cada conta. */
	hideDisconnect?: boolean;
	onChanged: (connection: McpConnectionView) => void;
	onDeleted: (id: string) => void;
	/** Abre Autonomia já filtrada neste conector. */
	onManageAutonomy?: (connector: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [guideTool, setGuideTool] = useState<McpToolInfo | null>(null);
	const activeCount = connection.tools.length - connection.disabledTools.length;

	async function change(patch: { disabledTools?: string[] }) {
		setBusy(true);
		setError(null);
		try {
			onChanged(await updateMcpConnection(connection.id, patch));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível salvar.");
		} finally {
			setBusy(false);
		}
	}

	async function refresh() {
		setBusy(true);
		setError(null);
		try {
			onChanged(await refreshMcpConnection(connection.id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível atualizar as tools.");
		} finally {
			setBusy(false);
		}
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		try {
			await deleteMcpConnection(connection.id);
			onDeleted(connection.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível desconectar.");
			setBusy(false);
			setConfirmDelete(false);
		}
	}

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="text-sm font-medium">{connection.name}</p>
					<p className="text-xs text-muted-foreground">
						{connection.status === "connected" ? "Conectado" : connection.status === "error" ? "Erro na conexão" : "Desconectado"}
						{" · "}{activeCount} de {connection.tools.length} tools ativas
					</p>
				</div>
				<Button disabled={busy} onClick={() => void refresh()} size="sm" variant="outline">
					{busy ? "Atualizando…" : "Atualizar tools"}
				</Button>
			</div>
			{connection.lastError ? (
				<Alert variant="destructive"><AlertDescription>{connection.lastError}</AlertDescription></Alert>
			) : null}
			{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
			<div className="flex items-center justify-between gap-3 rounded-xl border p-3">
				<div className="min-w-0">
					<p className="text-sm font-medium">Quando o agente pede sua aprovação</p>
					<p className="text-xs text-muted-foreground">Nível, validade e exceções deste conector ficam em Autonomia.</p>
				</div>
				<Button
					disabled={!onManageAutonomy}
					onClick={() => onManageAutonomy?.(autonomyConnectorKey(connection))}
					size="sm"
					type="button"
					variant="outline"
				>
					Gerenciar em Autonomia
				</Button>
			</div>
			<section className="space-y-2">
				<h3 className="text-sm font-medium">Tools</h3>
				{connection.tools.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nenhuma tool encontrada neste servidor.</p>
				) : (
					<div className="max-h-64 divide-y overflow-y-auto rounded-xl border">
						{connection.tools.map((tool) => {
							const enabled = !connection.disabledTools.includes(tool.name);
							return (
								<div className="flex items-start justify-between gap-3 p-3" key={tool.name}>
									<button
										aria-label={`Guia da ferramenta ${tool.title || tool.name}`}
										className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										onClick={() => setGuideTool(tool)}
										type="button"
									>
										<div className="flex flex-wrap items-center gap-2">
											<span className="break-all text-sm font-medium">{tool.title || tool.name}</span>
											<span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
												{isReadOnlyMcpTool(tool) ? "leitura" : "escreve"}
											</span>
										</div>
										{tool.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p> : null}
									</button>
									<Switch
										aria-label={`${enabled ? "Desligar" : "Ligar"} ${tool.name}`}
										checked={enabled}
										disabled={busy}
										onCheckedChange={(checked) => {
											const disabledTools = checked
												? connection.disabledTools.filter((name) => name !== tool.name)
												: [...connection.disabledTools, tool.name];
											void change({ disabledTools });
										}}
									/>
								</div>
							);
						})}
					</div>
				)}
			</section>
			{connection.status === "connected" ? <ConnectorGuide connectionId={connection.id} guide={connection.guide} kind="mcp" /> : null}
			<ToolGuide guide={guideTool ? mcpToolGuide(guideTool) : null} onClose={() => setGuideTool(null)} />
			{confirmDelete ? (
				<ConfirmAlert
					cancelLabel="Manter conexão"
					confirmLabel="Desconectar"
					description={`As tools de ${connection.name} deixarão de aparecer nos próximos runs.`}
					disabled={busy}
					onCancel={() => setConfirmDelete(false)}
					onConfirm={() => void disconnect()}
					title="Desconectar este servidor?"
				/>
			) : null}
			<div className="flex justify-end gap-2">
				{!confirmDelete && !hideDisconnect ? (
					<Button disabled={busy} onClick={() => setConfirmDelete(true)} type="button" variant="destructive">Desconectar</Button>
				) : null}
			</div>
		</div>
	);
}
