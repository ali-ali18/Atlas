import { formatCostLabel } from "@workspace/shared"
export type ProviderCostUsage = {
  costUsd?: number | null
  costUnknownCalls?: number
  planCalls?: number
  provider?: "openrouter" | "chatgpt" | "anthropic" | "opencode-go"
  costKind?: "plan"
}
export function providerCostLabel(usage: ProviderCostUsage): string {
  const plan =
    (usage.planCalls ?? 0) > 0 ||
    usage.provider === "chatgpt" ||
    usage.costKind === "plan"
  if (!plan) return formatCostLabel(usage.costUsd, usage.costUnknownCalls)
  const priced =
    typeof usage.costUsd === "number" || (usage.costUnknownCalls ?? 0) > 0
      ? formatCostLabel(usage.costUsd, usage.costUnknownCalls)
      : null
  return priced ? `${priced} + plano` : "plano"
}
export function ProviderRunCost({ usage }: { usage: ProviderCostUsage }) {
  const plan =
    (usage.planCalls ?? 0) > 0 ||
    usage.provider === "chatgpt" ||
    usage.costKind === "plan"
  return (
    <span
      title={plan ? "Consome a cota do seu plano ChatGPT" : undefined}
      className="text-xs text-muted-foreground"
    >
      {providerCostLabel(usage)}
    </span>
  )
}
