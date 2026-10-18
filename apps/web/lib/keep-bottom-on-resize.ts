/**
 * Teclado do celular: com `interactiveWidget: "resizes-content"` a área da conversa encolhe quando o teclado
 * abre. Se a pessoa estava no fim da conversa, a última mensagem tem que continuar visível (sem salto);
 * se estava lendo mais acima, a posição não muda.
 */
export function shouldKeepBottomOnResize(input: {
	previousHeight: number;
	nextHeight: number;
	/** Estava colado no fim antes de redimensionar (stickRef da conversa). */
	wasStuck: boolean;
}): boolean {
	if (!input.wasStuck) return false;
	if (input.previousHeight <= 0 || input.nextHeight <= 0) return false;
	return input.nextHeight !== input.previousHeight;
}
