import { Hono } from "hono";
import { ResourceOwnershipError, type getAccountConfig } from "@workspace/db";
import { publishRunSignal as defaultPublishRunSignal } from "@workspace/queue";
import { notifyRunSignal, type PublishRunSignal } from "../run-signal.js";
import { validateRunReferences } from "../chat/run-ownership.js";
import { createRunObserver, closesRunStream } from "./run-observer.js";
import { resolveRunModel } from "../chat/effective-model.js";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import {
	ATLAS_JOB_NAMES,
	type AgentRun,
	type ComputerUseEvent,
} from "@workspace/shared";
import {
	createAgentRun,
	getAgentRunForUser,
	listRunEventsAfter,
	markRunJobEnqueued,
} from "@workspace/db";
import type { RunQueue } from "./run-queue.js";
import type { ApiConfig } from "../config.js";
import { parseChatCompletionRequest } from "../chat/parse.js";
import { applyConfirmedFollowUp, maybeHandleConfirmedAction } from "../chat/confirmed-action.js";
import { buildJevIntentFor } from "../chat/jev-intent.js";
import { peekModelContextLength } from "./models.js";



function sseLine(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Compat: mantém POST /v1/chat/computer, mas a execução vai para o worker.
 * O SSE projeta RunEvent persistidos (reconectável via /v1/runs/:id/stream).
 */
export function createComputerUseRoutes(
	config: Omit<ApiConfig, "agentRunQueue"> & { agentRunQueue: RunQueue | null },
	dependencies: { getAccountConfig?: typeof getAccountConfig; publishRunSignal?: PublishRunSignal } = {},
) {
	const app = new Hono<AuthEnv>();
	const publish = dependencies.publishRunSignal ?? defaultPublishRunSignal;

	app.post("/v1/chat/computer", async (c) => {
		if (!config.openRouterApiKey) {
			return c.json(
				{ error: "OPENROUTER_API_KEY is not configured on the API server" },
				503,
			);
		}
		if (!config.agentRunQueue) {
			return c.json({ error: "Agent run queue unavailable" }, 503);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const request = parseChatCompletionRequest(json);
		if (!request) {
			return c.json(
				{
					error:
						"Invalid body: expected { messages: [{ role, content }, ...], model? }",
				},
				400,
			);
		}

		const rawSessionId = (json as { sandboxSessionId?: unknown })
			.sandboxSessionId;
		const providedSessionId =
			typeof rawSessionId === "string" && rawSessionId.trim().length > 0
				? rawSessionId.trim()
				: undefined;

		const { userId } = scopeFor(c.get("session"));
		const rawMaxSteps = (json as { maxSteps?: unknown }).maxSteps;
		const maxSteps =
			typeof rawMaxSteps === "number" && Number.isFinite(rawMaxSteps)
				? rawMaxSteps
				: undefined;

		try { await validateRunReferences({ ...request, sandboxSessionId: providedSessionId }, userId); }
		catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			throw error;
		}

		const model = await resolveRunModel({
			requested: request.model,
			botId: request.botId,
			userId: scopeFor(c.get("session")).userId,
			envDefault: config.openRouterModel,
			getAccountConfig: dependencies.getAccountConfig,
		});

		// Só o clique do card de confirmação é resolvido aqui; o resto vai ao agente.
		const lastUser =
			[...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
		let skillRun: AgentRun | null = null;
		let messages = request.messages;
		let objective: string | undefined;
		let transcriptSeed: import("@workspace/shared").TranscriptSeed | undefined;
		try {
			const confirmedAction = await maybeHandleConfirmedAction({
				jevIntent: await buildJevIntentFor(userId, config.openRouterApiKey, process.env, dependencies.getAccountConfig),
				text: lastUser,
				userId,
				botId: request.botId,
				conversationId: request.conversationId,
				model,
				continueInAgent: true,
			});
			if (confirmedAction.handled) skillRun = confirmedAction.run;
			else if (confirmedAction.followUp) {
				// Ação MCP confirmada já rodou: o agente continua com o resultado.
				messages = applyConfirmedFollowUp(messages, confirmedAction.followUp);
				objective = confirmedAction.followUp.objective;
				transcriptSeed = confirmedAction.followUp.transcript;
			}
		} catch (error) {
			console.error("confirmed action failed; falling back to agent run", error);
		}

		let run: AgentRun;
		try {
			run = skillRun ?? (await createAgentRun({
			userId,
			request: {
				messages,
				objective,
				...(transcriptSeed ? { transcriptSeed } : {}),
				model,
				conversationId: request.conversationId,
				botId: request.botId,
				sandboxSessionId: providedSessionId,
				maxSteps,
				origin: "chat",
			},
			model,
			contextLength: peekModelContextLength(model),
			onMergedIntoActiveRun: (runId) => notifyRunSignal(publish, runId, "input"),
		}));
		} catch (error) {
			if (error instanceof ResourceOwnershipError) return c.json({ error: "Resource not found" }, 404);
			throw error;
		}

		if (!skillRun) {
			await config.agentRunQueue.add(
				ATLAS_JOB_NAMES.runAgent,
				{ runId: run.id },
				{ jobId: `agent-run-${run.id}` },
			);
			await markRunJobEnqueued(run.id);
		}

		const stream = createRunObserver(c.req.raw.signal, async (observer) => {
				const encoder = new TextEncoder();
				const send = (event: unknown) => {
					observer.send(encoder.encode(sseLine(event)));
				};

				// Expõe o runId cedo para o cliente poder reconectar após F5.
				send({ type: "run", runId: run.id, status: run.status });

				let cursor = 0;
				try {
					while (true) {
						if (observer.stopped()) break;
						const current = await getAgentRunForUser(run.id, userId);
						if (observer.stopped()) break;
						if (!current) {
							send({ type: "error", error: "Run not found" });
							break;
						}

						const events = await listRunEventsAfter(run.id, cursor, 100);
						for (const event of events) {
							cursor = event.seq;
							send(event.payload);
						}

						if (closesRunStream(current.status) && events.length === 0) {
							break;
						}

						await observer.wait(400);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Internal server error";
					send({ type: "error", error: message } satisfies ComputerUseEvent);
				}
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Atlas-Run-Id": run.id,
			},
		});
	});

	return app;
}
