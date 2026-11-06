// Leitura do que o v4 mostra e muda em "Configurações" do bot pelo chat (porta `Settings`, F2.6). Arquivo aditivo:
// a escrita passa por `updateBot` (já escopada por dono); aqui só a leitura que ele não oferece (inclui `notify`).
import { ownerIds } from "./mcp-connections.js";
import { prisma } from "./client.js";

export type AgentV4BotSettingsRow = { name: string; snippet: string; description: string | null; language: string; notify: boolean };

/** Configurações do bot SÓ se o bot for do dono. Bot de outro dono e id inexistente dão o mesmo `null`. */
export async function getAgentV4BotSettings(userId: string, botId: string): Promise<AgentV4BotSettingsRow | null> {
	if (!botId || ownerIds(userId).length === 0) return null;
	const row = await prisma.bot.findFirst({
		where: { id: botId, ownerId: { in: ownerIds(userId) } },
		select: { name: true, snippet: true, description: true, language: true, notify: true },
	});
	return row ?? null;
}
