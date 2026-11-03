// Ponte entre o app e a página do viewer (noVNC na WebView). Mensagens tipadas e validadas nos dois sentidos; nada de
// detalhe de erro nem de endereço passa daqui (o token do WebSocket só viaja app → página, e nunca é logado).

/** Página → app. Só estes formatos valem; qualquer outra coisa é ignorada. */
export type BridgeEvent =
	| { t: "ready" }
	| { t: "connected" }
	| { t: "disconnected"; clean: boolean }
	| { t: "securityfailure" }
	| { t: "credentialsrequired" }
	| { t: "error" };

const SIMPLE = new Set(["ready", "connected", "securityfailure", "credentialsrequired", "error"]);

/** Valida a mensagem crua da WebView (`onMessage`). Malformada, de tipo desconhecido ou com tipo errado vira null. */
export function parseBridgeMessage(raw: unknown): BridgeEvent | null {
	if (typeof raw !== "string" || raw.length > 200) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const { t, clean } = value as { t?: unknown; clean?: unknown };
	if (typeof t !== "string") return null;
	if (t === "disconnected") return typeof clean === "boolean" ? { t, clean } : null;
	if (SIMPLE.has(t)) return { t } as BridgeEvent;
	return null;
}

export type BridgeMethod = "connect" | "setViewOnly" | "keys" | "disconnect";

/**
 * App → página: o JavaScript que chama `window.__bridge.<método>(...args)` (via `injectJavaScript`). Os argumentos vão
 * como JSON, nunca montados à mão no texto; o endereço do WebSocket com token só passa por aqui, nunca na URL da página.
 */
export function bridgeCall(method: BridgeMethod, ...args: unknown[]): string {
	return `window.__bridge&&window.__bridge.${method}.apply(null,${JSON.stringify(args)});true;`;
}
