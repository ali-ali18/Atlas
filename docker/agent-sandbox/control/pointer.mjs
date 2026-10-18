// Cursor do agente — onde a ação aconteceu, em coordenadas da TELA do sandbox
// (é a tela que o usuário vê no VNC). Best effort: nunca falha a ação.

export const POINTER_NAME_MAX = 40;

/**
 * Roda DENTRO da página (Playwright serializa a função): centro do elemento
 * na tela + nome curto. Sobe pelos iframes somando o deslocamento de cada um;
 * iframe de outra origem só interrompe a subida. Campo de senha nunca expõe nome.
 * Autossuficiente de propósito (sem closures nem imports).
 */
export function readPointer(el) {
	const view = el.ownerDocument?.defaultView;
	if (!view) return null;
	const rect = el.getBoundingClientRect();
	if (!(rect.width > 0 && rect.height > 0)) return null;
	let x = rect.left + rect.width / 2;
	let y = rect.top + rect.height / 2;
	let top = view;
	try {
		while (top.frameElement) {
			const frame = top.frameElement.getBoundingClientRect();
			x += frame.left;
			y += frame.top;
			top = top.parent;
		}
	} catch {
		// iframe de outra origem: fica com o que somou até aqui.
	}
	// Parou num iframe de outra origem: o deslocamento dos frames pais é
	// somado no servidor (Locator.boundingBox já vem em coordenadas da janela).
	const partial = Boolean(top.parent) && top.parent !== top;
	const side = Math.max(0, (top.outerWidth - top.innerWidth) / 2);
	const chromeTop = Math.max(0, top.outerHeight - top.innerHeight - side);
	const sx = top.screenX + side + x;
	const sy = top.screenY + chromeTop + y;

	const type = String(el.type ?? "").toLowerCase();
	const auto = String(el.getAttribute?.("autocomplete") ?? "").toLowerCase();
	const sensitive = type === "password" || /password|cc-|one-time-code/.test(auto);
	let name = "";
	if (!sensitive) {
		const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
		const label = el.labels?.[0]?.innerText;
		const own = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
		const buttonValue = ["button", "submit", "reset"].includes(type) ? el.value : "";
		name =
			clean(el.getAttribute?.("aria-label")) ||
			clean(label) ||
			clean(own ? "" : el.innerText) ||
			clean(buttonValue) ||
			clean(el.getAttribute?.("placeholder")) ||
			clean(el.getAttribute?.("title")) ||
			clean(el.getAttribute?.("name"));
		if (name.length > 40) name = `${name.slice(0, 39)}…`;
	}
	return {
		x: Math.round(sx),
		y: Math.round(sy),
		screenW: Math.round(top.screen?.width ?? 0) || undefined,
		screenH: Math.round(top.screen?.height ?? 0) || undefined,
		...(name ? { name } : {}),
		...(sensitive ? { sensitive: true } : {}),
		...(partial ? { partial: true } : {}),
	};
}

/** Roda NA página principal: onde a área do conteúdo começa na tela. */
export function readScreenOrigin() {
	const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
	const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - side);
	return {
		x: window.screenX + side,
		y: window.screenY + chromeTop,
		screenW: Math.round(window.screen?.width ?? 0) || undefined,
		screenH: Math.round(window.screen?.height ?? 0) || undefined,
	};
}

/** Pointer de elemento em iframe de outra origem: caixa na janela + origem da tela. */
async function resolvePartial(locator, pointer) {
	const { partial: _partial, ...rest } = pointer;
	const box = await locator.boundingBox();
	if (!box) return undefined;
	const origin = await locator.page().evaluate(readScreenOrigin);
	return {
		...rest,
		x: Math.round(origin.x + box.x + box.width / 2),
		y: Math.round(origin.y + box.y + box.height / 2),
		screenW: origin.screenW,
		screenH: origin.screenH,
	};
}

/**
 * `locator.evaluate(readPointer)` sem nunca lançar (elemento sumiu, página
 * navegou). Recebe uma função para que até achar o locator seja best effort.
 */
export async function safePointer(getLocator) {
	try {
		const locator = getLocator();
		let pointer = await locator.evaluate(readPointer);
		if (pointer?.partial) pointer = await resolvePartial(locator, pointer);
		return pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y) ? pointer : undefined;
	} catch {
		return undefined;
	}
}
