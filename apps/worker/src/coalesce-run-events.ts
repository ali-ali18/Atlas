import type { ComputerUseEvent } from "@workspace/shared";

/** Janela de agrupamento dos deltas do mesmo balão (PLANO-DESEMPENHO A2). */
export const RUN_EVENT_COALESCE_WINDOW_MS = 150;
/** Texto acumulado que força a gravação antes da janela acabar (resposta longa não fica parada no buffer). */
export const RUN_EVENT_COALESCE_MAX_BYTES = 4 * 1024;

/**
 * Agrupa deltas do mesmo balão para não gravar um evento por token (cada gravação é uma transação com
 * trava do `seq`). Grava o lote ao fim da janela, ao passar do teto de bytes, antes de qualquer evento
 * que não seja delta (tool, card, done: a ordem fica a mesma) e no `flush` do fim do run.
 */
export function createRunEventCoalescer(
	write: (event: ComputerUseEvent) => Promise<void>,
	options: { windowMs?: number; maxBytes?: number } = {},
) {
	const windowMs = options.windowMs ?? RUN_EVENT_COALESCE_WINDOW_MS;
	const maxBytes = options.maxBytes ?? RUN_EVENT_COALESCE_MAX_BYTES;
	let buffer: Extract<ComputerUseEvent, { type: "assistant_delta" }> | null =
		null;
	let bufferBytes = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let chain = Promise.resolve();

	const flushLocked = async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!buffer) return;
		const event = buffer;
		buffer = null;
		bufferBytes = 0;
		await write(event);
	};

	const scheduleFlush = () => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			chain = chain.then(flushLocked);
		}, windowMs);
	};

	const push = (event: ComputerUseEvent) => {
		chain = chain.then(async () => {
			if (event.type === "assistant_delta") {
				if (buffer && buffer.id === event.id) {
					buffer = { ...buffer, delta: `${buffer.delta}${event.delta}` };
				} else {
					await flushLocked();
					buffer = event;
				}
				bufferBytes += Buffer.byteLength(event.delta, "utf8");
				if (bufferBytes >= maxBytes) {
					await flushLocked();
					return;
				}
				scheduleFlush();
				return;
			}
			await flushLocked();
			await write(event);
		});
		return chain;
	};

	const flush = () => {
		chain = chain.then(flushLocked);
		return chain;
	};

	return { push, flush };
}
