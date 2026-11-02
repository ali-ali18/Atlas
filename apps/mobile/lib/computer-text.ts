// Texto que o usuário manda para a VM (colar e a barra do teclado). Puro: só decide se dá para enviar.

/** Limite de caracteres por envio. */
export const VM_TEXT_MAX = 5000;

export type VmTextCheck = { ok: true; text: string } | { ok: false; reason: "empty" | "too-long" };

/** Vazio (ou só espaços/quebras) não envia; acima do limite não envia nem corta em silêncio. O texto vai como foi digitado. */
export function checkVmText(text: string): VmTextCheck {
	if (text.trim().length === 0) return { ok: false, reason: "empty" };
	if (text.length > VM_TEXT_MAX) return { ok: false, reason: "too-long" };
	return { ok: true, text };
}

/** Frase para o usuário quando `checkVmText` recusa. */
export function vmTextProblem(reason: "empty" | "too-long"): string {
	return reason === "empty" ? "Não há nada para enviar." : `O texto é grande demais. O limite é de ${VM_TEXT_MAX} caracteres.`;
}
