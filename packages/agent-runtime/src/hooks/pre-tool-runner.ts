/**
 * Hooks antes de cada tool, reutilizáveis por qualquer laço (o motor v2 usa; o v1 mantém a cópia inline).
 * Embrulha `runPreToolHooks` com o estado do run: lições com regra, plano pendente, tools que já deram certo
 * e as lições que barraram (para contar "ajudou" quando a chamada seguinte der certo).
 */
import { connectorScopeKey, lessonRef, toolPatternMatches, type InspectHooksPayload } from "@workspace/shared";
import type { McpToolset } from "../mcp/registry.js";
import type { RunLesson } from "../lessons.js";
import { isNativeWriteTool, runPreToolHooks, type HookLesson, type PreToolHit, type PreToolResult } from "./pre-tool.js";

type McpEntryLike = { toolName: string; connectionId: string; readOnly: boolean };

export function createPreToolRunner(input: {
	lessons?: ReadonlyArray<RunLesson>;
	/** Regras já resolvidas pelo chamador (vencem `lessons`). */
	preToolRules?: readonly HookLesson[];
	planPending: boolean;
	toolset?: Pick<McpToolset, "available" | "entries"> | null;
	/** Nomes das tools hoje no pedido ao modelo. */
	loadedToolNames: () => readonly string[];
	onInspect?: (payload: InspectHooksPayload) => void;
	recordFeedback?: (entries: Array<{ ref: string; outcome: "helped" }>) => unknown;
}) {
	const lessons: HookLesson[] = (input.preToolRules ?? (input.lessons ?? []).map((item) => ({ id: item.id, scope: item.scope, scopeKey: item.scopeKey, rule: item.rule ?? null }))).filter((item) => item.rule);
	const planState = { pending: input.planPending };
	const succeeded = new Set<string>();
	const blockedBy = new Map<string, Set<string>>();
	const isToolAvailable = (pattern: string): boolean =>
		input.loadedToolNames().some((name) => toolPatternMatches(pattern, name)) ||
		[...(input.toolset?.available.keys() ?? [])].some((exposed) => toolPatternMatches(pattern, exposed, input.toolset?.entries.get(exposed)?.toolName));
	return {
		hasRules: lessons.length > 0,
		planState,
		run(name: string, args: Record<string, unknown>, entry: McpEntryLike | undefined): PreToolResult {
			const result = runPreToolHooks(
				{
					name,
					originalName: entry?.toolName,
					connectorKey: entry ? connectorScopeKey("mcp", entry.connectionId) : undefined,
					args,
					isMcp: Boolean(entry),
					isWrite: entry ? !entry.readOnly : isNativeWriteTool(name),
					parameters: input.toolset?.available.get(name)?.function.parameters as { properties?: Record<string, unknown> } | undefined,
				},
				{ lessons, succeeded, planPending: planState.pending, isToolAvailable },
			);
			if (result.hits.length > 0) input.onInspect?.({ type: "inspect_hooks", hits: result.hits.slice(0, 10) as PreToolHit[] });
			if (result.blockedLessonIds.length > 0) blockedBy.set(name, new Set([...(blockedBy.get(name) ?? []), ...result.blockedLessonIds]));
			return result;
		},
		/** A chamada rodou de verdade (não só o cartão): vale como "chamada prévia" e a regra que barrou antes ajudou. */
		noteSuccess(name: string, entry: McpEntryLike | undefined) {
			succeeded.add(name);
			if (entry) succeeded.add(entry.toolName);
			const helped = blockedBy.get(name);
			if (helped && helped.size > 0) {
				blockedBy.delete(name);
				input.onInspect?.({ type: "inspect_hooks", helped: [...helped] });
				void Promise.resolve(input.recordFeedback?.([...helped].map((id) => ({ ref: lessonRef(id), outcome: "helped" as const })))).catch(() => undefined);
			}
		},
	};
}
