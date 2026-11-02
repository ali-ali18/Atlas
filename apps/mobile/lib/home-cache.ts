// Cache local da home (AsyncStorage, que roda no Expo Go): abre na hora com o último resultado e a rede
// atualiza por cima. A chave leva o servidor e a conta, então trocar de conta nunca mostra a lista da outra,
// e `clearHomeCache` apaga tudo ao sair. Só vai para o disco o que a home desenha (`HomeBot`): sem política,
// descrição nem texto inteiro de mensagem, porque o armazenamento do app não é criptografado.
import type { HomeBot, HomeSnapshot, SectionRef } from "./home-types";

export type CacheStorage = {
	getItem: (key: string) => Promise<string | null>;
	setItem: (key: string, value: string) => Promise<void>;
	removeItem: (key: string) => Promise<void>;
	getAllKeys: () => Promise<readonly string[]>;
};

export type CachedHome = { snapshot: HomeSnapshot; savedAt: number };

/** Versão do formato. A v1 guardava o `Bot` inteiro; é descartada na leitura e some no próximo salvamento. */
export const CACHE_VERSION = 2;
/** Tudo que é da home, de qualquer versão (a limpeza ao sair apaga também as chaves antigas). */
const ALL_VERSIONS_PREFIX = "atlas.home.";
const PREFIX = `${ALL_VERSIONS_PREFIX}v${CACHE_VERSION}:`;
/** Cache mais velho que isto ainda abre a tela (a rede atualiza), mas não vale mais que um mês. */
export const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const cacheKey = (serverUrl: string, email: string) => `${PREFIX}${serverUrl}|${email.toLowerCase()}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isNullable = <T>(value: unknown, check: (item: unknown) => item is T): value is T | null => value === null || check(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function pickBot(value: unknown): HomeBot | null {
	if (!isRecord(value)) return null;
	const { id, name, color, shape, pinned, pinOrder, sectionId, memberIds, isPrimary, unread, lastAt, preview, previewSent } = value;
	// Cache gravado antes de existir `conversationId` continua valendo: o campo ausente é `null`.
	const conversationId = value.conversationId === undefined ? null : value.conversationId;
	if (!isNullable(conversationId, isString)) return null;
	const language = value.language === undefined ? null : value.language;
	if (!isNullable(language, isString)) return null;
	if (!isString(id) || !isString(name) || !isString(color) || !isString(shape) || !isString(preview)) return null;
	if (typeof pinned !== "boolean" || typeof isPrimary !== "boolean" || typeof unread !== "boolean" || typeof previewSent !== "boolean") return null;
	if (!isNullable(pinOrder, isNumber) || !isNullable(sectionId, isString) || !isNullable(lastAt, isString)) return null;
	if (!Array.isArray(memberIds) || !memberIds.every(isString)) return null;
	// Reconstrói campo a campo: qualquer chave a mais que esteja no disco não passa.
	return { id, name, color, shape, pinned, pinOrder, sectionId, memberIds: [...memberIds], isPrimary, conversationId, language, unread, lastAt, preview, previewSent };
}

function pickSection(value: unknown): SectionRef | null {
	if (!isRecord(value) || !isString(value.id) || !isString(value.name) || !isNumber(value.order)) return null;
	return { id: value.id, name: value.name, order: value.order };
}

export function serializeCache(snapshot: HomeSnapshot, now: number): string {
	const bots = snapshot.bots.map((bot) => pickBot(bot)).filter((bot): bot is HomeBot => bot !== null);
	const sections = snapshot.sections.map((section) => pickSection(section)).filter((section): section is SectionRef => section !== null);
	return JSON.stringify({ v: CACHE_VERSION, savedAt: now, bots, sections });
}

/** Lê o que `serializeCache` gravou; texto estranho, outra versão ou muito antigo viram `null`. */
export function parseCache(raw: string | null, now: number): CachedHome | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; bots?: unknown; sections?: unknown } | null;
		if (!data || data.v !== CACHE_VERSION || typeof data.savedAt !== "number") return null;
		if (now - data.savedAt > CACHE_MAX_AGE_MS) return null;
		if (!Array.isArray(data.bots) || !Array.isArray(data.sections)) return null;
		const bots = data.bots.map(pickBot).filter((bot): bot is HomeBot => bot !== null);
		const sections = data.sections.map(pickSection).filter((section): section is SectionRef => section !== null);
		return { snapshot: { bots, sections }, savedAt: data.savedAt };
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

/** Apaga o cache da home de todas as contas e versões. Devolve `false` se o armazenamento falhou (nunca lança). */
export async function clearHomeCache(storage: CacheStorage): Promise<boolean> {
	try {
		const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(ALL_VERSIONS_PREFIX));
		await Promise.all(keys.map((key) => storage.removeItem(key)));
		return true;
	} catch {
		return false;
	}
}
