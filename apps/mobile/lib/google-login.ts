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
	newBridgeState,
	type PendingLogin,
	type PendingStore,
} from "@/lib/google-bridge";

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
			return typeof value.state === "string" && typeof value.at === "number" ? { state: value.state, at: value.at } : null;
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
	return createGoogleBridge({
		serverUrl,
		returnUrl: appReturnUrl(Linking.createURL),
		pending: pendingStore,
		// `$fetch` do cliente passa pelo plugin do Expo, que guarda o cookie de sessão do Set-Cookie como no login por código.
		exchange: async (token) => {
			const result = await client.$fetch(bridgeExchangeUrl(serverUrl), { method: "POST", body: { token } });
			if (result.error) return false;
			const session = await client.getSession();
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
			return WebBrowser.openAuthSessionAsync(url, returnUrl, { createTask: false });
		},
		randomState: () => newBridgeState(Crypto.getRandomBytes(16)),
		now: Date.now,
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	});
}

