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
	// A cadeia nunca fica rejeitada: uma gravação que falha não pode pular as seguintes.
	let chain: Promise<void> = Promise.resolve();
	// Primeira falha de gravação best-effort (deltas): vira erro no `flush` explícito, uma vez.
	let firstError: unknown;
	let hasError = false;
	const remember = (error: unknown) => {
		if (hasError) return;
		hasError = true;
		firstError = error;
	};

	/** Enfileira a tarefa; a falha dela rejeita só o promise devolvido, nunca a cadeia. */
	const enqueue = (task: () => Promise<void>) => {
		const result = chain.then(task);
		chain = result.catch(() => undefined);
		return result;
	};

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

	/** Grava o lote pendente sem propagar: delta é best-effort e não pode derrubar quem veio depois. */
	const flushBestEffort = async () => {
		try {
			await flushLocked();
		} catch (error) {
			remember(error);
		}
	};

	const scheduleFlush = () => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			void enqueue(flushBestEffort);
		}, windowMs);
	};

	const push = (event: ComputerUseEvent) => {
		if (event.type === "assistant_delta") {
			// Best-effort: nunca rejeita (a falha fica para o `flush` do fim do run).
			return enqueue(async () => {
				if (buffer && buffer.id === event.id) {
					buffer = { ...buffer, delta: `${buffer.delta}${event.delta}` };
				} else {
					await flushBestEffort();
					buffer = event;
				}
				bufferBytes += Buffer.byteLength(event.delta, "utf8");
				if (bufferBytes >= maxBytes) {
					await flushBestEffort();
					return;
				}
				scheduleFlush();
			});
		}
		// Evento importante (tool, card, done): a ordem se mantém e a falha dele chega a quem chamou.
		return enqueue(async () => {
			await flushBestEffort();
			await write(event);
		});
	};

	const flush = () =>
		enqueue(async () => {
			await flushBestEffort();
			if (!hasError) return;
			const error = firstError;
			hasError = false;
			firstError = undefined;
			throw error;
		});

	return { push, flush };
}
