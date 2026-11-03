// Tabela do painel -> o mesmo `Block` de tabela do markdown do chat, para o app desenhar com UM componente
// (`TableCard`: rolagem horizontal, larguras explícitas, barrinha de rolagem). As células entram como texto puro (nunca
// passam pelo parser de markdown: o conteúdo é do spec, dado não confiável).
import type { PageTableColumn, PageTableRow } from "@workspace/shared";
import type { Block } from "./markdown";
import { currencyDigits, formatPageValue } from "./page-format";

export type CellAlign = "left" | "right" | "center";
export type PageTableBlock = { block: Extract<Block, { type: "table" }>; aligns: CellAlign[] };

/** Alinhamento da coluna: o do spec, senão número à direita (pelo primeiro valor presente) e texto à esquerda. */
export function columnAlign(column: PageTableColumn, rows: readonly PageTableRow[]): CellAlign {
	if (column.align) return column.align;
	const first = rows.map((row) => row[column.key]).find((cell) => cell !== null && cell !== undefined);
	return typeof first === "number" ? "right" : "left";
}

/** Tabela grande: acima disto só as primeiras linhas montam; "Ver tudo (n)" mostra o resto (cada linha é uma view). */
export const PAGE_TABLE_PREVIEW_ROWS = 30;

/** Linhas a desenhar: todas se expandido ou se couberem no limite; senão as primeiras `limit`. `hidden` = as que faltam. */
export function visibleRows<T>(rows: readonly T[], expanded: boolean, limit = PAGE_TABLE_PREVIEW_ROWS): { rows: readonly T[]; hidden: number } {
	if (expanded || rows.length <= limit) return { rows, hidden: 0 };
	return { rows: rows.slice(0, limit), hidden: rows.length - limit };
}

export function pageTableBlock(columns: readonly PageTableColumn[], rows: readonly PageTableRow[]): PageTableBlock {
	// A moeda de uma coluna usa as mesmas casas em todas as linhas ("R$ 10,00" e "R$ 7,50", nunca "R$ 10" e "R$ 7,50").
	const digits = new Map(columns.map((column) => [column.key, currencyDigits(rows.map((row) => (typeof row[column.key] === "number" ? (row[column.key] as number) : null)))]));
	const text = (value: string) => [{ type: "text" as const, text: value }];
	return {
		block: {
			type: "table",
			header: columns.map((column) => text(column.label)),
			rows: rows.map((row) => columns.map((column) => text(formatPageValue(row[column.key], { format: column.format, unit: column.unit, digits: digits.get(column.key) })))),
		},
		aligns: columns.map((column) => columnAlign(column, rows)),
	};
}
