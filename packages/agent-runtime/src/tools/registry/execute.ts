import { redactSecrets } from "../../mcp/sanitize.js";
import { COMPUTER_TABS_TOOL_NAME } from "../computer-tabs.js";
import { SANDBOX_RELEASE_TOOL_NAME } from "../sandbox-release.js";
import { executeRegisteredTool } from "./index.js";
import { isSandboxTool } from "./sandbox-tools.js";
import type { ToolContext, ToolResult } from "./types.js";

/**
 * Um link pode abrir em aba nova (ou a aba ativa fechar): a VM já passou para a aba certa e o
 * aviso curto vai junto do resultado da próxima ferramenta, para o modelo não agir às cegas.
 */
async function withTabNotice<T extends { summary: string }>(name: string, ctx: Pick<ToolContext, "manager" | "peekSessionId" | "nativeDeferral">, outcome: T): Promise<T> {
	if (!isSandboxTool(name) || name === SANDBOX_RELEASE_TOOL_NAME || !ctx.manager.takeTabNotice) return outcome;
	// Só espia a sessão que o run já tem: nunca sobe nem reinicia VM por causa do aviso.
	const sessionId = ctx.peekSessionId?.();
	if (!sessionId) return outcome;
	try {
		const notice = ctx.manager.takeTabNotice(sessionId);
		if (!notice) return outcome;
		// Com abas em jogo, `browser_tabs` passa a estar disponível já no próximo passo.
		if (ctx.nativeDeferral?.isDeferred(COMPUTER_TABS_TOOL_NAME)) ctx.nativeDeferral.load([COMPUTER_TABS_TOOL_NAME]);
		// Título e URL vêm da página: passam pelo redator de segredos como qualquer saída de ferramenta.
		return { ...outcome, summary: `${outcome.summary}\n[${redactSecrets(notice)}]` };
	} catch {
		return outcome;
	}
}

/**
 * Ponto único de execução de ferramentas. Cofre: o modelo só escreve marcadores; aqui o valor
 * entra (só em ferramentas de saída confiáveis; as demais com referência são recusadas) e é
 * redigido de volta em resultado, eventos e erros antes de voltar ao modelo, ao banco ou aos logs.
 */
export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	const session = ctx.secrets;
	if (!session) return await withTabNotice(name, ctx, await executeRegisteredTool(name, args, ctx));
	const prepared = await session.prepare(name, args);
	try {
		const outcome = await withTabNotice(name, ctx, await executeRegisteredTool(name, prepared.args, ctx));
		return await session.redact(outcome);
	} catch (error) {
		if (error instanceof Error && session.redactor.size > 0) {
			const message = session.redactor.text(error.message);
			if (message !== error.message) {
				const safe = new (error.constructor as new (message: string) => Error)(message);
				safe.name = error.name;
				throw safe;
			}
		}
		throw error;
	}
}

