import type { ComputerUseEvent } from "@workspace/shared";

const DEFAULT_WINDOW_MS = 40;

/** Agrupa deltas do mesmo balão para não gravar um evento por token. */
export function createRunEventCoalescer(
	write: (event: ComputerUseEvent) => Promise<void>,
	windowMs = DEFAULT_WINDOW_MS,
) {
	let buffer: Extract<ComputerUseEvent, { type: "assistant_delta" }> | null =
		null;
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
