import { briefToolFilter } from "@workspace/agent-runtime";
import { isFollowupCheckObjective, isFollowupCheckToolAllowed, isRecheckObjective, isRecheckToolAllowed } from "@workspace/shared";
import { isDetachedBriefRun } from "./daily-brief.js";

type ToolsetLike = { toolset: { entries: ReadonlyMap<string, { readOnly: boolean }> } } | null | undefined;

/**
 * Filtro de ferramentas por tipo de run sem humano, decidido pelo próprio run (falha fechada):
 * - brief "Seu dia": só leitura (nativa da lista do brief; conector só se declarado de leitura);
 * - verificação de pendências da reflexão: só leitura;
 * - follow-up `check`: só leitura, mais rever/rearmar as próprias conferências.
 * Os demais runs não têm filtro (`undefined`).
 */
export function runToolFilter(
	run: { origin?: string | null; conversationId?: string | null; objective?: string | null },
	mcp: ToolsetLike,
): ((toolName: string) => boolean) | undefined {
	if (isDetachedBriefRun(run)) return briefToolFilter(mcp);
	const readOnly = (toolName: string) => mcp?.toolset.entries.get(toolName)?.readOnly;
	if (isRecheckObjective(run.origin, run.objective)) return (toolName) => isRecheckToolAllowed(toolName, readOnly(toolName));
	if (isFollowupCheckObjective(run.origin, run.objective)) return (toolName) => isFollowupCheckToolAllowed(toolName, readOnly(toolName));
	return undefined;
}
