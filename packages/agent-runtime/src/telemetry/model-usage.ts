import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { RunUsage } from "@workspace/shared";
/** Cota de assinatura é conhecida como plano, jamais USD zero ou desconhecido. */
export function modelUsage(
	result: Pick<CompleteChatWithToolsResult, "usage">
): RunUsage {
	const u = result.usage,
		promptTokens = u?.promptTokens ?? 0,
		completionTokens = u?.completionTokens ?? 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens: u?.totalTokens ?? promptTokens + completionTokens,
		...(u?.costKind === "plan"
			? { planCalls: 1 }
			: u?.costUsd === undefined
				? { costUnknownCalls: 1 }
				: { costUsd: u.costUsd }),
		...(u?.cachedTokens === undefined ? {} : { cachedTokens: u.cachedTokens }),
		...(u?.cacheWriteTokens === undefined
			? {}
			: { cacheWriteTokens: u.cacheWriteTokens }),
	};
}
