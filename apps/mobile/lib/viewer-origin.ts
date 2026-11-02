// Origem do WebSocket do viewer, a partir do endereço do servidor salvo. Puro e leve (a página e a API dependem dele).

/** Nome ou IPv4 (`atlas.example.com`, `10.0.0.5`), ou IPv6 entre colchetes, com porta opcional. Só o formato: nada de `;`, espaço, `*` ou `@`. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** `wss://host` (ou `ws://host` para servidor em http, só em desenvolvimento) do servidor salvo, ou null se o endereço não serve. */
export function viewerSocketOrigin(serverUrl: string): string | null {
	try {
		const url = new URL(serverUrl);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.username || url.password || !HOST.test(url.host)) return null;
		return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
	} catch {
		return null;
	}
}
