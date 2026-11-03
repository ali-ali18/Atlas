// Do texto às teclas da VM. O noVNC recebe KEYSYMS (`rfb.sendKey(keysym)`); aqui o app converte o texto digitado ou
// colado em keysyms (X11) e manda a lista para a página. Puro e testado.

/** Teclas especiais (X11, as mesmas de `core/input/keysym.js` do noVNC; o teste confere contra o pacote). */
export const KEY_BACKSPACE = 0xff08;
export const KEY_TAB = 0xff09;
export const KEY_RETURN = 0xff0d;

/** Limite de caracteres ao colar (a página digita tecla por tecla; texto maior é cortado com aviso). */
export const PASTE_MAX_CHARS = 2000;

/**
 * Keysym de um ponto de código, ou null se não vira tecla (controle, substituto solto, fora do Unicode).
 * ASCII imprimível e Latin-1 (acentos) têm keysym igual ao código; o resto usa a faixa Unicode do X11 (0x01000000 + código).
 */
export function codePointToKeysym(cp: number): number | null {
	if (cp === 0x0a || cp === 0x0d) return KEY_RETURN;
	if (cp === 0x09) return KEY_TAB;
	if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return null;
	if (cp >= 0xd800 && cp <= 0xdfff) return null;
	if (cp > 0x10ffff) return null;
	if (cp <= 0x7e || (cp >= 0xa0 && cp <= 0xff)) return cp;
	return 0x01000000 + cp;
}

/** Texto em keysyms, na ordem. CRLF vira um Enter só; o que não vira tecla é descartado. */
export function textToKeysyms(text: string): number[] {
	const keys: number[] = [];
	let previousWasCR = false;
	for (const ch of text) {
		const cp = ch.codePointAt(0) as number;
		if (cp === 0x0a && previousWasCR) {
			previousWasCR = false;
			continue;
		}
		previousWasCR = cp === 0x0d;
		const key = codePointToKeysym(cp);
		if (key !== null) keys.push(key);
	}
	return keys;
}

/** Corta o texto a colar em `max` caracteres (pontos de código, sem partir emoji). `truncated` pede o aviso ao usuário. */
export function clipPasteText(text: string, max: number = PASTE_MAX_CHARS): { text: string; truncated: boolean } {
	let count = 0;
	let end = 0;
	for (const ch of text) {
		if (count === max) return { text: text.slice(0, end), truncated: true };
		count++;
		end += ch.length;
	}
	return { text, truncated: false };
}

/** Frase do aviso quando o texto colado foi cortado. */
export function pasteTruncatedNotice(max: number = PASTE_MAX_CHARS): string {
	return `O texto era grande: só os primeiros ${max} caracteres foram enviados.`;
}
