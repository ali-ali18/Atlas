// F12/A2 — leitura paginada de texto. Puro, exceto `collectPageText`, que
// roda DENTRO da página (serializado pelo Playwright).

export const TEXT_DEFAULT_LIMIT = 4000;
export const TEXT_MAX_LIMIT = 6000;

export function normalizeText(raw) {
	return String(raw ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function clampPage({ offset, limit } = {}, { defaultLimit = TEXT_DEFAULT_LIMIT, maxLimit = TEXT_MAX_LIMIT } = {}) {
	const off = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
	const lim = Number.isFinite(Number(limit)) && Number(limit) > 0
		? Math.min(maxLimit, Math.floor(Number(limit)))
		: defaultLimit;
	return { offset: off, limit: lim };
}

/** Fatia o texto e diz onde continuar (`nextOffset`). */
export function paginateText(text, page, limits) {
	const { offset, limit } = clampPage(page, limits);
	const totalLength = text.length;
	let slice = text.slice(offset, offset + limit);
	// Com `breakOnLine`, corta na última quebra de linha (>= 60% da página) para não partir uma linha ao meio.
	if (limits?.breakOnLine && offset + slice.length < totalLength) {
		const cut = slice.lastIndexOf("\n");
		if (cut >= limit * 0.6) slice = slice.slice(0, cut + 1);
	}
	const end = offset + slice.length;
	const truncated = end < totalLength;
	return {
		text: slice,
		offset,
		limit,
		totalLength,
		truncated,
		nextOffset: truncated ? end : null,
	};
}

/**
 * Roda na página. `mode: "viewport"` devolve só o texto dos nós visíveis na
 * janela; `"page"` devolve o `innerText` inteiro. Também devolve a posição
 * de scroll, que entra na chave de repetição do runtime (ler → rolar → ler
 * não é laço).
 */
export function collectPageText(mode) {
	const scroller = document.scrollingElement || document.documentElement;
	const position = {
		scrollY: Math.round(scroller.scrollTop),
		scrollHeight: Math.round(scroller.scrollHeight),
		viewportHeight: Math.round(window.innerHeight),
	};
	if (mode !== "viewport") {
		return { ...position, text: document.body?.innerText ?? "" };
	}
	const parts = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const value = (node.nodeValue || "").replace(/\s+/g, " ").trim();
		if (!value) continue;
		const parent = node.parentElement;
		if (!parent) continue;
		const tag = parent.tagName;
		if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;
		const style = getComputedStyle(parent);
		if (style.visibility === "hidden" || style.display === "none") continue;
		range.selectNodeContents(node);
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
		if (rect.right < 0 || rect.left > window.innerWidth) continue;
		parts.push(value);
	}
	return { ...position, text: parts.join("\n") };
}
