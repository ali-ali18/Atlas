import type { ApiConfig } from "../config.js";
import { Hono } from "hono";
import type {
	ChatCompletionJobEnqueueResponse,
	ChatCompletionJobStatus,
	ChatCompletionJobStatusResponse,
	ChatCompletionResponse,
} from "@workspace/shared";
import { ATLAS_JOB_NAMES } from "@workspace/shared";
import { CHAT_QUEUE_NAME } from "@workspace/queue";
import { parseChatCompletionRequest } from "../chat/parse.js";
import { maybeHandleConfirmedAction } from "../chat/confirmed-action.js";
import { buildJevIntentFor } from "../chat/jev-intent.js";
import { getAgentRun } from "@workspace/db";
import { resolveRunModel } from "../chat/effective-model.js";
import {
	persistCompletionSegmented,
	prepareMessagesForCompletion,
	buildMemoryReviewPayload,
	enqueueMemoryReview,
} from "../chat/memory.js";
import {
	OpenRouterError,
	completeChat,
	streamChat,
} from "../openrouter/client.js";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

function sseLine(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

function mapJobState(state: string): ChatCompletionJobStatus {
	switch (state) {
		case "waiting":
		case "active":
		case "completed":
		case "failed":
		case "delayed":
		case "paused":
			return state;
		default:
			return "unknown";
	}
}

export function createChatRoutes(config: ApiConfig) {
	const app = new Hono<AuthEnv>();

	app.post("/v1/chat", async (c) => {
		if (!config.openRouterApiKey) {
			return c.json(
				{
					error:
						"OPENROUTER_API_KEY is not configured on the API server",
				},
				503,
			);
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
						"Invalid body: expected { messages: [{ role, content }, ...], model?: string }",
				},
				400,
			);
		}

		const { userId } = scopeFor(c.get("session"));
		const effectiveModel = await resolveRunModel({
			requested: request.model,
			botId: request.botId,
			userId,
			envDefault: config.openRouterModel,
		});

		// Só o clique do card de confirmação é resolvido aqui; o resto vai ao modelo.
		try {
			const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
			const confirmedAction = await maybeHandleConfirmedAction({
				jevIntent: await buildJevIntentFor(userId, config.openRouterApiKey),
				text: lastUser,
				userId,
				botId: request.botId,
				conversationId: request.conversationId,
				model: effectiveModel,
			});
			if (confirmedAction.handled) {
				const completed = await getAgentRun(confirmedAction.run.id);
				const text = completed?.resultText?.trim() || "Pronto.";
				const response: ChatCompletionResponse = {
					message: { role: "assistant", content: text },
					model: completed?.model ?? effectiveModel,
				};
				return c.json(response);
			}
		} catch (error) {
			console.error("confirmed action failed; falling back to chat completion", error);
		}

		try {
			const messages = await prepareMessagesForCompletion(request, userId);
			const result = await completeChat({
				messages,
				model: effectiveModel,
				apiKey: config.openRouterApiKey,
			});

			await persistCompletionSegmented(
				request,
				result.message.content,
			);

			await enqueueMemoryReview(
				config.chatQueue,
				buildMemoryReviewPayload(request, result.message.content, userId),
			);

			const response: ChatCompletionResponse = {
				message: result.message,
				model: result.model,
				usage: result.usage,
			};

			return c.json(response);
		} catch (error) {
			if (error instanceof OpenRouterError) {
				const status =
					error.status >= 400 && error.status < 600 ? error.status : 502;
				return c.json(
					{ error: error.message },
					status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
				);
			}

			console.error("chat completion failed", error);
			return c.json({ error: "Internal server error" }, 500);
		}
	});

	app.post("/v1/chat/stream", async (c) => {
		if (!config.openRouterApiKey) {
			return c.json(
				{
					error:
						"OPENROUTER_API_KEY is not configured on the API server",
				},
				503,
			);
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
						"Invalid body: expected { messages: [{ role, content }, ...], model?: string }",
				},
				400,
			);
		}

		const { userId } = scopeFor(c.get("session"));
		const messages = await prepareMessagesForCompletion(request, userId);
		const model = await resolveRunModel({
			requested: request.model,
			botId: request.botId,
			userId,
			envDefault: config.openRouterModel,
		});
		const apiKey = config.openRouterApiKey;

		// Só o clique do card de confirmação é resolvido aqui; o resto vai ao modelo.
		try {
			const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
			const confirmedAction = await maybeHandleConfirmedAction({
				jevIntent: await buildJevIntentFor(userId, config.openRouterApiKey),
				text: lastUser,
				userId,
				botId: request.botId,
				conversationId: request.conversationId,
				model,
			});
			if (confirmedAction.handled) {
				const completed = await getAgentRun(confirmedAction.run.id);
				const text = completed?.resultText?.trim() || "Pronto.";
				const skillStream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						controller.enqueue(encoder.encode(sseLine({ type: "delta", delta: text })));
						controller.enqueue(
							encoder.encode(
								sseLine({
									type: "done",
									message: { role: "assistant", content: text },
									model: completed?.model ?? model,
								}),
							),
						);
						controller.close();
					},
				});
				return new Response(skillStream, {
					headers: {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
						"X-Accel-Buffering": "no",
					},
				});
			}
		} catch (error) {
			console.error("confirmed action failed; falling back to chat stream", error);
		}

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const send = (payload: unknown) => {
					controller.enqueue(encoder.encode(sseLine(payload)));
				};

				try {
					const result = await streamChat(
						{
							messages,
							model,
							apiKey,
						},
						{
							onDelta: (delta) => {
								send({ type: "delta", delta });
							},
						},
					);

					await persistCompletionSegmented(
						request,
						result.message.content,
					);

					await enqueueMemoryReview(
						config.chatQueue,
						buildMemoryReviewPayload(request, result.message.content, userId),
					);

					send({
						type: "done",
						message: result.message,
						model: result.model,
						usage: result.usage,
					});
				} catch (error) {
					const message =
						error instanceof OpenRouterError
							? error.message
							: error instanceof Error
								? error.message
								: "Internal server error";
					send({ type: "error", error: message });
				} finally {
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			},
		});
	});

	app.post("/v1/chat/jobs", async (c) => {
		if (!config.chatQueue) {
			return c.json(
				{
					error:
						"Job queue is not available (check REDIS_URL and Redis)",
				},
				503,
			);
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
						"Invalid body: expected { messages: [{ role, content }, ...], model?: string }",
				},
				400,
			);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			const job = await config.chatQueue.add(
				ATLAS_JOB_NAMES.chatCompletion,
				{ ...request, userId },
			);

			const body: ChatCompletionJobEnqueueResponse = {
				jobId: job.id ?? "",
				queue: CHAT_QUEUE_NAME,
				name: ATLAS_JOB_NAMES.chatCompletion,
			};

			return c.json(body, 202);
		} catch (error) {
			console.error("failed to enqueue chat job", error);
			return c.json({ error: "Failed to enqueue job" }, 503);
		}
	});

	app.get("/v1/chat/jobs/:id", async (c) => {
		if (!config.chatQueue) {
			return c.json(
				{
					error:
						"Job queue is not available (check REDIS_URL and Redis)",
				},
				503,
			);
		}

		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing job id" }, 400);
		}

		try {
			const job = await config.chatQueue.getJob(id);
			if (!job) {
				return c.json({ error: "Job not found" }, 404);
			}

			const state = await job.getState();
			const status = mapJobState(state);

			let result: ChatCompletionJobStatusResponse["result"] = null;
			let error: string | null = null;

			if (status === "completed") {
				result =
					(job.returnvalue as ChatCompletionJobStatusResponse["result"]) ??
					null;
			} else if (status === "failed") {
				error = job.failedReason ?? "Job failed";
			}

			const response: ChatCompletionJobStatusResponse = {
				id: job.id ?? id,
				status,
				result,
				error,
			};

			return c.json(response);
		} catch (err) {
			console.error("failed to read chat job", err);
			return c.json({ error: "Failed to read job status" }, 503);
		}
	});

	return app;
}
