// F8.1 — PARTES de uma seção: janela numerada que diz onde está e quanto falta. Nada é cortado em silêncio:
// item maior que `itemChars` informa quantos caracteres ficaram de fora; a parte que enche a janela termina antes e diz de onde seguir.
// Espelha `planPart` de packages/agent/src/capabilities/browser/fake-browser.ts (os dois lados têm testes dos mesmos casos).

export const PART_MAX_CHARS = 24_000;
export const READ_DEFAULT_COUNT = 50;
export const READ_MAX_COUNT = 200;
export const ITEM_DEFAULT_CHARS = 1_500;
export const ITEM_MAX_CHARS = 20_000;

const intIn = (value, min, max, fallback, name) => {
	if (value === undefined || value === null) return fallback;
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return value;
};

export function parseReadArgs(body) {
	const section = typeof body?.section === "string" ? body.section : undefined;
	const exportId = typeof body?.export === "string" ? body.export : undefined;
	if (!section && !exportId) throw new Error("Give section (from browser_map).");
	if (section && !/^s\d{1,4}$/.test(section)) throw new Error(`Invalid section "${section}": use an id from browser_map (like "s3").`);
	if (exportId && !/^x[0-9a-z]{4,24}$/.test(exportId)) throw new Error(`Invalid export "${exportId}".`);
	return {
		section,
		exportId,
		from: intIn(body?.from, 1, 10_000_000, 1, "from"),
		count: intIn(body?.count, 1, READ_MAX_COUNT, READ_DEFAULT_COUNT, "count"),
		itemChars: intIn(body?.itemChars, 100, ITEM_MAX_CHARS, ITEM_DEFAULT_CHARS, "itemChars"),
	};
}

/**
 * `entries`: itens já lidos a partir de `from` (texto até `itemChars`, `chars` = tamanho real). Pára antes de passar da janela
 * (sempre devolve ao menos um). `loaded` = quantos itens a seção tem agora.
 */
export function planPart(entries, { from, loaded, itemChars, maxChars = PART_MAX_CHARS }) {
	const items = [];
	let used = 0;
	for (const [i, entry] of entries.entries()) {
		const text = entry.text.length > itemChars ? entry.text.slice(0, itemChars) : entry.text;
		if (items.length > 0 && used + text.length > maxChars) break;
		used += text.length;
		const clipped = entry.chars - text.length;
		items.push({ n: from + i, text, ...(clipped > 0 ? { clippedChars: clipped } : {}) });
	}
	const to = items.length > 0 ? items.at(-1).n : 0;
	return { items, to, nextFrom: to > 0 && to < loaded ? to + 1 : null };
}
