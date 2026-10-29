import { getBotProfile, resolveStoredReplyLanguage } from "@workspace/db";
import type { BotLanguage } from "@workspace/shared";

/**
 * Idioma dos textos de sistema (limite, erro, retomada) de um run já gravado: o do bot, ou em "auto" o último idioma
 * da conversa/conta. Melhor esforço: qualquer falha de leitura volta ao padrão pt-BR, nunca impede o fechamento do run.
 */
export async function runSystemLanguage(run: { userId?: string | null; botId?: string | null; conversationId?: string | null } | null | undefined): Promise<BotLanguage> {
	if (!run?.userId) return "pt-BR";
	try {
		const profile = run.botId ? await getBotProfile(run.botId, run.userId) : null;
		return (await resolveStoredReplyLanguage({ userId: run.userId, conversationId: run.conversationId, setting: profile?.language })).language;
	} catch {
		return "pt-BR";
	}
}
