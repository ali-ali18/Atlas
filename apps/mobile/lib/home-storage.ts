import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearInstalled } from "./catalog-installed-store";
import { clearChatCache } from "./chat-cache";
import { clearHomeCache, type CacheStorage } from "./home-cache";

export const homeStorage: CacheStorage = AsyncStorage as unknown as CacheStorage;

/** Apaga o cache da home e o das conversas e, se falhar, só registra que falhou (nada de nomes, e-mails nem mensagens no log). */
export async function clearHomeCacheLogged(storage: CacheStorage = homeStorage): Promise<void> {
	const [home, chats, catalog] = await Promise.all([clearHomeCache(storage), clearChatCache(storage), clearInstalled(storage)]);
	if (!home) console.warn("Não consegui apagar o cache da home deste aparelho.");
	if (!chats) console.warn("Não consegui apagar o cache das conversas deste aparelho.");
	if (!catalog) console.warn("Não consegui apagar o que o catálogo lembra neste aparelho.");
}
