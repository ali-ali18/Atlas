// F8.1 — o MAPA da página: estrutura (seções) e o tamanho de cada lista, nunca a lista inteira. A leitura da página
// acontece em `browser-inpage.mjs`; aqui mora o que é puro e testável: o total que a PÁGINA declara e o desenho final.

const SUFFIX = { k: 1_000, mil: 1_000, m: 1_000_000, mi: 1_000_000, million: 1_000_000, milhao: 1_000_000, milhoes: 1_000_000 };

/**
 * Total que a página declara num texto curto ("1.024 comentários", "1,2 mil", "2.3M", "(1 024)").
 * `null` = não diz. Extração de dado do DOM (não decide comportamento do agente); número solto de ano (1900-2100) é ignorado.
 */
export function parseDeclaredCount(text) {
	const source = String(text ?? "")
		.normalize("NFD")
		.replace(/\p{M}/gu, "");
	const pattern = /(\d{1,3}(?:[.,   ]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*(k|mil|mi|m|milhoes|milhao|million)\b)?/giu;
	for (const match of source.matchAll(pattern)) {
		const raw = match[1];
		const suffix = match[2] ? SUFFIX[match[2].toLowerCase()] : 1;
		const grouped = /^\d{1,3}(?:[.,   ]\d{3})+$/.test(raw);
		const value = grouped ? Number(raw.replace(/[.,   ]/g, "")) : Number(raw.replace(",", "."));
		if (!Number.isFinite(value)) continue;
		const total = Math.round(value * suffix);
		if (suffix === 1 && !grouped && value >= 1900 && value <= 2100 && Number.isInteger(value)) continue;
		if (total >= 0) return total;
	}
	return null;
}

/** Mapa final (formato do protocolo `browser.map`) a partir do que a página devolveu. */
export function buildMap(raw) {
	const sections = raw.sections.map((s) => {
		const listy = s.kind === "list" || s.kind === "table";
		let declaredTotal = null;
		if (listy) {
			for (const hint of s.countHints ?? []) {
				declaredTotal = parseDeclaredCount(hint);
				if (declaredTotal !== null) break;
			}
		}
		const canLoadMore = listy && (Boolean(s.moreControl) || Boolean(s.scrollable) || (declaredTotal !== null && declaredTotal > s.items));
		return {
			id: s.id,
			kind: s.kind,
			label: s.label,
			items: s.items,
			declaredTotal,
			canLoadMore,
			chars: s.chars,
			...(s.preview ? { preview: s.preview } : {}),
		};
	});
	return {
		url: raw.url,
		title: raw.title,
		totalChars: raw.totalChars,
		sections,
		...(raw.omitted > 0 ? { omittedSections: raw.omitted } : {}),
		...(raw.poorTree ? { poorTree: true } : {}),
		...(raw.wall ? { wall: raw.wall } : {}),
	};
}
