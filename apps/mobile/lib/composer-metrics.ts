// Medidas do composer compartilhadas com a barra de voz (`dictation-bar.tsx`): as duas caixas têm o mesmo desenho,
// em pílula de uma linha e em retângulo quando o texto quebra.

/** Composer magro como o do Grok (medido no print): 47 de altura externa (45 + borda), botões de 30, margem de 19,5. */
export const COMPOSER_LINE_HEIGHT = 21;
export const COMPOSER_MIN_HEIGHT = 45;
export const COMPOSER_FONT_SIZE = 16;
export const COMPOSER_BUTTON = 30;
/** Respiro dos botões na pílula (7,5 = a pílula de 45 fica com os botões de 30 centrados). */
export const COMPOSER_INSET = 7.5;
/** No retângulo (texto em várias linhas) os botões descolam da borda e do canto arredondado. */
export const COMPOSER_STACKED_INSET = 10;
export const COMPOSER_PILL_RADIUS = 28;
export const COMPOSER_STACKED_RADIUS = 24;
/** Recuo horizontal do texto no retângulo. */
export const COMPOSER_STACKED_TEXT_PADDING = 16;
/** Faixa que o retângulo reserva embaixo para a linha de botões. */
export const COMPOSER_STACKED_STRIP = COMPOSER_BUTTON + COMPOSER_STACKED_INSET * 2;

/**
 * O texto quebrou em mais de uma linha? Regra do campo do composer: a altura passou da base de uma linha em pelo menos
 * 80% de uma linha. `baseline` é a menor altura vista (uma linha).
 */
export function textWrapped(height: number, baseline: number): boolean {
	return height - baseline >= COMPOSER_LINE_HEIGHT * 0.8;
}

/**
 * Estilo do envoltório do campo (item da linha de chips + campo). Só o envoltório tem `flex`; o `TextInput` dentro NÃO pode
 * ter: num envoltório de altura automática, `flex: 1` no filho vira `flexBasis: 0` na vertical e o Yoga (nativo) trava o
 * campo em `minHeight`, que então rola por dentro em vez de crescer. A largura o filho pega do `alignItems: stretch`.
 */
export function fieldWrapperStyle(hasMarkers: boolean) {
	return hasMarkers ? ({ flexGrow: 1, flexShrink: 1, flexBasis: 120, minWidth: 120 } as const) : ({ flex: 1 } as const);
}

/** Altura do campo na web (onde ele não cresce sozinho): a do conteúdo, entre o mínimo e o teto. */
export function webFieldHeight(measured: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, measured));
}
