// Cache local da home (AsyncStorage, que roda no Expo Go): abre na hora com o último resultado e a rede
// atualiza por cima. A chave leva o servidor e a conta, então trocar de conta nunca mostra a lista da outra,
// e `clearHomeCache` apaga tudo ao sair.
import type { HomeSnapshot } from "./home-sync";
import { parseSnapshot } from "./home-sync";

export type CacheStorage = {
	getItem: (key: string) => Promise<string | null>;
	setItem: (key: string, value: string) => Promise<void>;
	removeItem: (key: string) => Promise<void>;
	getAllKeys: () => Promise<readonly string[]>;
};

export type CachedHome = { snapshot: HomeSnapshot; savedAt: number };

const PREFIX = "atlas.home.v1:";
/** Cache mais velho que isto ainda abre a tela (a rede atualiza), mas não vale mais que um mês. */
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const cacheKey = (serverUrl: string, email: string) => `${PREFIX}${serverUrl}|${email.toLowerCase()}`;

export function serializeCache(snapshot: HomeSnapshot, now: number): string {
	return JSON.stringify({ v: 1, savedAt: now, bots: snapshot.bots, sections: snapshot.sections });
}

/** Lê o que `serializeCache` gravou; texto estranho, outra versão ou muito antigo viram `null`. */
export function parseCache(raw: string | null, now: number): CachedHome | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; bots?: unknown; sections?: unknown } | null;
		if (!data || data.v !== 1 || typeof data.savedAt !== "number") return null;
		if (now - data.savedAt > CACHE_MAX_AGE_MS) return null;
		const snapshot = parseSnapshot({ bots: data.bots }, { sections: data.sections });
		return snapshot ? { snapshot, savedAt: data.savedAt } : null;
	} catch {
		return null;
	}
}

export async function loadHomeCache(storage: CacheStorage, key: string, now: number): Promise<CachedHome | null> {
	try {
		return parseCache(await storage.getItem(key), now);
	} catch {
		return null;
	}
}

export async function saveHomeCache(storage: CacheStorage, key: string, snapshot: HomeSnapshot, now: number): Promise<void> {
	try {
		await storage.setItem(key, serializeCache(snapshot, now));
	} catch {
		// cache é só conveniência: disco cheio ou bloqueado não pode quebrar a tela
	}
}

export async function clearHomeCache(storage: CacheStorage): Promise<void> {
	try {
		const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(PREFIX));
		await Promise.all(keys.map((key) => storage.removeItem(key)));
	} catch {
		// idem
	}
}
