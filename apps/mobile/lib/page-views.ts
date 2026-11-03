// O que cada componente do painel MOSTRA, parte pura: textos já formatados, tons, larguras e contagens. Os componentes
// (`components/page/*`) só desenham o que sai daqui, então o conteúdo de cada nó é testável sem React Native.
// Regras de formato iguais às do web (`pages/components/*`); onde o print do dono manda (métricas sem caixa, legenda
// embaixo do número, abas sublinhadas com contagem), vale o print.
import type { PageCalloutTone, PageGap, PageNodePropsMap, PageTone } from "@workspace/shared";
import { calloutTone } from "./page-tone";
import { barPercent, currencyDigits, DELTA_TONE, formatPageDelta, formatPageNumber, formatPageValue } from "./page-format";
import { GAP_PX, statFontSize } from "./page-layout";
import { columnAlign } from "./page-table";

// ---------- Layout ----------

/** Entre seções o painel respira mais (o print do dono tem bastante vão vertical); o resto segue o `gap` do spec. */
export const SECTION_GAP = 32;

/** Espaço entre os filhos de uma pilha: o do spec, ou mais largo quando os filhos são seções. */
export function stackGap(gap: PageGap | undefined, childTypes: readonly string[]): number {
	const base = GAP_PX[gap ?? "md"];
	return childTypes.length > 1 && childTypes.every((type) => type === "section") ? Math.max(base, SECTION_GAP) : base;
}

export type CardLook = { padded: boolean; border: boolean; fill: "card" | "muted" | "none"; tone: PageTone | null };

/** Aparência do cartão: `outlined` (padrão) = borda e fundo do cartão; `filled` = fundo suave; `plain` = sem moldura nem margem. */
export function cardLook(props: PageNodePropsMap["card"]): CardLook {
	const variant = props.variant ?? "outlined";
	return {
		padded: variant !== "plain",
		border: variant === "outlined",
		fill: variant === "outlined" ? "card" : variant === "filled" ? "muted" : "none",
		tone: props.tone && props.tone !== "neutral" ? props.tone : null,
	};
}

// ---------- Métrica (stat) ----------

export const STAT_VALUE_SIZE = { sm: 24, md: 30, lg: 40 } as const;

export type StatView = {
	value: string;
	label: string;
	fontSize: number;
	tone: PageTone | undefined;
	delta: { text: string; tone: PageTone } | null;
	accessibilityLabel: string;
};

/** Métrica sem caixa: o número grande, a legenda cinza embaixo e, se houver, a variação (seta e sinal, além da cor). */
export function statView(props: PageNodePropsMap["stat"]): StatView {
	const { label, value, unit, format, delta, size = "md", tone } = props;
	const value_ = formatPageValue(value, { unit, format });
	const deltaText = delta ? formatPageDelta(delta, { unit, format }) : null;
	return {
		value: value_,
		label,
		fontSize: statFontSize(STAT_VALUE_SIZE[size], value_.length),
		tone,
		delta: delta && deltaText ? { text: deltaText, tone: DELTA_TONE[delta.direction] } : null,
		accessibilityLabel: [label, value_, deltaText].filter(Boolean).join(", "),
	};
}

// ---------- Barras e progresso ----------

export type BarListView = { tone: PageTone; rows: Array<{ label: string; shown: string; percent: number }> };

/** Lista de barras: a mais longa é 100%, números no mesmo formato (moeda com as mesmas casas em todas). */
export function barListView(props: PageNodePropsMap["bar_list"]): BarListView {
	const { items, unit, format, tone = "accent" } = props;
	const max = Math.max(0, ...items.map((item) => item.value));
	const digits = currencyDigits(items.map((item) => item.value));
	return { tone, rows: items.map((item) => ({ label: item.label, shown: item.display ?? formatPageNumber(item.value, { unit, format, digits }), percent: barPercent(item.value, max) })) };
}

export type ProgressView = { label: string; percentText: string; percent: number; detail: string; now: number; max: number; tone: PageTone };

/** Meta atingida: "62%", a barra e "R$ 62.000 de R$ 100.000". */
export function progressView(props: PageNodePropsMap["progress"]): ProgressView {
	const { label, value, max, unit, format, tone = "accent" } = props;
	const digits = currencyDigits([value, max]);
	const base = { unit, format, digits };
	const percent = Math.round((value / max) * 100);
	return { label, percentText: `${Number.isFinite(percent) ? percent : 0}%`, percent: barPercent(value, max), detail: `${formatPageNumber(value, base)} de ${formatPageNumber(max, base)}`, now: Math.min(value, max), max, tone };
}

// ---------- Selo e aviso ----------

export type CalloutIcon = "info" | "success" | "warning" | "critical";
export type CalloutView = { tone: PageTone; icon: CalloutIcon; title: string | undefined; text: string };

/** Aviso: tom pelo tipo (info = destaque, success = positivo…), ícone do tipo, título opcional e o texto do spec. */
export function calloutView(props: PageNodePropsMap["callout"]): CalloutView {
	const kind: PageCalloutTone = props.tone;
	return { tone: calloutTone(kind), icon: kind, title: props.title, text: props.text };
}

// ---------- Tabela ----------

const POSITIVE_WORDS = /^(confirmad[oa]s?|ok|conclu[ií]d[oa]s?|pag[oa]s?|aprovad[oa]s?|atendid[oa]s?|feit[oa]s?|resolvid[oa]s?|ativ[oa]s?|entregue|sim)$/i;
const WARNING_WORDS = /^(parcial|parcialmente|pendente|pendentes|em andamento|em an[aá]lise|aten[cç][aã]o|aguardando|a verificar|incompleto|incompleta)$/i;
const CRITICAL_WORDS = /^(reprovad[oa]s?|falh(ou|a)|erro|atrasad[oa]s?|vencid[oa]s?|cancelad[oa]s?|negad[oa]s?|recusad[oa]s?|cr[ií]tico|cr[ií]tica|n[aã]o|inativ[oa]s?|n[aã]o feit[oa]s?)$/i;

/** Tom de um veredito curto ("Confirmado" verde, "Parcial" âmbar, "Reprovado" vermelho); texto fora do vocabulário = sem tom. */
export function verdictTone(text: string): PageTone | null {
	const value = text.trim();
	if (POSITIVE_WORDS.test(value)) return "positive";
	if (WARNING_WORDS.test(value)) return "warning";
	if (CRITICAL_WORDS.test(value)) return "critical";
	return null;
}

/** Coluna de status: só texto curto, poucos valores distintos e pelo menos um que é veredito conhecido. */
export function isStatusColumn(cells: ReadonlyArray<string | number | null | undefined>): boolean {
	const texts = cells.filter((cell): cell is string => typeof cell === "string" && cell.trim() !== "");
	if (texts.length === 0 || texts.length !== cells.filter((cell) => cell !== null && cell !== undefined && cell !== "").length) return false;
	if (texts.some((text) => text.length > 22) || new Set(texts.map((text) => text.trim().toLowerCase())).size > 6) return false;
	return texts.some((text) => verdictTone(text) !== null);
}

export type TableCellView = { text: string; align: "left" | "right" | "center"; numeric: boolean; tone: PageTone | null };
export type TableColumnView = { key: string; label: string; align: "left" | "right" | "center"; width: number; status: boolean };
export type TableView = { columns: TableColumnView[]; rows: TableCellView[][]; compact: boolean; striped: boolean };

/** Largura mínima de coluna e do texto longo (que quebra linha): o `min-w-[8.5rem]` do web. */
export const TABLE_MIN_WIDTH = 64;
export const TABLE_LONG_WIDTH = 136;
export const TABLE_MAX_WIDTH = 240;
const CHAR_PT = 8;
const CELL_PAD = 28;

/**
 * Larguras das colunas por conteúdo (o RN não mede texto antes de desenhar): número e texto curto não quebram e
 * ganham a largura do maior valor; texto longo (mais de 14 caracteres) cresce até o teto e então quebra de linha.
 */
export function tableColumnWidth(label: string, cells: ReadonlyArray<string>): number {
	const longest = Math.max(label.length, ...cells.map((text) => text.length));
	const natural = Math.ceil(longest * CHAR_PT + CELL_PAD);
	const longText = cells.some((text) => text.length > 14);
	return Math.min(TABLE_MAX_WIDTH, Math.max(longText ? TABLE_LONG_WIDTH : TABLE_MIN_WIDTH, natural));
}

/** Tabela pronta para desenhar: células formatadas, alinhamento, tom de veredito e largura de cada coluna. */
export function tableView(props: PageNodePropsMap["table"]): TableView {
	const { columns, rows, variant = "default" } = props;
	const digits = new Map(columns.map((column) => [column.key, currencyDigits(rows.map((row) => (typeof row[column.key] === "number" ? (row[column.key] as number) : null)))]));
	const status = new Map(columns.map((column) => [column.key, isStatusColumn(rows.map((row) => row[column.key]))]));
	const cells = rows.map((row) =>
		columns.map((column): TableCellView => {
			const raw = row[column.key];
			const text = formatPageValue(raw, { format: column.format, unit: column.unit, digits: digits.get(column.key) });
			const numeric = typeof raw === "number";
			return { text, numeric, align: column.align ?? (numeric ? "right" : "left"), tone: status.get(column.key) && typeof raw === "string" ? verdictTone(raw) : null };
		}),
	);
	return {
		compact: variant === "compact",
		striped: variant === "striped",
		columns: columns.map((column, index) => ({
			key: column.key,
			label: column.label,
			align: columnAlign(column, rows),
			width: tableColumnWidth(column.label, cells.map((row) => row[index]!.text)),
			status: status.get(column.key) === true,
		})),
		rows: cells,
	};
}

/** Altura de cada linha quando a coluna fixa e a rolável medem separado: a maior das duas vence (só cresce, sem laço de layout). */
export function mergeRowHeight(heights: readonly number[], index: number, measured: number): readonly number[] {
	const rounded = Math.ceil(measured);
	if ((heights[index] ?? 0) >= rounded) return heights;
	const next = [...heights];
	for (let i = heights.length; i < index; i += 1) next[i] = 0;
	next[index] = rounded;
	return next;
}

/** A primeira coluna fica fixa quando há mais colunas e a tabela é mais larga que a tela. */
export function pinFirstColumn(widths: readonly number[], viewport: number): boolean {
	return widths.length > 1 && viewport > 0 && widths.reduce((sum, width) => sum + width, 0) > viewport;
}

// ---------- Linha do tempo, kanban, lista ----------

export type TimelineRowView = { date: string; title: string; text?: string; tone: PageTone; last: boolean };
export function timelineView(props: PageNodePropsMap["timeline"]): TimelineRowView[] {
	return props.items.map((item, index) => ({ date: item.date, title: item.title, ...(item.text ? { text: item.text } : {}), tone: item.tone ?? "accent", last: index === props.items.length - 1 }));
}

export type KanbanColumnView = { title: string; count: number; items: PageNodePropsMap["kanban"]["columns"][number]["items"] };
export const kanbanView = (props: PageNodePropsMap["kanban"]): KanbanColumnView[] => props.columns.map((column) => ({ title: column.title, count: column.items.length, items: column.items }));

export type ListRowView = { title: string; subtitle?: string; valueText: string | null; tone: PageTone | null };
export function listView(props: PageNodePropsMap["list"]): ListRowView[] {
	const { items, unit, format } = props;
	const digits = currencyDigits(items.map((item) => (typeof item.value === "number" ? item.value : null)));
	return items.map((item) => ({ title: item.title, ...(item.subtitle ? { subtitle: item.subtitle } : {}), valueText: item.value === undefined ? null : formatPageValue(item.value, { unit, format, digits }), tone: item.tone ?? null }));
}

// ---------- Título ----------

export type HeadingStyle = { size: number; lineHeight: number; uppercase: boolean; muted: boolean };
/** Níveis: 1 = título de bloco, 2 = subtítulo (padrão), 3 = rótulo pequeno em caixa alta e cinza (`h3/h4/h5` do web, em tokens do app). */
export function headingStyle(level: 1 | 2 | 3 | undefined): HeadingStyle {
	if (level === 1) return { size: 22, lineHeight: 28, uppercase: false, muted: false };
	if (level === 3) return { size: 11, lineHeight: 15, uppercase: true, muted: true };
	return { size: 17, lineHeight: 24, uppercase: false, muted: false };
}

/** Seção: título médio (o "Resumo", "Detalhe", "Atenção" do print) e descrição cinza logo abaixo. */
export const SECTION_TITLE = { size: 20, lineHeight: 26 } as const;
