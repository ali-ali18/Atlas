import { createHash } from "node:crypto";
import { DEV_APPROVAL_TTL_MS, persistConversationCardFromEvent, saveSkillPendingIntent, takeToolCallApproval } from "@workspace/db";
import { redactSecrets, type ComputerUseEvent } from "@workspace/shared";
import { toolArgsKey } from "../progress.js";
import { previewMcpArgs } from "../tools/registry/handlers/connectors.js";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import type { V3Run } from "./state.js";

/**
 * `ask` em tool NATIVA no motor v3 (no conector o executor já mostra o cartão dele). Tool que já tem cartão próprio
 * (e-mail, propostas, imagem, PR, prévia, segredo, login) continua com o dela. As demais usam o cartão de confirmação
 * genérico: mesmo evento `confirm` e mesmo role do cartão de conector, com a intenção pendente `tool-call`.
 * Na resposta do dono, a API grava a decisão no cartão e o agente repete a MESMA chamada (chave tool + args): aprovada,
 * executa uma vez só (`takeToolCallApproval` marca como usada); recusada, volta erro honesto.
 */
const OWN_CARD_TOOLS: ReadonlySet<string> = new Set([
	"email_send",
	"email_reply",
	"email_create_mailbox",
	"generate_image",
	"preview_setup",
	"dev_pr_create",
	"request_secrets",
	"secret_request",
	"login_fill",
	"set_primary_bot",
]);

export function hasOwnApprovalCard(name: string): boolean {
	return OWN_CARD_TOOLS.has(name) || name.startsWith("propose_");
}

/** Nome da ação para o dono (pt-BR, sem nome de tool). */
const ACTION_LABELS: Readonly<Record<string, string>> = {
	page_share: "Criar um link público do painel",
	sandbox_download: "Baixar o arquivo usando a sessão do navegador do computador do bot",
	routine_group: "Alterar o grupo de rotinas (pode criar um aviso no GitHub)",
	send_to_bot: "Mandar a mensagem para o outro bot",
	decide_bot_pending: "Decidir o pedido do outro bot",
};
const EFFECT_LABELS: Readonly<Record<string, string>> = {
	read: "Ler estes dados",
	write_internal: "Fazer esta alteração",
	write_external: "Fazer uma alteração fora do Atlas",
	send: "Enviar esta mensagem",
	money: "Fazer esta operação com dinheiro",
	public_link: "Criar um link público",
	credential: "Usar um dado de acesso",
};

export function actionLabel(name: string): string {
	return ACTION_LABELS[name] ?? EFFECT_LABELS[getToolMeta(name)?.effect ?? "write_internal"] ?? "Fazer esta ação";
}

/** Chave estável da chamada (tool + args normalizados): só a mesma chamada usa a aprovação. */
export function toolCallKey(name: string, args: Record<string, unknown>): string {
	return createHash("sha256").update(toolArgsKey(name, args)).digest("hex").slice(0, 32);
}

export const APPROVAL_PARKED = "Approval card shown to the owner. Nothing was done yet: end your turn now and wait for their decision.";
export const APPROVAL_DECLINED = "The owner declined this exact action. Do not retry it; tell the user it was not done and offer an alternative if there is one.";
export const APPROVAL_UNAVAILABLE = "Needs the owner's approval, and there is no conversation to show the approval card. Ask the owner in chat instead.";

export type ApprovalGate = { kind: "run" } | { kind: "refuse"; summary: string } | { kind: "parked"; summary: string; card: Extract<ComputerUseEvent, { type: "confirm" }> };

export async function nativeApprovalGate(run: V3Run, name: string, args: Record<string, unknown>): Promise<ApprovalGate> {
	if (!run.conversationId || run.userId === "default") return { kind: "refuse", summary: APPROVAL_UNAVAILABLE };
	const callKey = toolCallKey(name, args);
	const decided = await takeToolCallApproval(run.userId, run.conversationId, callKey).catch(() => null);
	if (decided === "approved") return { kind: "run" };
	if (decided === "declined") return { kind: "refuse", summary: APPROVAL_DECLINED };
	const label = actionLabel(name);
	// O formato `confirm-...-<runId>` liga a decisão ao run que perguntou (`askingRunId` na API).
	const confirmId = `confirm-tool${callKey.slice(0, 8)}-${run.runId}`;
	await saveSkillPendingIntent({
		userId: run.userId,
		conversationId: run.conversationId,
		ttlMs: DEV_APPROVAL_TTL_MS,
		payload: { kind: "confirm", action: "tool-call", confirmId, ...(run.botId ? { botId: run.botId } : {}), toolCall: { callKey, tool: name, label } },
	});
	const card = { type: "confirm" as const, confirmId, title: `${label}?`, description: redactSecrets(previewMcpArgs(args)), confirmLabel: "Permitir", cancelLabel: "Agora não", callKey };
	await persistConversationCardFromEvent(run.conversationId, card).catch(() => undefined);
	return { kind: "parked", summary: APPROVAL_PARKED, card };
}
