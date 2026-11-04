// Resposta do `GET /v1/sandbox/sessions/:id/viewer-link`: `{ url }` relativa a `/v1/sandbox/vt/<token>/vnc.html?...&path=<caminho do WebSocket>`.
// O app NÃO usa a rota HTTP `vt` (nem o token dela): só o `path=`, que leva o token de propósito `ws`
// (`v1/sandbox/sessions/<id>/viewer/websockify?t=<token>`). Daqui sai o endereço `wss://` para o noVNC próprio.
import { viewerSocketOrigin } from "./viewer-origin";

const WS_PATH = /^v1\/sandbox\/sessions\/([^/?#]+)\/viewer\/websockify\?t=([A-Za-z0-9._~-]+)$/;

/**
 * Endereço do WebSocket (`wss://host/v1/sandbox/sessions/<id>/viewer/websockify?t=…`) a partir da `url` relativa do
 * servidor. Null se o formato não for o esperado, se a sessão do caminho não for `sessionId` ou se o servidor salvo não
 * servir como origem. O token do `vt` (caminho HTTP) é descartado aqui.
 */
export function parseViewerSocketUrl(baseUrl: string, sessionId: string, relativeUrl: unknown): string | null {
	if (typeof relativeUrl !== "string" || !relativeUrl.startsWith("/v1/sandbox/vt/")) return null;
	const origin = viewerSocketOrigin(baseUrl);
	if (!origin) return null;
	let path: string | null;
	try {
		path = new URL(relativeUrl, "http://app.invalid").searchParams.get("path");
	} catch {
		return null;
	}
	const match = path ? WS_PATH.exec(path) : null;
	if (!match) return null;
	let id: string;
	try {
		id = decodeURIComponent(match[1] as string);
	} catch {
		return null;
	}
	if (id !== sessionId) return null;
	return `${origin}/${path}`;
}
