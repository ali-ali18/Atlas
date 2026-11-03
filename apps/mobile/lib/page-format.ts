// Formatação dos valores do painel, parte pura (porta do `page-format.ts` do web, só pt-BR). Sem `Intl`: o Hermes nem
// sempre traz `notation: "compact"` nem moeda, e o resultado mudaria de aparelho para aparelho. Aqui o número sai igual
// em todo lugar: 1.234,56 · R$ 1.234 · 1,2 mil · 1,5 mi · 8%. O `Intl` do web (pt-BR) é a referência dos casos testados.
import type { ChartSpec, PageFormat, PageStatDelta } from "@workspace/shared";

const CURRENCY_SYMBOL: Record<string, string> = { BRL: "R$", USD: "US$", EUR: "€" };
const EMPTY = "—";

/** Casas decimais de uma moeda para um CONJUNTO de valores: reais inteiros se todos forem inteiros, senão centavos. */
export function currencyDigits(values: ReadonlyArray<number | null | undefined>): 0 | 2 {
	return values.every((value) => typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value)) ? 0 : 2;
}

/** `1234.5` -> "1.234,5": arredonda em `max` casas, mantém ao menos `min`, agrupa milhares com ponto. */
export function formatDecimal(value: number, min: number, max: number): string {
	if (!Number.isFinite(value)) return EMPTY;
	// `toFixed` vira notação científica a partir de 1e21: nesse extremo o número vai como veio.
	if (Math.abs(value) >= 1e21) return String(value);
	const fixed = Math.abs(value).toFixed(max);
	const [whole = "0", fraction = ""] = fixed.split(".");
	let kept = fraction;
	while (kept.length > min && kept.endsWith("0")) kept = kept.slice(0, -1);
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	const body = kept ? `${grouped},${kept}` : grouped;
	// "-0" e "-0,00" (arredondou para zero) não levam sinal.
	return value < 0 && /[1-9]/.test(body) ? `-${body}` : body;
}

const COMPACT_STEPS: ReadonlyArray<{ div: number; suffix: string }> = [
	{ div: 1e12, suffix: "tri" },
	{ div: 1e9, suffix: "bi" },
	{ div: 1e6, suffix: "mi" },
	{ div: 1e3, suffix: "mil" },
];

/** `1234` -> "1,2 mil", `1_500_000` -> "1,5 mi", `999_960` -> "1 mi" (o arredondamento sobe de faixa). */
export function formatCompact(value: number): string {
	if (!Number.isFinite(value)) return EMPTY;
	const abs = Math.abs(value);
	for (const [index, step] of COMPACT_STEPS.entries()) {
		if (abs < step.div) continue;
		const scaled = Math.round((abs / step.div) * 10) / 10;
		const up = COMPACT_STEPS[index - 1];
		if (scaled >= 1000 && up) return `${value < 0 ? "-" : ""}${formatDecimal(abs / up.div, 0, 1)} ${up.suffix}`;
		return `${value < 0 ? "-" : ""}${formatDecimal(scaled, 0, 1)} ${step.suffix}`;
	}
	return formatDecimal(value, 0, 1);
}

export type PageNumberOptions = { unit?: string; format?: PageFormat; digits?: 0 | 2 };

/**
 * Texto de um número com `format` e `unit` (moeda BRL/USD/EUR, "%" ou sufixo livre). Moeda usa `digits` (o mesmo para
 * todos os valores de um grupo: stat, coluna, lista de barras) e, sem ele, reais inteiros quando o valor é inteiro.
 */
export function formatPageNumber(value: number, options: PageNumberOptions = {}): string {
	if (!Number.isFinite(value)) return EMPTY;
	const unit = options.unit?.trim();
	const code = unit && CURRENCY_SYMBOL[unit.toUpperCase()] ? unit.toUpperCase() : options.format === "currency" ? "BRL" : undefined;
	const compact = options.format === "compact";
	if (code) {
		const symbol = CURRENCY_SYMBOL[code]!;
		const digits = options.digits ?? currencyDigits([value]);
		const body = compact ? formatCompact(Math.abs(value)) : formatDecimal(Math.abs(value), digits, digits);
		return `${value < 0 && body !== "0" ? "-" : ""}${symbol} ${body}`;
	}
	const plain = compact ? formatCompact(value) : formatDecimal(value, 0, 2);
	if (unit === "%" || options.format === "percent") return `${plain}%`;
	return unit ? `${plain} ${unit}` : plain;
}

/** Valor de célula/tile: número formatado, texto como veio, vazio como "—". */
export function formatPageValue(value: string | number | null | undefined, options: PageNumberOptions = {}): string {
	if (value === null || value === undefined || value === "") return EMPTY;
	return typeof value === "number" ? formatPageNumber(value, options) : value;
}

const DELTA_LABEL_SHORT: Array<[RegExp, string]> = [
	[/^vs\.?\s+(semana|mês|mes|ano|trimestre|dia)\s+anterior$/i, "vs. $1 ant."],
	[/^em rela[cç][aã]o (à|a|ao) (meta|semana anterior|mês anterior)$/i, "vs. $2"],
];

/** Rótulos longos e comuns da variação ficam curtos para caber em uma linha no tile ("vs. semana anterior" -> "vs. sem. ant."). */
export function shortDeltaLabel(label: string): string {
	const trimmed = label.trim();
	for (const [pattern, replacement] of DELTA_LABEL_SHORT) {
		if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement).replace(/\bsemana ant\./i, "sem. ant.");
	}
	return trimmed;
}

/** Tom da variação: subir é positivo, descer é crítico, estável é neutro (a seta e o sinal carregam a direção também). */
export const DELTA_TONE = { up: "positive", down: "critical", flat: "neutral" } as const;

/**
 * Variação do tile: "▲ 8% vs meta", "▼ R$ 300" (absoluta, na unidade do tile) e "—" quando estável. O sinal e a seta
 * carregam a direção (a cor sozinha não basta). Texto livre no `value` vai como veio.
 */
export function formatPageDelta(delta: PageStatDelta, base: { unit?: string; format?: PageFormat } = {}): string {
	const label = delta.label ? shortDeltaLabel(delta.label) : undefined;
	if (delta.direction === "flat") return [EMPTY, label].filter(Boolean).join(" ");
	const arrow = delta.direction === "up" ? "▲" : "▼";
	let value: string;
	if (typeof delta.value === "string") value = delta.value;
	else if (delta.kind === "absolute") value = formatPageNumber(Math.abs(delta.value), base);
	else value = `${formatPageNumber(Math.abs(delta.value))}%`;
	return [arrow, value, label].filter(Boolean).join(" ");
}

/** Largura (0–100) da barra de um item, relativa ao maior valor da lista; negativo e vazio ficam em 0. */
export function barPercent(value: number, max: number): number {
	if (!(max > 0) || !(value > 0)) return 0;
	return Math.min(100, Math.round((value / max) * 1000) / 10);
}

/** "1 fonte" / "N fontes"; sem fontes, nada. */
export function sourceCountLabel(count: number): string | null {
	if (!(count > 0)) return null;
	return count === 1 ? "1 fonte" : `${count} fontes`;
}

/** Aba a mostrar: a pedida se existir, senão a primeira. */
export function resolveTab<T extends { id: string }>(tabs: readonly T[], requested: string | null | undefined): T {
	return tabs.find((tab) => tab.id === requested) ?? tabs[0]!;
}

/** "Atualizado agora · há 5 min · há 2 h · há 3 dias · em 12/10". `now` entra por parâmetro (nada de relógio real). */
export function updatedAgoLabel(iso: string | null | undefined, now: number): string | null {
	const time = iso ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(time)) return null;
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return "Atualizado agora";
	if (minutes < 60) return `Atualizado há ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `Atualizado há ${hours} h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `Atualizado há ${days} ${days === 1 ? "dia" : "dias"}`;
	const date = new Date(time);
	return `Atualizado em ${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

/** Quantas linhas do gráfico entram na tabela provisória (o gráfico de verdade abre no navegador). */
export const CHART_TABLE_MAX_ROWS = 12;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Datas ISO do eixo X como "05/10"; se os anos diferem, "05/10/26". Texto que não é data ISO vai como veio. */
export function formatChartDates(values: ReadonlyArray<string | number | null | undefined>): string[] {
	const parsed = values.map((value) => (typeof value === "string" ? ISO_DATE.exec(value) : null));
	const years = new Set(parsed.map((match) => match?.[1]).filter(Boolean));
	return values.map((value, index) => {
		const match = parsed[index];
		if (!match) return formatPageValue(value as string | null | undefined);
		return years.size > 1 ? `${match[3]}/${match[2]}/${match[1]!.slice(2)}` : `${match[3]}/${match[2]}`;
	});
}

/**
 * Dados do gráfico como tabela simples (primeira coluna = eixo X, uma por série). Eixo de datas mostra as ÚLTIMAS
 * linhas (o recente importa) e o cabeçalho é "Período"; senão as primeiras e "Item" (nome interno do campo nunca vai
 * para a tela). X numérico (ano) sem separador de milhar. `hidden` = linhas que ficaram de fora.
 */
export function chartTable(spec: ChartSpec): { title: string; header: string[]; rows: string[][]; hidden: number } | null {
	if (!spec.data.length || !spec.series.length) return null;
	const isDate = spec.xKind === "date";
	const header = [isDate ? "Período" : "Item", ...spec.series.map((series) => series.label)];
	const format = { unit: spec.unit, format: spec.format };
	const cell = (value: string | number | null | undefined) => formatPageValue(value, format);
	const data = isDate ? spec.data.slice(-CHART_TABLE_MAX_ROWS) : spec.data.slice(0, CHART_TABLE_MAX_ROWS);
	const xs = data.map((point) => point[spec.x]);
	const labels = isDate ? formatChartDates(xs) : xs.map((x) => (typeof x === "number" ? String(x) : formatPageValue(x)));
	const rows = data.map((point, index) => [labels[index]!, ...spec.series.map((series) => cell(point[series.key]))]);
	return { title: spec.title?.trim() || "Gráfico", header, rows, hidden: Math.max(0, spec.data.length - rows.length) };
}
