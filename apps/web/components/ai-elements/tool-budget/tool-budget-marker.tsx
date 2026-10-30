import { TrendingUpIcon } from "lucide-react";

import {
	Marker,
	MarkerContent,
	MarkerIcon,
} from "@workspace/ui/components/marker";
import { useT } from "@/lib/i18n/provider";

/** Nome do conector a partir do nome exposto (`mcp__github__tool` -> `github`). */
function connectorFromTool(tool: string): string | undefined {
	const slug = tool.split("__")[1];
	return slug ? slug.replace(/_/g, " ") : undefined;
}

/** Aviso discreto: o limite de leituras de um conector cresceu durante o run. */
export function ToolBudgetMarker({
	tool,
	connectorName,
	to,
}: {
	tool: string;
	connectorName?: string;
	to: number;
}) {
	const t = useT();
	const connector = connectorName ?? connectorFromTool(tool);
	return (
		<Marker variant="separator" className="my-1">
			<MarkerIcon>
				<TrendingUpIcon />
			</MarkerIcon>
			<MarkerContent>
				{connector ? t("aiElements.toolBudget.connector", { connector, to }) : t("aiElements.toolBudget.generic", { to })}
			</MarkerContent>
		</Marker>
	);
}
