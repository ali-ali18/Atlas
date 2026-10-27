import { prisma } from "./client.js";

/** Run esperando o usuário (login, resposta, aprovação) só segura a VM por este tempo. */
export const VM_HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A conversa tem um run parado esperando o usuário (`waiting_user`) ou pausado no muro de login
 * (`paused`)? Nesse caso a VM guarda a tela de login que a pessoa vai terminar: o guarda de memória
 * não pode desligá-la. Escopo por dono: conversa de outro usuário devolve false.
 */
export async function conversationHoldsVm(userId: string, conversationId: string, now: Date = new Date()): Promise<boolean> {
	if (!userId.trim() || userId === "default" || !conversationId) return false;
	const run = await prisma.agentRun.findFirst({
		where: {
			userId,
			conversationId,
			status: { in: ["waiting_user", "paused"] },
			updatedAt: { gte: new Date(now.getTime() - VM_HOLD_WINDOW_MS) },
		},
		select: { id: true },
	});
	return Boolean(run);
}
