"use client";

import { useEffect, useState } from "react";
import type { AutonomyView, McpConnectionView, McpToolInfo } from "@workspace/shared";
import { autonomyConnectorKey, isReadOnlyMcpTool } from "@workspace/shared";
import { Alert, AlertDescription } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert";
import { ConnectorGuide } from "./connector-guide";
import { ToolPermissionList } from "./tool-permission-list";
import { DEFAULT_POLICY, hasRiskyAllow, toolPermission, withAllToolsPermission, withToolPermission, type ToolPermission } from "./tool-permissions";
import { mcpToolGuide, ToolGuide } from "./tool-guide";
import {
	deleteMcpConnection,
	getAccountAutonomy,
	updateAccountAutonomy,
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
	const [autonomy, setAutonomy] = useState<AutonomyView | null>(null);
	const policy = autonomy?.effective ?? DEFAULT_POLICY;
	const activeCount = connection.tools.filter((tool) => toolPermission(connection, tool, policy) !== "blocked").length;

	useEffect(() => {
		let cancelled = false;
		getAccountAutonomy()
			.then((view) => { if (!cancelled) setAutonomy(view); })
			.catch(() => { if (!cancelled) setError("Não foi possível carregar as permissões das ferramentas."); });
		return () => { cancelled = true; };
	}, []);

	/** Uma tool ou todas: atualiza na hora e volta ao estado anterior se a API falhar. */
	async function setPermissions({ mode, tool }: { mode: ToolPermission; tool?: McpToolInfo }) {
		if (!autonomy) return;
		const previous = autonomy;
		const previousConnection = connection;
		const stored = previous.stored?.exceptions ?? [];
		const exceptions = tool ? withToolPermission(stored, connection, tool, mode) : withAllToolsPermission(stored, connection, mode);
		// disabledTools ainda vale no runtime: sair de "Bloquear" por aqui tem de reabrir a tool.
		const disabledTools = tool ? connection.disabledTools.filter((name) => name !== tool.name) : [];
		const reopen = disabledTools.length !== connection.disabledTools.length;
		setBusy(true);
		setError(null);
		setAutonomy({ ...previous, stored: { ...(previous.stored ?? { exceptions: [] }), exceptions }, effective: { ...previous.effective, exceptions } });
		if (reopen) onChanged({ ...connection, disabledTools });
		try {
			setAutonomy(await updateAccountAutonomy({ exceptions }));
			if (reopen) onChanged(await updateMcpConnection(connection.id, { disabledTools }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Não foi possível salvar.");
			setAutonomy(previous);
			if (reopen) onChanged(previousConnection);
			getAccountAutonomy().then(setAutonomy).catch(() => undefined);
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
					<>
						<ToolPermissionList
							connection={connection}
							disabled={busy || !autonomy}
							onAllChange={(mode) => void setPermissions({ mode })}
							onOpenGuide={setGuideTool}
							onToolChange={(tool, mode) => void setPermissions({ mode, tool })}
							policy={policy}
						/>
						{hasRiskyAllow(connection, policy) ? (
							<p className="text-xs text-muted-foreground">Há ações que não dá para desfazer (apagar, enviar) em Permitir sempre. O agente vai executá-las sem pedir sua aprovação.</p>
						) : null}
					</>
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
