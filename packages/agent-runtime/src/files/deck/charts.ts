import type { ChartSpec } from "@workspace/shared";
import type { DeckPalette } from "./themes.js";

/** Rótulos do eixo X: datas ISO viram `MM/AAAA` (todas no dia 1) ou `DD/MM`; o resto fica como veio. */
export function chartLabels(spec: ChartSpec): string[] {
	const raw = spec.data.map((row) => String(row[spec.x] ?? ""));
	const iso = raw.map((v) => /^(\d{4})-(\d{2})-(\d{2})/.exec(v));
	if (raw.length === 0 || iso.some((m) => !m)) return raw;
	const monthly = iso.every((m) => m![3] === "01");
	return iso.map((m) => (monthly ? `${m![2]}/${m![1]}` : `${m![3]}/${m![2]}`));
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Formato numérico do Excel/PowerPoint para valores e rótulos, a partir de `unit`/`format`. */
export function chartNumberFormat(spec: ChartSpec): string {
	const values = spec.series.flatMap((s) => spec.data.map((row) => numeric(row[s.key])));
	const decimals = values.some((v) => !Number.isInteger(v));
	const unit = spec.unit?.trim();
	if (unit === "BRL") return decimals ? '"R$" #,##0.00' : '"R$" #,##0';
	if (unit === "USD") return decimals ? '"US$" #,##0.00' : '"US$" #,##0';
	if (unit === "EUR") return decimals ? '"€" #,##0.00' : '"€" #,##0';
	if (unit === "%" || spec.format === "percent") return decimals ? '0.0"%"' : '0"%"';
	const suffix = unit ? ` "${unit.replace(/"/g, "")}"` : "";
	return `${decimals ? "#,##0.0" : "#,##0"}${suffix}`;
}

/** Cores para `count` itens, repetindo a paleta se faltar. */
export function chartColors(palette: DeckPalette, count: number): string[] {
	return Array.from({ length: Math.max(1, count) }, (_, i) => palette.series[i % palette.series.length]!);
}

/** Dados no formato do `addChart` do pptxgenjs: uma entrada por série. */
export function chartSeriesData(spec: ChartSpec): Array<{ name: string; labels: string[]; values: number[] }> {
	const labels = chartLabels(spec);
	const series = spec.type === "pie" ? spec.series.slice(0, 1) : spec.series;
	return series.map((s) => ({ name: s.label || s.key, labels, values: spec.data.map((row) => numeric(row[s.key])) }));
}
