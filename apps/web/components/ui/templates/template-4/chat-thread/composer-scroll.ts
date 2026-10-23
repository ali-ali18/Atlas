/**
 * O campo do compositor cresce até um teto e, passando dele, o wrapper (`composer-field`) rola.
 * `touch-pan-y` + `overscroll-contain` mantêm o arrasto/roda dentro do campo (sem puxar a página).
 */
export const COMPOSER_FIELD_CLASS =
	"grid max-h-32 min-h-7 w-full touch-pan-y overflow-y-auto overscroll-contain [scrollbar-width:thin]";

/**
 * O textarea não rola sozinho (o wrapper rola), então nem todo navegador leva o cursor para a vista ao
 * digitar/colar. Com o cursor no fim de um campo focado, a gente rola o wrapper até o fim; no meio do
 * texto o navegador já cuida, e puxar o scroll atrapalharia quem está editando.
 */
export function shouldStickToEnd({
	focused,
	selectionStart,
	selectionEnd,
	valueLength,
}: {
	focused: boolean;
	selectionStart: number | null;
	selectionEnd: number | null;
	valueLength: number;
}): boolean {
	if (!focused || valueLength === 0) return false;
	return selectionStart === valueLength && selectionEnd === valueLength;
}
