import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import type { AtlasAuthClient } from "@/lib/auth-client";
import {
	appReturnUrl,
	bridgeExchangeUrl,
	createGoogleBridge,
	expoGoReturnUrl,
	base64UrlFromBase64,
	newBridgeState,
	newCodeVerifier,
	type PendingLogin,
	type PendingStore,
} from "@/lib/google-bridge";
import { describeLink } from "@/lib/login-trace";
import { loginTrace } from "@/lib/login-trace-store";

const PENDING_KEY = "atlas.google-login";

/** A tentativa em curso fica no cofre: se o Expo Go recarregar o app ao receber o link, a nova execução a retoma. */
const pendingStore: PendingStore = {
	async save(pending) {
		const raw = JSON.stringify(pending);
		if (Platform.OS === "web") globalThis.localStorage?.setItem(PENDING_KEY, raw);
		else await SecureStore.setItemAsync(PENDING_KEY, raw);
	},
	async load() {
		try {
			const raw = Platform.OS === "web" ? globalThis.localStorage?.getItem(PENDING_KEY) : await SecureStore.getItemAsync(PENDING_KEY);
			if (!raw) return null;
			const value = JSON.parse(raw) as Partial<PendingLogin>;
			return typeof value.state === "string" && typeof value.verifier === "string" && typeof value.at === "number"
				? { state: value.state, verifier: value.verifier, at: value.at }
				: null;
		} catch {
			return null;
		}
	},
	async clear() {
		try {
			if (Platform.OS === "web") globalThis.localStorage?.removeItem(PENDING_KEY);
			else await SecureStore.deleteItemAsync(PENDING_KEY);
		} catch {
			// sem cofre: a tentativa vence sozinha no prazo
		}
	},
};

/** Liga o núcleo (lib/google-bridge.ts) ao navegador, ao cofre e ao cliente de autenticação do servidor. */
export function createGoogleLogin(client: AtlasAuthClient, serverUrl: string) {
	// Último recurso no Expo Go: o link da própria atualização carregada (`exp://u.expo.dev/update/<id>`), formato que o
	// Expo Go abre sem query. O link do canal (`?channel-name=…`) não serve: o Expo Go corta tudo depois de `/--/` ao
	// achar o projeto, perde o canal e falha ao baixar ("Something went wrong").
	const updateId = Constants.manifest2?.id;
	const updateLink = updateId && /^[0-9a-f-]{36}$/i.test(updateId) ? `exp://u.expo.dev/update/${updateId}` : null;
	const expoGoLinks = [Constants.linkingUri, Constants.experienceUrl, updateLink];

	/**
	 * No Expo Go do SDK 58 uma atualização publicada se apresenta como "bare" e sem `linkingUri`, então não dá para
	 * confiar no ambiente. Pergunta ao sistema se alguém abre o link do app (`atlas://`): no app instalado sim; no
	 * Expo Go ninguém, e a volta vai pelo link `exp://`.
	 */
	async function resolveReturnUrl(): Promise<string> {
		const appUrl = appReturnUrl(Linking.createURL);
		const appSchemeOpens = await Linking.canOpenURL(appUrl).catch(() => false);
		const expoGoUrl = expoGoReturnUrl(!appSchemeOpens, expoGoLinks);
		loginTrace.add(
			`ambiente: ${String(Constants.executionEnvironment)} · versão ${String(Constants.manifest2?.id ?? "?").slice(0, 8)} · ${describeLink(appUrl)} abre: ${appSchemeOpens ? "sim" : "não"} · links: ${expoGoLinks.map(describeLink).join(" | ")}`,
		);
		return expoGoUrl ?? appUrl;
	}

	return createGoogleBridge({
		serverUrl,
		resolveReturnUrl,
		pending: pendingStore,
		// `$fetch` do cliente passa pelo plugin do Expo, que guarda o cookie de sessão do Set-Cookie como no login por código.
		exchange: async (token, verifier) => {
			loginTrace.add("trocando o token no servidor");
			const result = await client.$fetch(bridgeExchangeUrl(serverUrl), { method: "POST", body: { token, code_verifier: verifier } });
			if (result.error) {
				loginTrace.add(`troca recusada: ${result.error.status ?? "?"} ${String(result.error.message ?? "").slice(0, 60)}`);
				return false;
			}
			const session = await client.getSession();
			loginTrace.add(session.data?.user ? "sessão ok" : "troca ok, mas sem sessão no app");
			return Boolean(session.data?.user);
		},
		openAuthSession: async (url, returnUrl) => {
			if (Platform.OS === "android") {
				try {
					WebBrowser.dismissAuthSession();
				} catch {
					// não havia sessão aberta
				}
			}
			// createTask: false abre a aba na mesma tarefa do app; no padrão (nova tarefa) fechar a aba no Expo Go
			// deixava o usuário na tela inicial do Expo Go em vez de no app.
			loginTrace.add(`abrindo navegador, volta para ${describeLink(returnUrl)}`);
			try {
				const result = await WebBrowser.openAuthSessionAsync(url, returnUrl, { createTask: false });
				loginTrace.add(`navegador fechou: ${result.type}${"url" in result && result.url ? ` ${describeLink(result.url)}` : ""}`);
				return result;
			} catch (error) {
				loginTrace.add(`navegador falhou: ${error instanceof Error ? error.message.slice(0, 80) : "?"}`);
				throw error;
			}
		},
		randomVerifier: () => newCodeVerifier(Crypto.getRandomBytes(32)),
		challengeOf: async (verifier) =>
			base64UrlFromBase64(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 })),
		randomState: () => newBridgeState(Crypto.getRandomBytes(16)),
		now: Date.now,
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	});
}

