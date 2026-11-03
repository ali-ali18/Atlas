import AsyncStorage from "@react-native-async-storage/async-storage";
import { INSTALLED_PREFIX, parseInstalled, recordInstall, type InstalledMap } from "./catalog-installed";
import type { CacheStorage } from "./home-cache";

/** Lê o mapa guardado no aparelho; falha de armazenamento vira mapa vazio (só se perde o "Instalado"). */
export async function loadInstalled(key: string): Promise<InstalledMap> {
	try {
		return parseInstalled(await AsyncStorage.getItem(key));
	} catch {
		return {};
	}
}

export async function saveInstall(key: string, slug: string, botId: string): Promise<void> {
	try {
		await AsyncStorage.setItem(key, JSON.stringify(recordInstall(await loadInstalled(key), slug, botId)));
	} catch {
		// sem armazenamento: o bot foi criado do mesmo jeito; só não aparece como "Instalado"
	}
}

/** Apaga o "Instalado" de todas as contas ao sair (como o cache da home e o das conversas). `false` se o armazenamento falhou. */
export async function clearInstalled(storage: CacheStorage): Promise<boolean> {
	try {
		const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(INSTALLED_PREFIX));
		await Promise.all(keys.map((key) => storage.removeItem(key)));
		return true;
	} catch {
		return false;
	}
}
