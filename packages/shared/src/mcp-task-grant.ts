/**
 * Aprovação por tarefa: regras puras (sem I/O, relógio injetado).
 *
 * Depois que o usuário aprova um cartão de escrita REVERSÍVEL de conector, a mesma tool na mesma
 * conexão e conversa passa sem cartão por um tempo e até um teto de usos. Irreversível (apagar,
 * enviar) nunca entra: cada uma continua pedindo.
 */

export const MCP_TASK_GRANT_TTL_MS = 30 * 60_000;
export const MCP_TASK_GRANT_MAX_USES = 30;

export type McpTaskGrantState = { uses: number; maxUses: number; expiresAt: Date };

/** Só `write` reversível vira concessão; `irreversible` e `read` não. */
export function canGrantMcpTask(actionClass: string | undefined): boolean {
	return actionClass === "write";
}

export function mcpTaskGrantExpiry(now: Date): Date {
	return new Date(now.getTime() + MCP_TASK_GRANT_TTL_MS);
}

export function isMcpTaskGrantUsable(grant: McpTaskGrantState, now: Date): boolean {
	return grant.uses < grant.maxUses && grant.expiresAt.getTime() > now.getTime();
}

/** "executado 3 vezes nesta tarefa" (a UI junta com "Aprovado ·"). */
export function describeMcpTaskGrantUses(uses: number): string {
	return `executado ${uses} ${uses === 1 ? "vez" : "vezes"} nesta tarefa`;
}
