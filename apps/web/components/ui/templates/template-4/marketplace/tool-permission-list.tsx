"use client";

import type { EffectiveAutonomy, McpConnectionView, McpToolInfo } from "@workspace/shared";
import { useTranslations } from "@/lib/i18n/provider";
import { ToolPermissionControl } from "./tool-permission-control";
import { connectionPermission, toolIsRead, toolPermission, type ToolPermission } from "./tool-permissions";

/** Linha: texto à esquerda (cresce), controle de largura fixa à direita, centralizado na vertical. */
export const TOOL_ROW_CLASS = "flex items-center justify-between gap-3 p-3";

export function ToolPermissionList({
	connection,
	policy,
	disabled,
	onToolChange,
	onAllChange,
	onOpenGuide,
}: {
	connection: McpConnectionView;
	policy: EffectiveAutonomy;
	disabled?: boolean;
	onToolChange: (tool: McpToolInfo, mode: ToolPermission) => void;
	onAllChange: (mode: ToolPermission) => void;
	onOpenGuide: (tool: McpToolInfo) => void;
}) {
	const { t } = useTranslations();
	return (
		<div className="overflow-hidden rounded-xl border" data-tool-permission-list>
			<div className={`${TOOL_ROW_CLASS} bg-muted/40`} data-tool-row="all">
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">{t("marketplace.perm.setAll")}</p>
					<p className="text-xs text-muted-foreground">{t("marketplace.perm.setAllHint")}</p>
				</div>
				<ToolPermissionControl
					disabled={disabled}
					name={t("marketplace.perm.allTools")}
					onChange={onAllChange}
					value={connectionPermission(connection, policy)}
				/>
			</div>
			<div className="divide-y border-t">
				{connection.tools.map((tool) => (
					<div className={TOOL_ROW_CLASS} data-tool-row={tool.name} key={tool.name}>
						<button
							aria-label={t("marketplace.perm.guideOf", { name: tool.title || tool.name })}
							className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							onClick={() => onOpenGuide(tool)}
							type="button"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="break-words text-sm font-medium">{tool.title || tool.name}</span>
								<span className="rounded-md bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
									{toolIsRead(connection, tool) ? t("marketplace.perm.read") : t("marketplace.perm.writes")}
								</span>
							</div>
							{tool.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p> : null}
						</button>
						<ToolPermissionControl
							disabled={disabled}
							name={tool.title || tool.name}
							onChange={(mode) => onToolChange(tool, mode)}
							value={toolPermission(connection, tool, policy)}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
