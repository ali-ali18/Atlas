/**
 * Aprovação de proposta de novo agente (bot). O conteúdo aplicado é o que está
 * GRAVADO no card da conversa do dono; o clique só diz qual proposta e a decisão
 * (mais, opcionalmente, nome/papel revisados). A aprovação é idempotente: o card
 * é reservado por troca condicional antes de criar, então toque duplo cria um
 * só bot. O bot novo nasce com a autonomia padrão (sem política, grants nem cofre).
 */
import { parseConversationCard, serializeConversationCard, type PersistedBotProposalCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { createBot } from "./bots.js";
import { sendBotMessage } from "./bot-messages.js";
import { appendConversationMessage, getOwnedConversation } from "./conversations.js";
import { createSkillDoc, listSkillDocs } from "./skill-docs.js";

export type BotProposalDeps = {
	createBot: typeof createBot;
	listSkillDocs: typeof listSkillDocs;
	createSkillDoc: typeof createSkillDoc;
	sendBotMessage: typeof sendBotMessage;
	appendMessage: typeof appendConversationMessage;
};

const defaultDeps: BotProposalDeps = { createBot, listSkillDocs, createSkillDoc, sendBotMessage, appendMessage: appendConversationMessage };

export type BotProposalResolution =
	| {
			ok: true;
			card: PersistedBotProposalCard;
			/** O card já estava decidido: nada mudou (toque duplo). */
			unchanged?: boolean;
			/** Confirmação postada na conversa (o web a mostra sem recarregar). */
			confirmation?: { id: string; text: string };
			/** Avisos não fatais (skill que não deu para copiar, primeira tarefa que não saiu). */
			warnings?: string[];
	  }
	| { ok: false; status: 404 | 409 | 500; error: string };

async function findProposalRow(conversationId: string, proposalId: string) {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "bot-proposal" },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (card?.kind === "bot-proposal" && card.proposalId === proposalId) return { row, card };
	}
	return null;
}

/** Proposta ainda pendente da conversa (a API valida o modelo contra o que está gravado). */
export async function getPendingBotProposal(conversationId: string, proposalId: string): Promise<PersistedBotProposalCard | null> {
	const found = await findProposalRow(conversationId, proposalId);
	return found && found.card.status === "pending" ? found.card : null;
}

/** Troca o conteúdo só se ninguém mexeu antes (dois cliques seguidos não criam dois bots). */
async function swapCard(row: { id: string; content: string }, next: PersistedBotProposalCard): Promise<boolean> {
	const result = await prisma.conversationMessage.updateMany({
		where: { id: row.id, content: row.content },
		data: { content: serializeConversationCard(next) },
	});
	return result.count === 1;
}

async function reloaded(conversationId: string, proposalId: string, fallback: PersistedBotProposalCard): Promise<PersistedBotProposalCard> {
	return (await findProposalRow(conversationId, proposalId))?.card ?? fallback;
}

export async function resolveBotProposal(
	input: {
		userId: string;
		conversationId: string;
		proposalId: string;
		decision: "approved" | "rejected";
		/** Nome/papel revisados no card antes de criar. */
		edits?: { name?: string; description?: string };
		/** Modelo já validado pela API; `null` = usar o padrão. Ausente = o do card. */
		model?: string | null;
	},
	deps: BotProposalDeps = defaultDeps,
): Promise<BotProposalResolution> {
	const notFound = { ok: false, status: 404, error: "Proposta não encontrada." } as const;
	if (!input.userId.trim() || input.userId === "default") return notFound;
	if (!(await getOwnedConversation(input.conversationId, input.userId))) return notFound;
	// O card mora na conversa de um bot do dono; esse é o bot que propôs.
	const proposer = await prisma.bot.findFirst({ where: { conversationId: input.conversationId, ownerId: input.userId }, select: { id: true } });
	if (!proposer) return notFound;
	const found = await findProposalRow(input.conversationId, input.proposalId);
	if (!found) return notFound;
	const { row, card } = found;

	if (card.status !== "pending") {
		if (card.status === "rejected" && input.decision === "approved") {
			return { ok: false, status: 409, error: "Esta proposta já foi recusada." };
		}
		return { ok: true, card, unchanged: true };
	}

	if (input.decision === "rejected") {
		const next: PersistedBotProposalCard = { ...card, status: "rejected" };
		if (!(await swapCard(row, next))) return { ok: true, card: await reloaded(input.conversationId, input.proposalId, card), unchanged: true };
		return { ok: true, card: next };
	}

	const reserved: PersistedBotProposalCard = {
		...card,
		...(input.edits?.name ? { name: input.edits.name } : {}),
		...(input.edits?.description ? { description: input.edits.description } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
		status: "approved",
	};
	if (!(await swapCard(row, reserved))) return { ok: true, card: await reloaded(input.conversationId, input.proposalId, card), unchanged: true };

	const warnings: string[] = [];
	try {
		const bot = await deps.createBot(
			{
				name: reserved.name,
				snippet: reserved.snippet,
				color: reserved.color,
				shape: reserved.shape,
				description: reserved.description,
				openRouterModel: reserved.model,
			},
			input.userId,
		);

		if (reserved.skills.length > 0) {
			const owned = await deps.listSkillDocs(input.userId).catch(() => []);
			for (const slug of reserved.skills) {
				const source = owned.find((doc) => doc.name === slug && doc.botId === null && doc.enabled && doc.status === "active");
				if (!source) {
					warnings.push(`A skill ${slug} não foi encontrada.`);
					continue;
				}
				try {
					await deps.createSkillDoc(input.userId, {
						botId: bot.id,
						name: source.name,
						description: source.description,
						body: source.body,
						tools: source.tools,
						createdBy: "agent",
					});
				} catch {
					warnings.push(`Não consegui copiar a skill ${slug}.`);
				}
			}
		}

		const done: PersistedBotProposalCard = { ...reserved, botId: bot.id };
		await prisma.conversationMessage.update({ where: { id: row.id }, data: { content: serializeConversationCard(done) } });

		let firstTaskSent = false;
		if (reserved.firstTask) {
			try {
				await deps.sendBotMessage({
					userId: input.userId,
					fromBotId: proposer.id,
					bot: bot.id,
					message: reserved.firstTask,
					title: `Primeira tarefa de ${reserved.name}`,
				});
				firstTaskSent = true;
			} catch {
				warnings.push("Não consegui enviar a primeira tarefa.");
			}
		}

		const text = firstTaskSent
			? `Criei o agente ${reserved.name} e enviei a primeira tarefa. Ele responde por aqui quando terminar.`
			: `Criei o agente ${reserved.name}. Ele já está na sua lista.`;
		const message = await deps.appendMessage(input.conversationId, "assistant", text).catch(() => null);
		return { ok: true, card: done, ...(message ? { confirmation: { id: message.id, text } } : {}), ...(warnings.length ? { warnings } : {}) };
	} catch (error) {
		// Volta a pendente para o usuário tentar de novo.
		await prisma.conversationMessage
			.update({ where: { id: row.id }, data: { content: serializeConversationCard(card) } })
			.catch(() => undefined);
		return { ok: false, status: 500, error: error instanceof Error ? error.message : "Não consegui criar o agente." };
	}
}
