import { BOT_LANGUAGE_AUTO, isBotLanguage, nextLanguageMemory, parseBotLanguageSetting, resolveReplyLanguage, toLanguageMemory, type BotLanguage, type ReplyLanguage } from "@workspace/shared";
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

/** Tentativas do compare-and-set: a primeira e uma repetição com o estado recém-lido. */
const RECORD_ATTEMPTS = 2;

/** Grava o estado do usuário só se a linha ainda tem o valor lido (`null` casa com vazio). `false` = outro envio se adiantou. */
async function casUserLanguage(owner: string, prev: StoredLanguageState, next: StoredLanguageState): Promise<boolean> {
	const data = { lastLanguage: clean(next.last), pendingLanguage: clean(next.pending) };
	const updated = await prisma.userSettings.updateMany({
		where: { userId: owner, lastLanguage: clean(prev.last), pendingLanguage: clean(prev.pending) },
		data,
	});
	if (updated.count > 0) return true;
	// Sem linha ainda: cria. Se outro envio criou antes (userId único), conta como disputa perdida.
	const exists = await prisma.userSettings.findUnique({ where: { userId: owner }, select: { userId: true } });
	if (exists) return false;
	try {
		await prisma.userSettings.create({ data: { userId: owner, ...data } });
		return true;
	} catch {
		return false;
	}
}

async function casConversationLanguage(owner: string, conversationId: string, prev: StoredLanguageState, next: StoredLanguageState): Promise<boolean> {
	const updated = await prisma.conversation.updateMany({
		where: { id: conversationId, userId: owner, lastLanguage: clean(prev.last), pendingLanguage: clean(prev.pending) },
		data: { lastLanguage: clean(next.last), pendingLanguage: clean(next.pending) },
	});
	return updated.count > 0;
}

/**
 * Mensagem que o usuário escreveu: atualiza o último idioma da conversa e da conta (regras em
 * `nextLanguageMemory`: só com confiança alta e confirmação). Melhor esforço: nunca lança nem atrasa o envio por erro.
 * Só para texto digitado pelo usuário (nunca prompt do sistema, rotina, e-mail ou mensagem de outro bot).
 *
 * Ler-calcular-gravar com compare-and-set: dois envios simultâneos não se atropelam (o segundo relê e recalcula
 * uma vez). Se perder a disputa de novo, desiste em silêncio: o único custo é a troca de idioma chegar uma
 * mensagem depois.
 */
export async function recordUserLanguage(input: { userId: string | undefined; conversationId?: string | null; text: string }): Promise<void> {
	try {
		const [owner] = ownerIds(input.userId);
		if (!owner || !input.text.trim()) return;
		for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
			const states = await readLanguageStates(owner, input.conversationId);
			const user = nextLanguageMemory(toLanguageMemory(states.user), input.text);
			const conversation = states.conversation ? nextLanguageMemory(toLanguageMemory(states.conversation), input.text) : null;
			if (!user.changed && !conversation?.changed) return;
			let lost = false;
			if (user.changed) lost = !(await casUserLanguage(owner, toLanguageMemory(states.user), user.memory));
			if (conversation?.changed && input.conversationId) {
				lost = !(await casConversationLanguage(owner, input.conversationId, toLanguageMemory(states.conversation!), conversation.memory)) || lost;
			}
			if (!lost) return;
		}
	} catch (error) {
		console.error("record user language failed; ignoring", error);
	}
}

/** Idioma do navegador (Accept-Language) visto no envio: pista para quem ainda não tem idioma detectado. Grava só se mudou. */
export async function noteBrowserLanguage(userId: string | undefined, language: BotLanguage | null): Promise<void> {
	try {
		const [owner] = ownerIds(userId);
		if (!owner || !language) return;
		const current = await prisma.userSettings.findUnique({ where: { userId: owner }, select: { browserLocale: true } });
		if (current?.browserLocale === language) return;
		await writeLanguageStates({ userId: owner, browserLocale: language });
	} catch (error) {
		console.error("note browser language failed; ignoring", error);
	}
}

/**
 * Idioma para texto que o sistema escreve sem mensagem do usuário na vez (resumo, compactação, revisão de memória,
 * lições, skills, reflexão): o do bot se for fixo; em "auto", o último idioma detectado (conversa, depois conta),
 * depois o locale da conta, depois pt-BR. Bot fixo não toca o banco.
 */
export async function resolveStoredReplyLanguage(input: { userId?: string; conversationId?: string | null; setting: unknown }): Promise<ReplyLanguage> {
	const setting = parseBotLanguageSetting(input.setting);
	if (setting !== BOT_LANGUAGE_AUTO) return resolveReplyLanguage({ setting, hasUserMessage: false });
	return resolveReplyLanguage({ setting, ...(await getLanguageContext(input.userId, input.conversationId)), hasUserMessage: false });
}
