import { isBotLanguage } from "@workspace/shared";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

/**
 * Idioma detectado por conta e por conversa (bot com idioma "auto"). Tudo é escopado pelo `userId` da sessão/run:
 * a conversa só é lida ou gravada se for do mesmo usuário, e a linha de `UserSettings` é a dele (`userId` único).
 */

/** Estado gravado: o idioma confirmado e o candidato que ainda espera a segunda confirmação. */
export type StoredLanguageState = { last: string | null; pending: string | null };

export type LanguageStates = {
	user: StoredLanguageState;
	/** `null` = sem conversa informada ou conversa que não é deste usuário. */
	conversation: StoredLanguageState | null;
	uiLocale: string | null;
	browserLocale: string | null;
};

const EMPTY: StoredLanguageState = { last: null, pending: null };

export async function readLanguageStates(userId: string | undefined, conversationId?: string | null): Promise<LanguageStates> {
	const [owner] = ownerIds(userId);
	if (!owner) return { user: EMPTY, conversation: null, uiLocale: null, browserLocale: null };
	const [settings, conversation] = await Promise.all([
		prisma.userSettings.findUnique({ where: { userId: owner }, select: { lastLanguage: true, pendingLanguage: true, uiLocale: true, browserLocale: true } }),
		conversationId
			? prisma.conversation.findFirst({ where: { id: conversationId, userId: owner }, select: { lastLanguage: true, pendingLanguage: true } })
			: Promise.resolve(null),
	]);
	return {
		user: { last: settings?.lastLanguage ?? null, pending: settings?.pendingLanguage ?? null },
		conversation: conversation ? { last: conversation.lastLanguage, pending: conversation.pendingLanguage } : null,
		uiLocale: settings?.uiLocale ?? null,
		browserLocale: settings?.browserLocale ?? null,
	};
}

/**
 * O que o resolvedor de idioma precisa: o último idioma (da conversa, senão da conta) e o locale da conta
 * (escolhido na interface, senão o do navegador). Nunca lança: sem banco, volta vazio e vale o padrão.
 */
export async function getLanguageContext(
	userId: string | undefined,
	conversationId?: string | null,
): Promise<{ lastLanguage: string | null; accountLocale: string | null }> {
	try {
		const states = await readLanguageStates(userId, conversationId);
		return {
			lastLanguage: states.conversation?.last ?? states.user.last,
			accountLocale: states.uiLocale ?? states.browserLocale,
		};
	} catch (error) {
		console.error("language context load failed; using defaults", error);
		return { lastLanguage: null, accountLocale: null };
	}
}

const clean = (value: string | null | undefined): string | null => (isBotLanguage(value) ? value : null);

/** Grava só o que veio (`undefined` não toca). Idioma fora do registro é gravado como vazio. */
export async function writeLanguageStates(input: {
	userId: string | undefined;
	conversationId?: string | null;
	user?: StoredLanguageState;
	conversation?: StoredLanguageState;
	browserLocale?: string | null;
}): Promise<void> {
	const [owner] = ownerIds(input.userId);
	if (!owner) return;
	const browserLocale = clean(input.browserLocale);
	if (input.user || browserLocale) {
		const data = {
			...(input.user ? { lastLanguage: clean(input.user.last), pendingLanguage: clean(input.user.pending) } : {}),
			...(browserLocale ? { browserLocale } : {}),
		};
		await prisma.userSettings.upsert({ where: { userId: owner }, create: { userId: owner, ...data }, update: data });
	}
	if (input.conversation && input.conversationId) {
		await prisma.conversation.updateMany({
			where: { id: input.conversationId, userId: owner },
			data: { lastLanguage: clean(input.conversation.last), pendingLanguage: clean(input.conversation.pending) },
		});
	}
}
