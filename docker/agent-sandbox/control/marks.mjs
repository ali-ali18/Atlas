// F12/C2 — Set-of-Mark: números dos refs do snapshot desenhados SOBRE a
// página (overlay DOM com pointer-events:none) enquanto o scrot captura a
// tela. Sem ImageMagick na imagem; o overlay some logo depois.

const MARKS_ID = "__atlas_marks__";

/** Roda DENTRO da página (sem closure). Devolve quantas marcas foram desenhadas. */
export function drawMarksInPage(options) {
	const { id, max } = options;
	document.getElementById(id)?.remove();
	const layer = document.createElement("div");
	layer.id = id;
	layer.style.cssText =
		"position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;margin:0;padding:0";
	let count = 0;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	for (const el of document.querySelectorAll("[data-atlas-ref]")) {
		if (count >= max) break;
		const rect = el.getBoundingClientRect();
		if (rect.width < 4 || rect.height < 4) continue;
		if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none") continue;
		const ref = el.getAttribute("data-atlas-ref") || "";
		const box = document.createElement("div");
		box.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;outline:2px solid #e11d48;box-sizing:border-box`;
		const tag = document.createElement("div");
		tag.textContent = ref.replace(/^e/, "");
		tag.style.cssText =
			"position:absolute;left:0;top:0;transform:translateY(-100%);background:#e11d48;color:#fff;font:bold 11px/13px monospace;padding:0 3px;white-space:nowrap";
		if (rect.top < 14) tag.style.transform = "none";
		box.appendChild(tag);
		layer.appendChild(box);
		count += 1;
	}
	document.documentElement.appendChild(layer);
	return count;
}

export function clearMarksInPage(id) {
	document.getElementById(id)?.remove();
}

export const MARKS_MAX = 80;

/**
 * Desenha as marcas, executa `capture()` e SEMPRE limpa. `ensureRefs` tira um
 * snapshot do viewport antes (os refs são o que se numera).
 */
export async function withMarks({ withPageRetry, ensureRefs }, capture) {
	await ensureRefs();
	let drawn = 0;
	try {
		drawn = await withPageRetry((page) =>
			page.evaluate(drawMarksInPage, { id: MARKS_ID, max: MARKS_MAX }),
		);
		const buffer = await capture();
		return { buffer, marks: drawn };
	} finally {
		await withPageRetry((page) => page.evaluate(clearMarksInPage, MARKS_ID)).catch(() => undefined);
	}
}
