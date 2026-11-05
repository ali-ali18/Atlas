import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { DEFAULT_PREFERENCES, type Preferences, parsePreferences, serializePreferences } from "./preferences";

const KEY = "atlas.preferences";

/** No web (só usado nas prévias) o SecureStore não existe: cai para localStorage. */
export async function loadPreferences(): Promise<Preferences> {
	try {
		const raw = Platform.OS === "web" ? (globalThis.localStorage?.getItem(KEY) ?? null) : await SecureStore.getItemAsync(KEY);
		return parsePreferences(raw);
	} catch {
		return DEFAULT_PREFERENCES;
	}
}

/** Não estoura: sem o cofre a escolha vale até fechar o app. */
export async function savePreferences(preferences: Preferences): Promise<void> {
	try {
		const raw = serializePreferences(preferences);
		if (Platform.OS === "web") globalThis.localStorage?.setItem(KEY, raw);
		else await SecureStore.setItemAsync(KEY, raw);
	} catch {
		// sem o cofre não há onde guardar
	}
}
