// Chamadas à API do Atlas com a sessão. O cookie sai só para a origem do servidor salvo: um caminho absoluto
// para outro host é recusado, senão o app entregaria a sessão a terceiros.

export type ApiFetchDeps = {
	baseUrl: string;
	getCookie: () => Promise<string> | string;
	fetchImpl?: typeof fetch;
};

export function resolveApiUrl(baseUrl: string, path: string): string | null {
	try {
		const base = new URL(baseUrl);
		const url = new URL(path, base);
		return url.origin === base.origin ? url.toString() : null;
	} catch {
		return null;
	}
}

export function createApiFetch(deps: ApiFetchDeps) {
	return async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
		const url = resolveApiUrl(deps.baseUrl, path);
		if (!url) throw new Error("Endereço fora do servidor do Atlas.");
		const headers = new Headers(init.headers);
		const cookie = await deps.getCookie();
		if (cookie) headers.set("cookie", cookie);
		// Cookie vai no cabeçalho; o armazenamento de cookies do sistema não entra (o app não depende dele).
		return (deps.fetchImpl ?? fetch)(url, { ...init, headers, credentials: "omit" });
	};
}
