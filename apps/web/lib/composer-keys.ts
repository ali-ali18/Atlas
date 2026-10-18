/** Decisão da tecla Enter no campo de mensagem (puro, testável). */
export type ComposerEnterAction = "pick-mention" | "send" | "newline";

/** Teclado virtual / toque: Enter quebra linha e o envio é só pelo botão. */
export function isTouchKeyboardDevice(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches;
}

export function composerEnterAction(input: {
	touch: boolean;
	shift: boolean;
	mentionOpen: boolean;
	hasCandidates: boolean;
	composing?: boolean;
}): ComposerEnterAction {
	if (input.composing) return "newline";
	if (input.mentionOpen && input.hasCandidates) return "pick-mention";
	if (input.touch || input.shift) return "newline";
	return "send";
}
