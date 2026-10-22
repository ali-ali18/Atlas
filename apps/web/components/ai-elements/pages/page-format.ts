import type { PageFormat, PageSource, PageSpec } from "@workspace/shared";

/** Formatação dos valores da página em pt-BR (1.234,56 · R$ · % · sufixo da unidade). Pura: sem React nem DOM. */

const CURRENCIES = new Set(["BRL", "USD", "EUR"]);

function intl(options: Intl.NumberFormatOptions): Intl.NumberFormat {
	return new Intl.NumberFormat("pt-BR", options);
}

/** Texto de um número com `format` e `unit` (moeda BRL/USD/EUR, "%" ou sufixo livre). */
export function formatPageNumber(value: number, options: { unit?: string; format?: PageFormat } = {}): string {
	const unit = options.unit?.trim();
	const currency = unit && CURRENCIES.has(unit.toUpperCase()) ? unit.toUpperCase() : options.format === "currency" ? "BRL" : undefined;
	const compact = options.format === "compact";
	if (currency) {
		return intl({
			style: "currency",
			currency,
			...(compact ? { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0 } : {}),
		}).format(value);
	}
	const plain = intl(compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(value);
	if (unit === "%" || options.format === "percent") return `${plain}%`;
	return unit ? `${plain} ${unit}` : plain;
}

/** Valor de célula/tile: número formatado, texto como veio, vazio como "—". */
export function formatPageValue(value: string | number | null | undefined, options: { unit?: string; format?: PageFormat } = {}): string {
	if (value === null || value === undefined || value === "") return "—";
	return typeof value === "number" ? formatPageNumber(value, options) : value;
}

/** "▲ 8% vs meta": o sinal e a seta carregam a direção (a cor sozinha não basta). */
export function formatPageDelta(delta: { value: number | string; direction: "up" | "down" | "flat"; label?: string }): string {
	const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "▬";
	const value = typeof delta.value === "number" ? `${formatPageNumber(Math.abs(delta.value))}%` : delta.value;
	return [arrow, value, delta.label].filter(Boolean).join(" ");
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
