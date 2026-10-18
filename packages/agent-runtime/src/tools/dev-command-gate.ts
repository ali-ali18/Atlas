import { DEV_APPROVAL_TTL_MS, findExecutedConfirmCall, getDevApprovalDefault, getDevVerifierEnabled, persistConversationCardFromEvent, saveSkillPendingIntent } from "@workspace/db";
import type { DevCommandGate } from "./dev-session.js";

/**
 * Aprovação de comandos e escritas do run: guarda a intenção pendente (a API a
 * resolve no clique do card), persiste o cartão e reconhece a chamada repetida
 * depois do "Executar" (mesmo mecanismo do `dev_pr_create`).
 */
export function createDevCommandGate(input: {
	userId: string;
	conversationId: string;
	botId?: string;
	runId?: string;
	unattended: boolean;
}): DevCommandGate {
	return {
		unattended: input.unattended,
		getAccountDefault: () => getDevApprovalDefault(input.userId),
		getVerifierEnabled: () => getDevVerifierEnabled(input.userId),
		findApproved: async (callKey) => {
			const approved = await findExecutedConfirmCall(input.conversationId, callKey, DEV_APPROVAL_TTL_MS).catch(() => null);
			return approved?.ok === true;
		},
		requestApproval: async (request) => {
			// Um card por chamada: o id leva a chave para dois pedidos no mesmo run não colidirem.
			const confirmId = `confirm-${input.runId ?? "local"}-${request.callKey.slice(0, 8)}`;
			await saveSkillPendingIntent({
				userId: input.userId,
				conversationId: input.conversationId,
				ttlMs: DEV_APPROVAL_TTL_MS,
				payload: {
					kind: "confirm",
					action: "dev-command",
					confirmId,
					botId: input.botId,
					devCommand: { callKey: request.callKey, sessionId: request.sessionId, repo: request.repo, tool: request.tool, label: request.label, prefixes: request.prefixes },
				},
			});
			const card = {
				type: "confirm" as const,
				confirmId,
				title: request.title,
				description: request.description,
				confirmLabel: request.confirmLabel,
				cancelLabel: request.cancelLabel,
				callKey: request.callKey,
				devApproval: request.card,
			};
			await persistConversationCardFromEvent(input.conversationId, card).catch(() => undefined);
			return card;
		},
	};
}
