import type { Job } from "bullmq";
import {
	ATLAS_JOB_NAMES,
	type ChatCompletionJobPayload,
	type ChatCompletionJobResult,
} from "@workspace/shared";
import {
	buildMemoryAugmentedMessages,
	persistChatTurn,
} from "@workspace/db";
import { OpenRouterError, completeChat } from "@workspace/llm";
import { keyProviderStreamFor } from "@workspace/agent-runtime";
import type { WorkerConfig } from "../config.js";
import { resolveDefaultModelForJob } from "../run-config.js";

function lastUserContent(
	messages: ChatCompletionJobPayload["messages"],
): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "user") {
			return message.content;
		}
	}
	return null;
}

export async function processChatCompletionJob(
	job: Job<ChatCompletionJobPayload, ChatCompletionJobResult>,
	config: WorkerConfig,
	deps: { via?: NonNullable<Parameters<typeof completeChat>[0]["via"]> } = {},
): Promise<ChatCompletionJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.chatCompletion) {
		throw new Error(`Unexpected job name: ${job.name}`);
	}

	const payload = job.data;
	const model =
		payload.model ??
		(await resolveDefaultModelForJob({ userId: payload.userId, serverDefault: config.openRouterModel }));
	// Anthropic/OpenCode Go pela chave da conta; OpenRouter pela chave do servidor.
	const via = deps.via ?? (payload.userId ? keyProviderStreamFor(payload.userId, model) : undefined);
	if (!via && !config.openRouterApiKey) {
		throw new Error("OPENROUTER_API_KEY is not configured on the worker");
	}

	console.log(
		`[chat.completion] start job=${job.id} model=${model} messages=${payload.messages.length}`,
	);

	try {
		let messages = payload.messages;
		try {
			messages = await buildMemoryAugmentedMessages(payload.messages, {
				userId: payload.userId,
				botId: payload.botId,
				conversationId: payload.conversationId,
			});
		} catch (memoryError) {
			console.error(
				`[chat.completion] memory load failed job=${job.id}`,
				memoryError,
			);
		}

		const result = await completeChat({
			messages,
			model,
			apiKey: config.openRouterApiKey ?? "",
			...(via ? { via } : {}),
		});

		if (payload.conversationId) {
			try {
				await persistChatTurn(
					payload.conversationId,
					lastUserContent(payload.messages),
					result.message.content,
				);
			} catch (persistError) {
				console.error(
					`[chat.completion] persist turn failed job=${job.id}`,
					persistError,
				);
			}
		}

		const response: ChatCompletionJobResult = {
			message: result.message,
			model: result.model,
			usage: result.usage,
		};

		console.log(`[chat.completion] done job=${job.id}`);
		return response;
	} catch (error) {
		if (error instanceof OpenRouterError) {
			console.error(
				`[chat.completion] failed job=${job.id} openrouter status=${error.status}: ${error.message}`,
			);
		} else {
			console.error(`[chat.completion] failed job=${job.id}`, error);
		}
		throw error;
	}
}
