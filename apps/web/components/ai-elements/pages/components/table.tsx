import type { PageNode } from "@workspace/shared";
import { cn } from "@workspace/ui/lib/utils";

import { currencyDigits, formatPageValue } from "../page-format";

type TableNode = Extract<PageNode, { type: "table" }>;

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * Tabela com rolagem horizontal no celular: coluna de texto com largura mínima (o nome do cliente não quebra em
 * 3 linhas), número sem quebra, folga à direita da última coluna e a borda do cartão nunca encosta no conteúdo.
 * A moeda de uma coluna usa as mesmas casas para todas as linhas.
 */
export function TableNode({ node }: { node: TableNode }) {
	const { columns, rows, variant = "default" } = node.props;
	const digits = new Map(columns.map((column) => [column.key, currencyDigits(rows.map((row) => (typeof row[column.key] === "number" ? (row[column.key] as number) : null)))]));
	const compact = variant === "compact";
	// Coluna de texto curto (id, data, status) não quebra; a de texto longo (cliente, produto) ganha largura mínima.
	const longText = new Set(columns.filter((column) => rows.some((row) => typeof row[column.key] === "string" && (row[column.key] as string).length > 14)).map((column) => column.key));
	const px = compact ? "px-2.5" : "px-3.5";
	return (
		<div className="max-w-full overflow-x-auto rounded-lg border border-border/60" data-page-node="table" tabIndex={0}>
			<table className="w-full min-w-max border-collapse text-xs">
				<thead className="bg-muted/40">
					<tr>
						{columns.map((column, index) => (
							<th
								className={cn("whitespace-nowrap py-2 font-medium text-muted-foreground", px, index === columns.length - 1 ? "pr-5" : "", ALIGN[column.align ?? "left"])}
								key={column.key}
								scope="col"
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, rowIndex) => (
						<tr className={cn("border-border/60 border-t", variant === "striped" && rowIndex % 2 === 1 ? "bg-muted/30" : "")} key={rowIndex}>
							{columns.map((column, index) => {
								const cell = row[column.key];
								const align = column.align ?? (typeof cell === "number" ? "right" : "left");
								return (
									<td
										className={cn(
											px,
											"align-top",
											compact ? "py-1.5" : "py-2.5",
											index === columns.length - 1 ? "pr-5" : "",
											typeof cell === "number" || !longText.has(column.key) ? "whitespace-nowrap" : "min-w-[8.5rem]",
											typeof cell === "number" ? "tabular-nums" : "",
											ALIGN[align],
										)}
										key={column.key}
									>
										{formatPageValue(cell, { format: column.format, unit: column.unit, digits: digits.get(column.key) })}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
