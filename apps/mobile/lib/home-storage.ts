import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearChatCache } from "./chat-cache";
import { clearHomeCache, type CacheStorage } from "./home-cache";

export const homeStorage: CacheStorage = AsyncStorage as unknown as CacheStorage;

/** Apaga o cache da home e o das conversas e, se falhar, só registra que falhou (nada de nomes, e-mails nem mensagens no log). */
export async function clearHomeCacheLogged(storage: CacheStorage = homeStorage): Promise<void> {
	const [home, chats] = await Promise.all([clearHomeCache(storage), clearChatCache(storage)]);
	if (!home) console.warn("Não consegui apagar o cache da home deste aparelho.");
	if (!chats) console.warn("Não consegui apagar o cache das conversas deste aparelho.");
}
