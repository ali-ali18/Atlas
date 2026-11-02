/**
 * Login com Google pela ponte do servidor (rota /api/mobile/auth/*): o app abre `start` no navegador, o servidor
 * volta para uma página HTTPS própria e, dela, o toque em "Voltar para o app" entrega `?token=…&state=…` ao app.
 * Aqui só há lógica pura (links, `state`, decisão do que fazer com o link); os efeitos entram por `BridgeDeps`.
 */

export const BRIDGE_START_PATH = "/api/mobile/auth/start";
export const BRIDGE_EXCHANGE_PATH = "/api/mobile/auth/exchange";
/** O servidor guarda return/state por 10 min; o app esquece a tentativa no mesmo prazo. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** Depois que a aba fecha, o Expo Go às vezes entrega o link pelo listener um instante depois. */
export const LISTENER_GRACE_MS = 1500;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** `state` do app (CSRF): 16 bytes aleatórios em hexadecimal (32 caracteres). */
export function newBridgeState(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Retorno do login: sempre o deep link do app (atlas:// ou exp:// no Expo Go), nunca o site. */
export function appReturnUrl(createURL: (path: string) => string): string {
	const home = createURL("/");
	if (/^https?:/i.test(home)) throw new Error("O retorno do login precisa ser o link do app, não o site.");
	return home;
}

export function bridgeStartUrl(serverUrl: string, returnUrl: string, state: string): string {
	return `${serverUrl.replace(/\/+$/, "")}${BRIDGE_START_PATH}?return=${encodeURIComponent(returnUrl)}&state=${encodeURIComponent(state)}`;
}

export function bridgeExchangeUrl(serverUrl: string): string {
	return `${serverUrl.replace(/\/+$/, "")}${BRIDGE_EXCHANGE_PATH}`;
}

function queryParam(url: string, name: string): string | null {
	const query = url.split("#")[0]?.split("?").slice(1).join("?");
	if (!query) return null;
	for (const pair of query.split("&")) {
		const eq = pair.indexOf("=");
		const key = eq < 0 ? pair : pair.slice(0, eq);
		if (key !== name) continue;
		try {
			return decodeURIComponent(eq < 0 ? "" : pair.slice(eq + 1).replace(/\+/g, " "));
		} catch {
			return null;
		}
	}
	return null;
}

export type BridgeLink = { kind: "token"; token: string } | { kind: "error" } | { kind: "other" };

/**
 * Lê o link que o navegador entregou. Só vale com o `state` desta tentativa; outro `state`, ou link sem token nem
 * erro (o app aberto por outro motivo), é "other" e é ignorado.
 */
export function readBridgeLink(url: string, expectedState: string): BridgeLink {
	if (queryParam(url, "state") !== expectedState) return { kind: "other" };
	const token = queryParam(url, "token");
	if (token !== null) return TOKEN_PATTERN.test(token) ? { kind: "token", token } : { kind: "error" };
	return queryParam(url, "error") !== null ? { kind: "error" } : { kind: "other" };
}

export type PendingLogin = { state: string; at: number };

export type PendingStore = {
	save: (pending: PendingLogin) => Promise<void>;
	load: () => Promise<PendingLogin | null>;
	clear: () => Promise<void>;
};

export type BridgeOutcome = "signed-in" | "cancelled" | "failed" | "ignored";

export type BridgeDeps = {
	serverUrl: string;
	returnUrl: string;
	pending: PendingStore;
	/** Troca o token por sessão no servidor e guarda o cookie. Verdadeiro se a sessão ficou de pé. */
	exchange: (token: string) => Promise<boolean>;
	openAuthSession: (url: string, returnUrl: string) => Promise<{ type: string; url?: string }>;
	randomState: () => string;
	now: () => number;
	wait: (ms: number) => Promise<void>;
};

export function createGoogleBridge(deps: BridgeDeps) {
	/**
	 * Trata um link recebido (resultado do navegador, listener do Linking ou link que abriu o app). A tentativa
	 * pendente é apagada ANTES da troca: o mesmo link chegando por dois caminhos só é usado uma vez.
	 */
	async function handleLink(url: string): Promise<BridgeOutcome> {
		const pending = await deps.pending.load();
		if (!pending || deps.now() - pending.at > PENDING_TTL_MS) return "ignored";
		const link = readBridgeLink(url, pending.state);
		if (link.kind === "other") return "ignored";
		await deps.pending.clear();
		if (link.kind === "error") return "failed";
		try {
			return (await deps.exchange(link.token)) ? "signed-in" : "failed";
		} catch {
			return "failed";
		}
	}

	async function begin(): Promise<BridgeOutcome> {
		const state = deps.randomState();
		await deps.pending.save({ state, at: deps.now() });
		let result: { type: string; url?: string };
		try {
			result = await deps.openAuthSession(bridgeStartUrl(deps.serverUrl, deps.returnUrl, state), deps.returnUrl);
		} catch {
			await deps.pending.clear();
			return "failed";
		}
		if (result.type === "success" && result.url) {
			const outcome = await handleLink(result.url);
			if (outcome !== "ignored") return outcome;
		}
		// A aba fechou sem o link: espera o listener um instante antes de dar por cancelado.
		await deps.wait(LISTENER_GRACE_MS);
		const left = await deps.pending.load();
		if (left?.state !== state) return "ignored";
		await deps.pending.clear();
		return "cancelled";
	}

	return { begin, handleLink };
}
