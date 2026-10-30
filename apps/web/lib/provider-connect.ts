import { activeT } from "@/lib/i18n/active";

export type ProviderPopup = {
	closed: boolean;
	location: { href: string; search: string; pathname?: string; origin?: string };
	close: () => void;
};

/** Página do web para onde o callback do login redireciona (estado, fechar e avisar o Atlas). */
export const PROVIDER_CALLBACK_PATH = "/providers/callback";
/** Mensagens popup → Atlas (mesma origem). Nunca carregam token, code ou state. */
export const PROVIDER_CONNECTED_MESSAGE = "atlas:provider-connected";
export const PROVIDER_RETRY_MESSAGE = "atlas:provider-retry";

/** A janela é criada pelo clique, antes de esperar a API (evita popup bloqueado). */
export async function navigateProviderPopup(popup: ProviderPopup | null, connect: () => Promise<{ authorizeUrl: string }>): Promise<void> {
	if (!popup) throw new Error(activeT("errors.allowPopups"));
	try {
		const { authorizeUrl } = await connect();
		const url = new URL(authorizeUrl);
		if (url.origin !== "https://auth.openai.com") throw new Error(activeT("errors.openChatgptLogin"));
		popup.location.href = url.href;
	} catch {
		popup.close();
		throw new Error(activeT("errors.startChatgptLogin"));
	}
}
/** Com `pathname`, só vale na página de retorno (ou na home, de callbacks antigos). */
export function providerCallbackStatus(search: string, pathname?: string): "ok" | "error" | null {
	if (pathname !== undefined && pathname !== PROVIDER_CALLBACK_PATH && pathname !== "/") return null;
	const query = new URLSearchParams(search);
	if (query.get("provider") !== "chatgpt") return null;
	return query.get("status") === "ok" ? "ok" : query.get("status") === "error" ? "error" : null;
}
export function notifyProvidersChanged() {
	window.dispatchEvent(new Event("atlas:providers-changed"));
}

/** Só identificadores curtos de erro (`authorization_failed`, `invalid_token_response:scope`). */
const SAFE_ERROR_CODE = /^[a-z0-9_]{1,40}(:[a-z0-9_]{1,40})?$/;

export type ProviderCallbackParams = { status: "ok" | "error"; code: string | null };

/** Lê `?provider=&status=&code=` da página de retorno; ausente ou inválido vira erro genérico. */
export function parseProviderCallbackParams(
	params: Record<string, string | string[] | undefined>,
): ProviderCallbackParams {
	const one = (name: string) => (typeof params[name] === "string" ? (params[name] as string) : undefined);
	const code = one("code");
	const status = one("provider") === "chatgpt" && one("status") === "ok" ? "ok" : "error";
	return { status, code: code && SAFE_ERROR_CODE.test(code) ? code : null };
}

/**
 * Mensagem recebida por `window.addEventListener("message")`: só da própria origem
 * (e, se informado, do popup que o Atlas abriu) e só com os tipos conhecidos.
 */
export function providerMessageKind(
	event: { origin: string; data: unknown; source?: unknown },
	expectedOrigin: string,
	popup?: unknown,
): "connected" | "retry" | null {
	if (event.origin !== expectedOrigin) return null;
	if (popup && event.source !== popup) return null;
	const data = event.data as { type?: unknown; provider?: unknown } | null;
	if (!data || typeof data !== "object" || data.provider !== "chatgpt") return null;
	if (data.type === PROVIDER_CONNECTED_MESSAGE) return "connected";
	if (data.type === PROVIDER_RETRY_MESSAGE) return "retry";
	return null;
}
