import type { PageFormat, PageSource, PageSpec, PageStatDelta } from "@workspace/shared";

/** Formatação dos valores da página em pt-BR (1.234,56 · R$ · % · sufixo da unidade). Pura: sem React nem DOM. */

const CURRENCIES = new Set(["BRL", "USD", "EUR"]);

function intl(options: Intl.NumberFormatOptions): Intl.NumberFormat {
	return new Intl.NumberFormat("pt-BR", options);
}

/** Casas decimais de uma moeda para um CONJUNTO de valores: reais inteiros se todos forem inteiros, senão centavos. */
export function currencyDigits(values: ReadonlyArray<number | null | undefined>): 0 | 2 {
	return values.every((value) => typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value)) ? 0 : 2;
}

export type PageNumberOptions = { unit?: string; format?: PageFormat; digits?: 0 | 2 };

/**
 * Texto de um número com `format` e `unit` (moeda BRL/USD/EUR, "%" ou sufixo livre). Moeda usa `digits` (o mesmo para
 * todos os valores de um grupo: stat, coluna, lista de barras) e, sem ele, reais inteiros quando o valor é inteiro.
 */
export function formatPageNumber(value: number, options: PageNumberOptions = {}): string {
	const unit = options.unit?.trim();
	const currency = unit && CURRENCIES.has(unit.toUpperCase()) ? unit.toUpperCase() : options.format === "currency" ? "BRL" : undefined;
	const compact = options.format === "compact";
	if (currency) {
		const digits = options.digits ?? currencyDigits([value]);
		return intl({
			style: "currency",
			currency,
			...(compact ? { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
		}).format(value);
	}
	const plain = intl(compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(value);
	if (unit === "%" || options.format === "percent") return `${plain}%`;
	return unit ? `${plain} ${unit}` : plain;
}

/** Valor de célula/tile: número formatado, texto como veio, vazio como "—". */
export function formatPageValue(value: string | number | null | undefined, options: PageNumberOptions = {}): string {
	if (value === null || value === undefined || value === "") return "—";
	return typeof value === "number" ? formatPageNumber(value, options) : value;
}

const DELTA_LABEL_SHORT: Array<[RegExp, string]> = [
	[/^vs\.?\s+(semana|mês|mes|ano|trimestre|dia)\s+anterior$/i, "vs. $1 ant."],
	[/^em rela[cç][aã]o (à|a|ao) (meta|semana anterior|mês anterior)$/i, "vs. $2"],
];

/** Rótulos longos e comuns da variação ficam curtos para caber em uma linha no tile do celular ("vs. semana anterior" -> "vs. sem. ant."). */
export function shortDeltaLabel(label: string): string {
	const trimmed = label.trim();
	for (const [pattern, replacement] of DELTA_LABEL_SHORT) {
		if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement).replace(/\bsemana ant\./i, "sem. ant.");
	}
	return trimmed;
}

/**
 * Variação do tile: "▲ 8% vs meta", "▼ R$ 300" (absoluta, na unidade do tile) e "—" quando estável. O sinal e a seta
 * carregam a direção (a cor sozinha não basta). Texto livre no `value` vai como veio.
 */
export function formatPageDelta(delta: PageStatDelta, base: { unit?: string; format?: PageFormat } = {}): string {
	if (delta.direction === "flat") return ["—", delta.label ? shortDeltaLabel(delta.label) : undefined].filter(Boolean).join(" ");
	const arrow = delta.direction === "up" ? "▲" : "▼";
	const label = delta.label ? shortDeltaLabel(delta.label) : undefined;
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

export type PageViewState = { spec: PageSpec; revision: number; sources: PageSource[] | null; sourceCount: number; updatedAt: string | null; removed: boolean };

export type RemotePage = { spec: PageSpec; revision: number; sources: PageSource[]; updatedAt: string };

/**
 * O que o cartão mostra: o snapshot gravado na mensagem, trocado pela versão do servidor só se ela for MAIS NOVA
 * (um evento ao vivo pode chegar antes de a leitura voltar). `null` no remoto = página apagada.
 */
export function reconcilePageSnapshot(
	card: { revision: number; spec?: PageSpec; sourceCount: number },
	remote: RemotePage | null | "missing",
): PageViewState | null {
	if (remote === "missing") return card.spec ? { spec: card.spec, revision: card.revision, sources: null, sourceCount: card.sourceCount, updatedAt: null, removed: true } : null;
	if (remote && (!card.spec || remote.revision >= card.revision)) {
		return { spec: remote.spec, revision: remote.revision, sources: remote.sources, sourceCount: remote.sources.length, updatedAt: remote.updatedAt, removed: false };
	}
	if (card.spec) {
		return { spec: card.spec, revision: card.revision, sources: null, sourceCount: card.sourceCount, updatedAt: null, removed: false };
	}
	return null;
}
