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
