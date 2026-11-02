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

/** `code_verifier` PKCE: 32 bytes aleatórios em hexadecimal (64 caracteres, 256 bits). */
export function newCodeVerifier(bytes: Uint8Array): string {
	return newBridgeState(bytes);
}

/** O digest do expo-crypto vem em base64; o servidor espera base64url sem preenchimento. */
export function base64UrlFromBase64(base64: string): string {
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Retorno do login: sempre o deep link do app (atlas:// ou exp:// no Expo Go), nunca o site. */
export function appReturnUrl(createURL: (path: string) => string): string {
	const home = createURL("/");
	if (/^https?:/i.test(home)) throw new Error("O retorno do login precisa ser o link do app, não o site.");
	return home;
}

/** Normaliza um link do Expo Go para a raiz do deep link: `exp://host/caminho/--/` (+ query original). */
function expoGoRoot(link: string | null | undefined): string | null {
	if (!link || !/^exps?:\/\/[^/?#]+/i.test(link)) return null;
	const [base = "", query] = (link.split("#")[0] ?? "").split("?");
	const marker = base.indexOf("/--/");
	const root = marker >= 0 ? base.slice(0, marker) : base.replace(/\/(--)?\/?$/, "");
	return `${root}/--/${query ? `?${query}` : ""}`;
}

/**
 * No Expo Go, uma atualização publicada não tem `hostUri`, e `createURL` cai no esquema do app (`atlas:///`), que o
 * Expo Go não abre: o navegador fica parado na página de volta. Ali o retorno é o primeiro link `exp://` entre os
 * candidatos (`linkingUri`, `experienceUrl`), que reabre este mesmo app. Fora do Expo Go devolve null (vale `createURL`).
 */
export function expoGoReturnUrl(inExpoGo: boolean, candidates: ReadonlyArray<string | null | undefined>): string | null {
	if (!inExpoGo) return null;
	for (const candidate of candidates) {
		const root = expoGoRoot(candidate);
		if (root) return root;
	}
	return null;
}

export function bridgeStartUrl(serverUrl: string, returnUrl: string, state: string, challenge: string): string {
	return `${serverUrl.replace(/\/+$/, "")}${BRIDGE_START_PATH}?return=${encodeURIComponent(returnUrl)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`;
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

export type PendingLogin = { state: string; verifier: string; at: number };

export type PendingStore = {
	save: (pending: PendingLogin) => Promise<void>;
	load: () => Promise<PendingLogin | null>;
	clear: () => Promise<void>;
};

export type BridgeOutcome = "signed-in" | "cancelled" | "failed" | "ignored";

export type BridgeDeps = {
	serverUrl: string;
	/** Link de volta ao app, decidido na hora do toque (pode perguntar ao sistema quem abre o esquema). */
	resolveReturnUrl: () => Promise<string>;
	pending: PendingStore;
	/** Troca o token por sessão no servidor e guarda o cookie. Verdadeiro se a sessão ficou de pé. */
	exchange: (token: string, verifier: string) => Promise<boolean>;
	openAuthSession: (url: string, returnUrl: string) => Promise<{ type: string; url?: string }>;
	randomState: () => string;
	randomVerifier: () => string;
	/** `base64url(sha256(verifier))` (PKCE S256). */
	challengeOf: (verifier: string) => Promise<string>;
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
			return (await deps.exchange(link.token, pending.verifier)) ? "signed-in" : "failed";
		} catch {
			return "failed";
		}
	}

	async function begin(): Promise<BridgeOutcome> {
		const state = deps.randomState();
		const verifier = deps.randomVerifier();
		await deps.pending.save({ state, verifier, at: deps.now() });
		let result: { type: string; url?: string };
		try {
			const challenge = await deps.challengeOf(verifier);
			const returnUrl = await deps.resolveReturnUrl();
			result = await deps.openAuthSession(bridgeStartUrl(deps.serverUrl, returnUrl, state, challenge), returnUrl);
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
