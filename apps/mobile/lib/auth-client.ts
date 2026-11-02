import { expoClient, type ExpoClientStorage } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/** Esquema do app (app.json). O servidor confia em `atlas://` sempre e em `exp://` só com ATLAS_TRUST_EXPO_GO=1. */
export const APP_SCHEME = "atlas";

/** No web (só nas prévias) o cofre não existe: cai para localStorage, com a mesma interface do SecureStore. */
const webStorage: ExpoClientStorage = {
	getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
	setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
	getItemAsync: async (key) => globalThis.localStorage?.getItem(key) ?? null,
	setItemAsync: async (key, value) => globalThis.localStorage?.setItem(key, value),
};

/**
 * Cliente de autenticação do servidor salvo na tela de Conexão. A sessão (cookie do better-auth) fica no
 * `expo-secure-store`, nunca em log. Criar de novo quando o endereço mudar.
 */
export function createAtlasAuthClient(baseURL: string) {
	return createAuthClient({
		baseURL,
		plugins: [
			expoClient({
				scheme: APP_SCHEME,
				storagePrefix: "atlas",
				storage: Platform.OS === "web" ? webStorage : SecureStore,
			}),
			emailOTPClient(),
		],
	});
}

export type AtlasAuthClient = ReturnType<typeof createAtlasAuthClient>;
