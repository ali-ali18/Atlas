import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

/** Janela do "núcleo por uso" do motor v3 (desenho 3.2): tools que o bot usou nos últimos 30 dias. */
export const BOT_TOOL_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 200;
const MAX_STEPS = 5_000;

/**
 * Quantas vezes cada tool rodou nos runs deste bot (do mesmo dono) dentro da janela. Lê o diário `agent_steps`
 * (passo `tool`, nome em `inputJson.name`); nunca lê args nem resultado. Sem dono real ou sem bot: vazio.
 * Teto de runs e de passos: é uma dica de ordenação, não uma contagem exata.
 */
export async function listBotToolUsage(input: { userId: string; botId: string; now?: Date; windowMs?: number }): Promise<Record<string, number>> {
	const owners = ownerIds(input.userId);
	if (owners.length === 0 || !input.botId.trim()) return {};
	const since = new Date((input.now ?? new Date()).getTime() - (input.windowMs ?? BOT_TOOL_USAGE_WINDOW_MS));
	const runs = await prisma.agentRun.findMany({
		where: { userId: { in: owners }, botId: input.botId, createdAt: { gte: since } },
		select: { id: true },
		orderBy: { createdAt: "desc" },
		take: MAX_RUNS,
	});
	if (runs.length === 0) return {};
	const steps = await prisma.agentStep.findMany({
		where: { runId: { in: runs.map((run) => run.id) }, type: "tool" },
		select: { inputJson: true },
		take: MAX_STEPS,
	});
	const counts: Record<string, number> = {};
	for (const step of steps) {
		const raw = step.inputJson;
		const name = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { name?: unknown }).name : undefined;
		if (typeof name !== "string" || !name || name.length > 128) continue;
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}
