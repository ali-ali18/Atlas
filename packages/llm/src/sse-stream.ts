import { abortable } from "./decision-budget.js";
export class OpenRouterError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "OpenRouterError";
		this.status = status;
	}
}

export type OpenRouterSseChunk = {
	id?: string;
	model?: string;
	choices?: Array<{
		delta?: {
			reasoning?: string;
			reasoning_details?: unknown[];
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		message?: { content?: string | null };
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	error?: { message?: string; code?: number | string };
};

function errorMessageFromChunk(chunk: OpenRouterSseChunk): string {
	if (typeof chunk.error?.message === "string" && chunk.error.message.trim()) {
		return chunk.error.message;
	}
	return "O provedor enviou um erro no stream após HTTP 200";
}

/**
 * Lê um SSE OpenRouter até `[DONE]` ou o fim do body.
 * Libera o reader no `finally` mesmo se a conexão keep-alive continuar aberta.
 * Observa o signal também no reader, inclusive com transportes não cooperativos.
 */
export async function readOpenRouterSse(
	body: ReadableStream<Uint8Array>,
	onChunk: (chunk: OpenRouterSseChunk) => void,
	options: { signal?: AbortSignal; requireDone?: boolean } = {},
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await abortable(reader.read(), options.signal);
			if (done) {
				if (options.requireDone) throw new OpenRouterError("OpenRouter stream ended before DONE", 502);
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.slice(5).trim();
				if (!payload) continue;
				if (payload === "[DONE]") {
					return;
				}
				let chunk: OpenRouterSseChunk;
				try {
					chunk = JSON.parse(payload) as OpenRouterSseChunk;
				} catch {
					continue;
				}
				if (chunk.error) {
					throw new OpenRouterError(errorMessageFromChunk(chunk), typeof chunk.error.code === "number" ? chunk.error.code : 502);
				}
				onChunk(chunk);
			}
		}
	} finally {
		try {
			void reader.cancel().catch(() => undefined);
		} catch {
			// Já fechado ou abortado pelo signal do fetch.
		}
		try {
			reader.releaseLock();
		} catch {
			// Lock já solto após cancel.
		}
	}
}
