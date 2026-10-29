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
import { useTranslations } from "@/lib/i18n/provider";

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
	const translator = useTranslations();
	const { t } = translator;
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
			.catch(() => { if (!cancelled) setError(t("marketplace.detail.loadPermissionsError")); });
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
			setError(cause instanceof Error ? cause.message : t("marketplace.detail.saveError"));
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
			setError(cause instanceof Error ? cause.message : t("marketplace.detail.refreshError"));
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
			setError(cause instanceof Error ? cause.message : t("marketplace.detail.disconnectError"));
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
						{connection.status === "connected" ? t("marketplace.detail.connected") : connection.status === "error" ? t("marketplace.detail.connectionError") : t("marketplace.detail.disconnected")}
						{" · "}{t("marketplace.detail.toolsActive", { active: activeCount, total: connection.tools.length })}
					</p>
				</div>
				<Button disabled={busy} onClick={() => void refresh()} size="sm" variant="outline">
					{busy ? t("marketplace.detail.refreshing") : t("marketplace.detail.refresh")}
				</Button>
			</div>
			{connection.lastError ? (
				<Alert variant="destructive"><AlertDescription>{connection.lastError}</AlertDescription></Alert>
			) : null}
			{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
			<div className="flex items-center justify-between gap-3 rounded-xl border p-3">
				<div className="min-w-0">
					<p className="text-sm font-medium">{t("marketplace.detail.approvalTitle")}</p>
					<p className="text-xs text-muted-foreground">{t("marketplace.detail.approvalText")}</p>
				</div>
				<Button
					disabled={!onManageAutonomy}
					onClick={() => onManageAutonomy?.(autonomyConnectorKey(connection))}
					size="sm"
					type="button"
					variant="outline"
				>
					{t("marketplace.detail.manageAutonomy")}
				</Button>
			</div>
			<section className="space-y-2">
				<h3 className="text-sm font-medium">{t("marketplace.detail.tools")}</h3>
				{connection.tools.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("marketplace.detail.noTools")}</p>
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
							<p className="text-xs text-muted-foreground">{t("marketplace.detail.riskyAllow")}</p>
						) : null}
					</>
				)}
			</section>
			{connection.status === "connected" ? <ConnectorGuide connectionId={connection.id} guide={connection.guide} kind="mcp" /> : null}
			<ToolGuide guide={guideTool ? mcpToolGuide(guideTool, translator) : null} onClose={() => setGuideTool(null)} />
			{confirmDelete ? (
				<ConfirmAlert
					cancelLabel={t("marketplace.detail.keepConnection")}
					confirmLabel={t("marketplace.detail.disconnect")}
					description={t("marketplace.detail.disconnectDescription", { name: connection.name })}
					disabled={busy}
					onCancel={() => setConfirmDelete(false)}
					onConfirm={() => void disconnect()}
					title={t("marketplace.detail.disconnectTitle")}
				/>
			) : null}
			<div className="flex justify-end gap-2">
				{!confirmDelete && !hideDisconnect ? (
					<Button disabled={busy} onClick={() => setConfirmDelete(true)} type="button" variant="destructive">{t("marketplace.detail.disconnect")}</Button>
				) : null}
			</div>
		</div>
	);
}
