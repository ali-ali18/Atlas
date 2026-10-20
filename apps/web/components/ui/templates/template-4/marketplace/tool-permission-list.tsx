"use client";

import type { EffectiveAutonomy, McpConnectionView, McpToolInfo } from "@workspace/shared";
import { isReadOnlyMcpTool } from "@workspace/shared";
import { ToolPermissionControl } from "./tool-permission-control";
import { connectionPermission, toolPermission, type ToolPermission } from "./tool-permissions";

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
	return (
		<div className="overflow-hidden rounded-xl border" data-tool-permission-list>
			<div className={`${TOOL_ROW_CLASS} bg-muted/40`} data-tool-row="all">
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">Definir para todas as ferramentas</p>
					<p className="text-xs text-muted-foreground">Vale para todas as tools deste conector.</p>
				</div>
				<ToolPermissionControl
					disabled={disabled}
					name="todas as ferramentas"
					onChange={onAllChange}
					value={connectionPermission(connection, policy)}
				/>
			</div>
			<div className="divide-y border-t">
				{connection.tools.map((tool) => (
					<div className={TOOL_ROW_CLASS} data-tool-row={tool.name} key={tool.name}>
						<button
							aria-label={`Guia da ferramenta ${tool.title || tool.name}`}
							className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							onClick={() => onOpenGuide(tool)}
							type="button"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="break-words text-sm font-medium">{tool.title || tool.name}</span>
								<span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
									{isReadOnlyMcpTool(tool) ? "leitura" : "escreve"}
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
