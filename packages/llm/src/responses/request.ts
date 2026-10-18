import { parseModelRef } from "@workspace/shared";
import type { CompleteChatWithToolsParams } from "../chat-tools.js";
import { toResponses } from "./to-responses.js";

export function responsesRequestBody(params: CompleteChatWithToolsParams, slugOverride?: string) {
	const ref = parseModelRef(params.model);
	if (slugOverride === undefined && ref.provider !== "chatgpt") throw new Error("Responses requires a ChatGPT model reference");
	return {
		model: slugOverride ?? ref.slug,
		...toResponses(params.messages, params.model),
		tools: params.tools.map((tool) => {
			if (tool.type !== "function") throw new Error("Only local function tools are supported");
			return { type: "function", ...tool.function };
		}),
		tool_choice: params.toolChoice ?? "auto",
		stream: true,
		store: false,
		// Chave explícita omitida até validação real da hipótese de cache SIWC.
	};
}
