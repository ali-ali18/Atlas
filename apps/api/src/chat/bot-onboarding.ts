import { maskKnownSecretsInMessages } from "@workspace/agent-runtime";
import { createAgentRun, prisma } from "@workspace/db";
import {
	botCreatedClientKey,
	buildBotCreatedMessages,
	buildBotCreatedObjective,
	BOT_CREATED_OBJECTIVE_MARKER,
	type BotLanguage,
	type CreateAgentRunRequest,
} from "@workspace/shared";
import { resolveRunModelChoice } from "./effective-model.js";
import { checkRunModel, enqueueAgentRunJob } from "../routes/runs.js";
import { peekModelContextLength } from "../routes/models.js";
import { validateProviderModel } from "../providers/model-catalog.js";
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
	/** Sem fila, sem conversa ou modelo inutilizável (sem chave, fora do catálogo): nenhum run nasce. */
	| { outcome: "skipped"; reason: string }
	| { outcome: "failed" };

export type BotOnboardingDeps = {
	findExisting: (userId: string, conversationId: string) => Promise<{ id: string } | null>;
	resolveModel: (input: { botId: string; userId: string; envDefault: string }) => Promise<{ model: string; auto: boolean }>;
	/** Mesma checagem do `POST /v1/runs`: `null` = modelo utilizável. */
	checkModel: (userId: string, model: string) => Promise<{ error: string } | null>;
	contextLength: (model: string) => number | null;
	maskMessages: typeof maskKnownSecretsInMessages;
	createRun: typeof createAgentRun;
	enqueue: (queue: RunQueue, runId: string) => Promise<boolean>;
};

/** Run de onboarding já criado na conversa do bot (do servidor ou do web antigo, que usa outra `clientKey`). */
export async function findBotCreatedRun(
	userId: string,
	conversationId: string,
): Promise<{ id: string; status: string; enqueued: boolean } | null> {
	const rows = await prisma.agentRun.findMany({
		where: { userId, conversationId, origin: "chat", objective: { startsWith: BOT_CREATED_OBJECTIVE_MARKER, mode: "insensitive" } },
		orderBy: { createdAt: "asc" },
		take: 10,
		select: { id: true, status: true, budgetJson: true, jobEnqueuedAt: true },
	});
	// Run digitado pelo dono (`humanTurn`) que só começa com o marcador é conversa comum, não onboarding.
	const row = rows.find((item) => (item.budgetJson as { humanTurn?: unknown } | null)?.humanTurn !== true);
	if (!row) return null;
	return { id: row.id, status: row.status, enqueued: row.status !== "queued" || row.jobEnqueuedAt != null };
}

const defaultDeps: BotOnboardingDeps = {
	findExisting: findBotCreatedRun,
	resolveModel: ({ botId, userId, envDefault }) => resolveRunModelChoice({ botId, userId, envDefault }),
	checkModel: async () => null,
	contextLength: (model) => peekModelContextLength(model),
	maskMessages: maskKnownSecretsInMessages,
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
		/** Chave do OpenRouter do servidor (mesma checagem do `POST /v1/runs`). */
		openRouterApiKey?: string;
		/** Idioma resolvido do bot, posto no prompt para o modo auto não herdar o inglês do evento. */
		language?: BotLanguage;
	},
	deps: Partial<BotOnboardingDeps> = {},
): Promise<BotOnboardingOutcome> {
	const d: BotOnboardingDeps = {
		...defaultDeps,
		checkModel: (userId, model) => checkRunModel(userId, model, { validateModel: validateProviderModel, openRouterApiKey: input.openRouterApiKey }),
		...deps,
	};
	const { bot, userId, queue } = input;
	if (!queue) return { outcome: "skipped", reason: "no_queue" };
	if (!bot.conversationId) return { outcome: "skipped", reason: "no_conversation" };
	try {
		const existing = await d.findExisting(userId, bot.conversationId);
		if (existing) return { outcome: "duplicate", runId: existing.id };
		const { model, auto } = await d.resolveModel({ botId: bot.id, userId, envDefault: input.envDefault });
		const modelError = await d.checkModel(userId, model);
		if (modelError) {
			console.warn(`bot onboarding skipped for bot ${bot.id}: model unavailable (${modelError.error.slice(0, 80)})`);
			return { outcome: "skipped", reason: "model_unavailable" };
		}
		const request: CreateAgentRunRequest = {
			// Cofre: a descrição do bot pode trazer segredo conhecido; vira marcador antes de persistir e de ir ao modelo.
			messages: await d.maskMessages(userId, buildBotCreatedMessages({ name: bot.name, description: bot.description, language: input.language })),
			botId: bot.id,
			conversationId: bot.conversationId,
			origin: "chat",
			objective: buildBotCreatedObjective(bot.name),
			clientKey: botCreatedClientKey(bot.id),
			silent: true,
		};
		const run = await d.createRun({ request, model, userId, modelAuto: auto, contextLength: d.contextLength(model) });
		const enqueued = await d.enqueue(queue, run.id);
		if (!enqueued) console.warn(`bot onboarding run ${run.id} created but not enqueued (reconcile will retry)`);
		return { outcome: "started", runId: run.id };
	} catch (error) {
		// Sem segredo: só o tipo do erro, nunca a mensagem (pode citar conexão ou chave).
		console.warn(`bot onboarding not started for bot ${bot.id}: ${error instanceof Error ? error.name : "unknown error"}`);
		return { outcome: "failed" };
	}
}
