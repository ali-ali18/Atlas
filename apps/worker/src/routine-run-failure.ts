import { formatRoutineFailurePush } from "@workspace/shared";

export type RoutineRunFailureDeps = {
	/** Rotina que originou o run, escopada pelo dono (o db devolve null para outro usuário). */
	loadContext: (agentRunId: string, userId: string) => Promise<{ routineId: string; name: string; conversationId: string | null } | null>;
	/** Push de falha (ausente = sem chaves VAPID). Respeita o switch do bot e quem está olhando a conversa. */
	push?: (userId: string, conversationId: string, text: string) => Promise<unknown>;
};

/**
 * Run de rotina que falhou de vez: avisa o dono no celular com o motivo em pt-BR ("Sem créditos no
 * provedor do modelo — a rotina X não rodou"). O erro técnico nunca vai no texto (passa por
 * `describeRoutineFailure`, que também tira segredos). Run que não é de rotina não faz nada.
 */
export async function notifyRoutineRunFailure(
	input: { origin: string | null | undefined; agentRunId: string; userId: string | null | undefined; error: string },
	deps: RoutineRunFailureDeps,
): Promise<boolean> {
	if (input.origin !== "routine" || !input.userId || !deps.push) return false;
	try {
		const context = await deps.loadContext(input.agentRunId, input.userId);
		if (!context?.conversationId) return false;
		await deps.push(input.userId, context.conversationId, formatRoutineFailurePush({ routineName: context.name, error: input.error }));
		return true;
	} catch (error) {
		console.error(`[routine] aviso de falha não enviado run=${input.agentRunId}`, error instanceof Error ? error.message : "erro");
		return false;
	}
}
