/**
 * Junta pedidos repetidos num só quadro: `request` agenda `run` uma vez; os pedidos seguintes até o quadro
 * rodar são ignorados. Durante o stream chega um pedido de rolagem por token, mas o layout só é lido e a
 * rolagem só é escrita uma vez por quadro.
 */
export type FrameCoalescer = { request: () => void; cancel: () => void };

export function createFrameCoalescer(
	run: () => void,
	schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
	unschedule: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): FrameCoalescer {
	let handle: number | null = null;
	return {
		request() {
			if (handle !== null) return;
			handle = schedule(() => {
				handle = null;
				run();
			});
		},
		cancel() {
			if (handle !== null) unschedule(handle);
			handle = null;
		},
	};
}
