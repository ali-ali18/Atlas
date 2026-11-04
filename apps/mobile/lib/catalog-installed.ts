// "Instalado": o servidor não guarda de qual modelo do catálogo veio cada bot, então o app lembra, neste aparelho, o
// bot criado a partir de cada modelo. Vale como instalado só enquanto o bot ainda está na home (apagou? volta a
// "Instalar"). Funções puras (testadas em catalog.test.ts); a leitura e a escrita ficam em `catalog-installed-store.ts`.

/** slug do modelo -> ids dos bots criados a partir dele neste aparelho. */
export type InstalledMap = Record<string, string[]>;

/** Tudo do catálogo no aparelho (a limpeza ao sair apaga todas as contas e versões). */
export const INSTALLED_PREFIX = "atlas.catalog.";

/** Uma chave por servidor e conta: trocar de conta não mostra o "Instalado" da outra (mesmo molde de `cacheKey` da home). */
export const installedKey = (serverUrl: string, email: string): string => `${INSTALLED_PREFIX}installed.v1:${serverUrl}|${email.toLowerCase()}`;

/** Aceita só `{ slug: [id, ...] }`; qualquer outra coisa (cache velho, texto torto) vira mapa vazio. */
export function parseInstalled(raw: string | null): InstalledMap {
	if (!raw) return {};
	try {
		const data: unknown = JSON.parse(raw);
		if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
		const map: InstalledMap = {};
		for (const [slug, ids] of Object.entries(data)) {
			if (!Array.isArray(ids)) continue;
			const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
			if (clean.length > 0) map[slug] = clean;
		}
		return map;
	} catch {
		return {};
	}
}

export function recordInstall(map: InstalledMap, slug: string, botId: string): InstalledMap {
	const ids = map[slug] ?? [];
	return ids.includes(botId) ? map : { ...map, [slug]: [...ids, botId] };
}

/** Slugs com pelo menos um bot que ainda existe na home. */
export function installedSlugs(map: InstalledMap, botIds: readonly string[]): Set<string> {
	const alive = new Set(botIds);
	return new Set(Object.entries(map).filter(([, ids]) => ids.some((id) => alive.has(id))).map(([slug]) => slug));
}
