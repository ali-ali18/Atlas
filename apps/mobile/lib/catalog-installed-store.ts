import AsyncStorage from "@react-native-async-storage/async-storage";
import { INSTALLED_KEY, parseInstalled, recordInstall, type InstalledMap } from "./catalog-installed";

/** Lê o mapa guardado no aparelho; falha de armazenamento vira mapa vazio (só se perde o "Instalado"). */
export async function loadInstalled(): Promise<InstalledMap> {
	try {
		return parseInstalled(await AsyncStorage.getItem(INSTALLED_KEY));
	} catch {
		return {};
	}
}

export async function saveInstall(slug: string, botId: string): Promise<void> {
	try {
		await AsyncStorage.setItem(INSTALLED_KEY, JSON.stringify(recordInstall(await loadInstalled(), slug, botId)));
	} catch {
		// sem armazenamento: o bot foi criado do mesmo jeito; só não aparece como "Instalado"
	}
}
