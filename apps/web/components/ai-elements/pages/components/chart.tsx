import type { PageNode } from "@workspace/shared";

import { LazyChart } from "@/components/ai-elements/chart/lazy-chart";

/**
 * Gráfico Bklit (`packages/ui` Chart) na largura toda da coluna. A paleta do painel vem do escopo
 * `data-chart-palette` do `PageView`; um `palette` no próprio spec do gráfico vence a do painel.
 */
export function ChartNode({ node }: { node: Extract<PageNode, { type: "chart" }> }) {
	return (
		<div className="min-w-0" data-page-node="chart">
			<LazyChart className="my-0 w-full pb-1" spec={node.props.spec} />
		</div>
	);
}
