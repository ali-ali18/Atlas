import { createAgentRun, prisma } from "@workspace/db";
import {
	botCreatedClientKey,
	buildBotCreatedMessages,
	buildBotCreatedObjective,
	BOT_CREATED_OBJECTIVE_MARKER,
	type CreateAgentRunRequest,
} from "@workspace/shared";
import { resolveRunModelChoice } from "./effective-model.js";
import { enqueueAgentRunJob } from "../routes/runs.js";
import type { RunQueue } from "../routes/run-queue.js";

/**
 * Onboarding do bot recém-criado, disparado pelo servidor (`POST /v1/bots`): um ponto só para web, celular e API.
 * Reaproveita o caminho de `POST /v1/runs` (`createAgentRun` + `enqueueAgentRunJob`), sem HTTP interno.
 * Nunca lança: o onboarding é opcional e não pode derrubar a criação do bot.
 */

export type BotOnboardingTarget = {
	id: string;
	name: string;
	description?: string | null;
	conversationId?: string | null;
};

export type BotOnboardingOutcome =
	| { outcome: "started"; runId: string }
	/** Já existe run de onboarding para este bot (repetição ou web antigo): nada é criado. */
	| { outcome: "duplicate"; runId: string }
	| { outcome: "skipped" }
	| { outcome: "failed" };

export type BotOnboardingDeps = {
	findExisting: (userId: string, conversationId: string) => Promise<{ id: string } | null>;
	resolveModel: (input: { botId: string; userId: string; envDefault: string }) => Promise<{ model: string; auto: boolean }>;
	createRun: typeof createAgentRun;
	enqueue: (queue: RunQueue, runId: string) => Promise<boolean>;
};

/** Run de onboarding já criado na conversa do bot (do servidor ou do web antigo, que usa outra `clientKey`). */
export async function findBotCreatedRun(userId: string, conversationId: string): Promise<{ id: string; status: string } | null> {
	return prisma.agentRun.findFirst({
		where: { userId, conversationId, objective: { startsWith: BOT_CREATED_OBJECTIVE_MARKER } },
		select: { id: true, status: true },
	});
}

const defaultDeps: BotOnboardingDeps = {
	findExisting: findBotCreatedRun,
	resolveModel: ({ botId, userId, envDefault }) => resolveRunModelChoice({ botId, userId, envDefault }),
	createRun: createAgentRun,
	// Lambda: runs.ts importa este módulo (ciclo); a referência só é resolvida na chamada.
	enqueue: (queue, runId) => enqueueAgentRunJob(queue, runId),
};

export async function startBotOnboarding(
	input: {
		bot: BotOnboardingTarget;
		/** Dono vindo da sessão; nunca do corpo. */
		userId: string;
		queue: RunQueue | null;
		envDefault: string;
	},
	deps: Partial<BotOnboardingDeps> = {},
): Promise<BotOnboardingOutcome> {
	const d = { ...defaultDeps, ...deps };
	const { bot, userId, queue } = input;
	if (!queue || !bot.conversationId) return { outcome: "skipped" };
	try {
		const existing = await d.findExisting(userId, bot.conversationId);
		if (existing) return { outcome: "duplicate", runId: existing.id };
		const { model, auto } = await d.resolveModel({ botId: bot.id, userId, envDefault: input.envDefault });
		const request: CreateAgentRunRequest = {
			messages: buildBotCreatedMessages({ name: bot.name, description: bot.description }),
			botId: bot.id,
			conversationId: bot.conversationId,
			origin: "chat",
			objective: buildBotCreatedObjective(bot.name),
			clientKey: botCreatedClientKey(bot.id),
			silent: true,
		};
		const run = await d.createRun({ request, model, userId, modelAuto: auto });
		const enqueued = await d.enqueue(queue, run.id);
		if (!enqueued) console.warn(`bot onboarding run ${run.id} created but not enqueued (reconcile will retry)`);
		return { outcome: "started", runId: run.id };
	} catch (error) {
		// Sem segredo: só o tipo do erro, nunca a mensagem (pode citar conexão ou chave).
		console.warn(`bot onboarding not started for bot ${bot.id}: ${error instanceof Error ? error.name : "unknown error"}`);
		return { outcome: "failed" };
	}
}
