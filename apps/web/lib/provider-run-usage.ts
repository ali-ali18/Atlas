import type { RunUsage } from "@workspace/shared";
/** Dados antigos/ausentes não geram custo fictício. */
export function readProviderRunUsage(raw: unknown): RunUsage | null {
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
 const value = raw as Record<string, unknown>;
 const count = (field: string) => typeof value[field] === "number" && Number.isSafeInteger(value[field]) && (value[field] as number) >= 0 ? value[field] as number : undefined;
 const promptTokens = count("promptTokens"), completionTokens = count("completionTokens"), totalTokens = count("totalTokens");
 if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return null;
 const costUsd = typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : undefined;
 const planCalls = count("planCalls"), costUnknownCalls = count("costUnknownCalls");
 return { promptTokens, completionTokens, totalTokens, ...(costUsd !== undefined ? { costUsd } : {}), ...(planCalls !== undefined ? { planCalls } : {}), ...(costUnknownCalls !== undefined ? { costUnknownCalls } : {}) };
}
