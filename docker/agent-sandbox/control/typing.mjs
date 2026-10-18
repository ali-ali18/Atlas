// F12/A4 — `xdotool type` falha com texto grande (argv e timeout) e com
// TSV/multilinha. Nesses casos cola via clipboard (xclip + ctrl+v).

export const CLIPBOARD_THRESHOLD = 200;

export function needsClipboard(text) {
	return text.length > CLIPBOARD_THRESHOLD || /[\t\n\r]/.test(text);
}

/**
 * `setClipboard(text)` e `pressKey(combo)` são injetados (xclip/xdotool no
 * server; fakes no teste). Devolve como digitou, para o log.
 */
export async function typeWithStrategy(text, { typeDirect, setClipboard, pressKey }) {
	if (!needsClipboard(text)) {
		await typeDirect(text);
		return { method: "xdotool" };
	}
	await setClipboard(text);
	await pressKey("ctrl+v");
	return { method: "clipboard" };
}
