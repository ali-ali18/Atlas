/**
 * Acompanhar o fim da conversa enquanto o bot escreve. Só vale para quem está de fato no fim, ao lado do
 * composer: a intenção de subir (mesmo pouco) solta o acompanhamento na hora e nada puxa a pessoa de volta.
 * Volta a acompanhar quando ela mesma chega ao fim, toca na seta "ir para o fim" ou envia uma mensagem.
 * Funções puras; o chat-thread só liga os eventos.
 */

/** Chegou ao fim (px): abaixo disto, rolando para baixo, volta a acompanhar. Pequeno de propósito. */
export const FOLLOW_RESUME_PX = 32;
/** Colado de verdade no fim: nem um recuo de rolagem desfaz (o navegador "prende" o scrollTop se o conteúdo encolhe). */
export const AT_END_PX = 1;

/**
 * Evento de rolagem. O scrollTop só diminui por gesto da pessoa (nós só rolamos para baixo); a exceção é o
 * navegador prender o scrollTop quando o conteúdo encolhe, e aí a distância do fim é ~0.
 */
export function stickAfterScroll(input: { stuck: boolean; previousTop: number; top: number; distance: number }): boolean {
	if (input.distance <= AT_END_PX) return true;
	if (input.top < input.previousTop) return false;
	if (input.distance <= FOLLOW_RESUME_PX) return true;
	return input.stuck;
}

/** Roda do mouse: deltaY negativo = subir. */
export function wheelReleasesFollow(deltaY: number): boolean {
	return deltaY < 0;
}

/** Dedo: arrastar para baixo (y aumenta) leva o conteúdo para cima. */
export function touchReleasesFollow(previousY: number, y: number): boolean {
	return y > previousY;
}

const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
export function keyReleasesFollow(key: string): boolean {
	return UP_KEYS.has(key);
}
