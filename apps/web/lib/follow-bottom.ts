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

/** Seta "ir para o fim": aparece depois disto (mais folgado que o de retomar, para não piscar). */
export const JUMP_ARROW_PX = 120;
/** Um recuo de scrollTop só conta como "a pessoa subiu" se houve gesto/tecla nesta janela (ms)... */
export const INTENT_WINDOW_MS = 300;
/** ...e se foi de pelo menos isto (px): ancoragem de rolagem e jitter de inércia no iOS não soltam. */
export const MIN_DECREASE_PX = 2;

/**
 * Evento de rolagem. Gestos e teclas só registram a intenção (quando); quem solta o acompanhamento é a
 * rolagem que de fato subiu. Assim gesto numa conversa que não se move (curta, scrollTop 0) não solta.
 * O navegador também prende o scrollTop quando o conteúdo encolhe; aí a distância do fim é ~0.
 */
export function stickAfterScroll(input: {
	stuck: boolean;
	previousTop: number;
	top: number;
	distance: number;
	now: number;
	/** Instante do último gesto/tecla de subir (0 = nunca). */
	lastIntentAt: number;
}): boolean {
	if (input.distance <= AT_END_PX) return true;
	const decrease = input.previousTop - input.top;
	if (decrease >= MIN_DECREASE_PX && input.now - input.lastIntentAt <= INTENT_WINDOW_MS) return false;
	if (decrease > 0) return input.stuck;
	if (input.distance <= FOLLOW_RESUME_PX) return true;
	return input.stuck;
}

/** Roda do mouse: deltaY negativo = subir. */
export function wheelIsUpward(deltaY: number, deltaX: number): boolean {
	return deltaY < 0 && Math.abs(deltaY) >= Math.abs(deltaX);
}

/** Dedo: arrastar para baixo (y aumenta) leva o conteúdo para cima; só se for mais vertical que horizontal. */
export function touchIsUpward(dx: number, dy: number): boolean {
	return dy > 0 && Math.abs(dy) > Math.abs(dx);
}

const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
export function keyIsUpward(key: string): boolean {
	return UP_KEYS.has(key);
}

/**
 * O gesto é de um bloco que rola por conta própria (código, tabela, gráfico) e ainda pode subir? Então a
 * conversa não sobe com ele e o acompanhamento fica. `overflowY` injetável para teste.
 */
export function insideNestedScrollerThatCanScrollUp(
	target: EventTarget | null,
	root: Element,
	overflowY: (element: Element) => string = (element) => getComputedStyle(element).overflowY,
): boolean {
	let node = target instanceof Element ? target : null;
	while (node && node !== root) {
		const value = overflowY(node);
		if ((value === "auto" || value === "scroll") && node.scrollTop > 0) return true;
		node = node.parentElement;
	}
	return false;
}
