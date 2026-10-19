import { parseModelRef } from "@workspace/shared";
import type { ProviderStreamChat } from "./provider-router.js";

function providerOf(model: string): ReturnType<typeof parseModelRef>["provider"] | null {
	try {
		return parseModelRef(model).provider;
	} catch {
		return null;
	}
}

function hasImagePart(messages: Parameters<ProviderStreamChat>[0]["messages"]): boolean {
	return messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url" || part.type === "file"));
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return Boolean(signal?.aborted) || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/**
 * Lista de reserva entre provedores. As reservas do OpenRouter seguem no `models` nativo dele; as de chave própria
 * (Anthropic, OpenCode Go) são tentadas uma a uma, trocando de modelo e de provedor, quando a chamada falha antes de
 * entregar qualquer texto. Sem lista de reserva, sem imagem na conversa ou sem chave do destino: passa direto.
 */
export function createReserveModelStream(
	stream: ProviderStreamChat,
	deps: { isAvailable: (model: string) => Promise<boolean>; log?: (line: string) => void },
): ProviderStreamChat {
	return async (params, handlers = {}) => {
		const reserves = hasImagePart(params.messages) ? [] : (params.fallbackModels ?? []).filter((model) => model !== params.model);
		const primary = providerOf(params.model);
		const direct = reserves.filter((model) => {
			const p = providerOf(model);
			return p === "anthropic" || p === "opencode-go";
		});
		// Nada para trocar à mão: o comportamento de sempre (OpenRouter nativo).
		if (reserves.length === 0 || (primary === "openrouter" && direct.length === 0)) return stream(params, handlers);
		const nativeOnly = reserves.filter((model) => providerOf(model) === "openrouter");
		let delivered = false;
		const tracked = {
			...handlers,
			onDelta: (text: string) => {
				if (text) delivered = true;
				handlers.onDelta?.(text);
			},
		};
		const attempt = (model: string, viaOpenRouter: boolean) =>
			stream({ ...params, model, fallbackModels: viaOpenRouter ? nativeOnly : [] }, tracked);
		try {
			return await attempt(params.model, primary === "openrouter");
		} catch (error) {
			if (delivered || isAbort(error, params.signal)) throw error;
			// OpenRouter já tentou as reservas dele; só sobram as de chave própria (e, se o principal não é OpenRouter, todas).
			const rest = primary === "openrouter" ? direct : reserves.filter((model) => providerOf(model) !== "chatgpt");
			let last: unknown = error;
			for (const model of rest) {
				if (!(await deps.isAvailable(model).catch(() => false))) continue;
				deps.log?.(`[reserve] ${params.model} falhou; tentando ${model}`);
				try {
					const result = await attempt(model, providerOf(model) === "openrouter");
					return { ...result, fallbackFrom: params.model };
				} catch (next) {
					if (delivered || isAbort(next, params.signal)) throw next;
					last = next;
				}
			}
			throw last;
		}
	};
}
