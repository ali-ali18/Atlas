import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "atlas.server-url";

/** No web (só usado nas prévias) o SecureStore não existe: cai para localStorage. */
export async function loadServerUrl(): Promise<string | null> {
	try {
		if (Platform.OS === "web") return globalThis.localStorage?.getItem(KEY) ?? null;
		return await SecureStore.getItemAsync(KEY);
	} catch {
		return null;
	}
}

export async function saveServerUrl(url: string): Promise<void> {
	if (Platform.OS === "web") {
		globalThis.localStorage?.setItem(KEY, url);
		return;
	}
	await SecureStore.setItemAsync(KEY, url);
}

/** Esquece o servidor guardado (o botão de voltar do login volta para a conexão sem endereço). */
export async function clearServerUrl(): Promise<void> {
	try {
		if (Platform.OS === "web") {
			globalThis.localStorage?.removeItem(KEY);
			return;
		}
		await SecureStore.deleteItemAsync(KEY);
	} catch {
		// sem o cofre não há o que limpar
	}
}
