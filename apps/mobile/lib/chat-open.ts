// Abre o stream SSE do run no aparelho. Plano A: `fetch` do `expo/fetch` (o do Expo SDK 52+ entrega
// `response.body` como `ReadableStream`, lido com `getReader()` + `TextDecoder`, igual ao web). Plano B: se a
// resposta vier sem corpo legível, `XMLHttpRequest` com `onprogress` (o RN entrega o texto que já chegou). Depois
// de usar o plano B uma vez, as próximas conexões já abrem por ele (sem tentar o A de novo).
import { resolveApiUrl } from "./api-fetch";
import { sourceFromReader, sourceFromXhr, StreamHttpError, type OpenStream, type TextSource } from "./chat-stream";

export type StreamResponse = {
	ok: boolean;
	status: number;
	body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } } | null;
};
export type StreamFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; credentials: "omit" }) => Promise<StreamResponse>;

export type StreamOpenerDeps = {
	baseUrl: string;
	getCookie: () => Promise<string> | string;
	streamFetch: StreamFetch;
};

let useXhr = false;

/** Só testes. */
export function resetStreamTransport(): void {
	useXhr = false;
}

export function createRunStreamOpener(deps: StreamOpenerDeps, runId: string): OpenStream {
	return async (cursor, signal) => {
		const url = resolveApiUrl(deps.baseUrl, `/v1/runs/${encodeURIComponent(runId)}/stream?after=${cursor}`);
		if (!url) throw new Error("Endereço fora do servidor do Atlas.");
		const cookie = await deps.getCookie();
		const headers: Record<string, string> = {
			accept: "text/event-stream",
			...(cookie ? { cookie } : {}),
			...(cursor > 0 ? { "Last-Event-ID": String(cursor) } : {}),
		};
		if (!useXhr) {
			const response = await deps.streamFetch(url, { headers, signal, credentials: "omit" });
			if (!response.ok) throw new StreamHttpError(response.status);
			if (response.body) return sourceFromReader(response.body.getReader());
			useXhr = true;
		}
		return openWithXhr(url, headers, signal);
	};
}

function openWithXhr(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<TextSource> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", url);
		xhr.withCredentials = false;
		for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
		const abort = () => xhr.abort();
		signal.addEventListener("abort", abort, { once: true });
		xhr.onreadystatechange = () => {
			if (xhr.readyState < 2) return;
			if (xhr.status < 200 || xhr.status >= 300) {
				xhr.abort();
				reject(new StreamHttpError(xhr.status));
				return;
			}
			resolve(sourceFromXhr(xhr));
		};
		xhr.onerror = () => reject(new Error("Sem conexão."));
		xhr.send();
	});
}
