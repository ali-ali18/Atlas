import { isDevSessionTool, type DevSessionRuntime, type DevSessionToolName } from "../../dev-session.js";
import type { ToolResolver } from "../registry.js";
import type { ToolContext } from "../types.js";

/** Executa uma tool da sessão de código (todas de `DEV_SESSION_TOOL_NAMES`, sem lista paralela). */
export function executeDevSessionTool(
	name: DevSessionToolName,
	args: Record<string, unknown>,
	ctx: Pick<ToolContext, "devSession" | "callId">,
): ReturnType<DevSessionRuntime["execute"]> {
	if (!ctx.devSession) throw new Error("Sessões de desenvolvimento não estão habilitadas neste run.");
	return ctx.devSession.execute(name, args, ctx.callId ?? `${name}-${Date.now()}`);
}

/**
 * Toda tool da sessão de código vai para o runtime dela. Uma lista de `case` à mão deixou a prévia,
 * o PR e o CI de fora: o modelo via a tool e a execução respondia "Ferramenta desconhecida".
 * Roda antes do mapa de nomes fixos (a sessão de código sempre teve precedência).
 */
export const devSessionResolver: ToolResolver = (name) =>
	isDevSessionTool(name) ? (args, ctx) => executeDevSessionTool(name, args, ctx) : undefined;
