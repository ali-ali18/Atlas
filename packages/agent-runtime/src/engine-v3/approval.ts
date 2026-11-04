import { createHash } from "node:crypto";
import { DEV_APPROVAL_TTL_MS, persistConversationCardFromEvent, saveSkillPendingIntent, takeToolCallApproval } from "@workspace/db";
import { ownerWaitResultText, redactSecrets, type ComputerUseEvent } from "@workspace/shared";
import { NO_DEADLINE_NOTE, alreadyRefusedMessage, refusedCallKey, scheduleCardDeadline } from "./owner-wait.js";
import { toolArgsKey } from "../progress.js";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import type { V3Run } from "./state.js";

/**
 * `ask` em tool NATIVA no motor v3 (no conector o executor já mostra o cartão dele). Tool que já tem cartão próprio
 * (metadado `ownCard`: e-mail, propostas, imagem, PR, prévia, segredo, login, sessão de código) continua com o dela.
 * As demais usam o cartão de confirmação genérico: mesmo evento `confirm` e mesmo role do cartão de conector, com a
 * intenção pendente `tool-call`.
 * Na resposta do dono, a API grava a decisão no cartão e o agente repete a MESMA chamada (chave tool + args): aprovada,
 * executa uma vez só (`takeToolCallApproval` marca como usada); recusada, volta erro honesto.
 */
export function hasOwnApprovalCard(name: string): boolean {
	return getToolMeta(name)?.ownCard === true;
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
/** Recusa (ou prazo vencido / dono que mandou outra mensagem) consumida pela continuação: pular não encerra a tarefa. */
export const approvalDeclinedText = (label: string) => ownerWaitResultText("declined", { what: label });
export const APPROVAL_UNAVAILABLE = "Needs the owner's approval, and there is no conversation to show the approval card. Ask the owner in chat instead.";
/** Teto do que o cartão mostra: acima disso o dono não teria como ler tudo o que aprova. */
export const APPROVAL_MAX_DETAIL_CHARS = 4_000;
export const APPROVAL_TOO_LARGE = `Needs the owner's approval, but the arguments are too long to show in full on the approval card (over ${APPROVAL_MAX_DETAIL_CHARS} characters). Split the action into smaller calls, or ask the owner in chat.`;

/** Nome de campo sensível: o valor nunca vai ao cartão nem à mensagem salva (só ao executor, depois da aprovação). */
const SENSITIVE_PART = /password|passwd|passphrase|pwd|token|secret|apikey|privatekey|accesskey|authorization|cookie|credential/;
const SENSITIVE_EXACT: ReadonlySet<string> = new Set(["key", "pass", "otp", "pin", "auth"]);
/** Nome do campo (protocolo da tool, não texto do usuário) em minúsculas e sem separadores. */
export function isSensitiveKey(key: string): boolean {
	const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return SENSITIVE_EXACT.has(flat) || SENSITIVE_PART.test(flat);
}
export const MASK = "••••";

function mask(value: unknown, depth = 0): unknown {
	if (depth > 8 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => mask(item, depth + 1));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, isSensitiveKey(key) ? MASK : mask(item, depth + 1)]));
}

/**
 * Texto do cartão: TODOS os argumentos que entram na chave da chamada (sem corte), com campo sensível mascarado e a
 * redação de segredo aplicada ANTES de qualquer limite. Acima de `APPROVAL_MAX_DETAIL_CHARS`: `null` (não pede aprovação cega).
 */
export function approvalDetails(args: Record<string, unknown>): string | null {
	const masked = mask(args) as Record<string, unknown>;
	const lines = Object.entries(masked).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	const text = redactSecrets(lines.join("\n") || "(sem argumentos)");
	return text.length > APPROVAL_MAX_DETAIL_CHARS ? null : text;
}

export type ApprovalGate = { kind: "run" } | { kind: "refuse"; summary: string } | { kind: "parked"; summary: string; card: Extract<ComputerUseEvent, { type: "confirm" }> };

/**
 * `waitMinutes`: prazo opcional pedido pelo modelo. Vencido, o cartão fecha como "Tempo esgotado · segui sem isso" e a
 * continuação recebe "skipped" (NUNCA aprova: só o botão "Permitir" aprova). Sem prazo, espera indefinida e sem custo.
 */
export async function nativeApprovalGate(run: V3Run, name: string, args: Record<string, unknown>, waitMinutes?: number): Promise<ApprovalGate> {
	if (!run.conversationId || run.userId === "default") return { kind: "refuse", summary: APPROVAL_UNAVAILABLE };
	const callKey = toolCallKey(name, args);
	const label = actionLabel(name);
	// A decisão só vale no run de continuação que seguiu ao cartão (semente com o run que perguntou).
	const decided = await takeToolCallApproval(run.userId, run.conversationId, callKey, run.continuesRunId).catch(() => null);
	if (decided === "approved") return { kind: "run" };
	if (decided === "declined") {
		run.ownerRefused.add(refusedCallKey(callKey));
		return { kind: "refuse", summary: approvalDeclinedText(label) };
	}
	// Recusado, pulado ou sem resposta antes neste trabalho: não pede de novo (rede de repetição do dono).
	if (run.ownerRefused.has(refusedCallKey(callKey))) return { kind: "refuse", summary: alreadyRefusedMessage(label) };
	const details = approvalDetails(args);
	if (details === null) return { kind: "refuse", summary: APPROVAL_TOO_LARGE };
	// O formato `confirm-tool<8 hex>-<runId>` liga a decisão ao run que perguntou (`askingRunId` na API).
	const confirmId = `confirm-tool${callKey.slice(0, 8)}-${run.runId}`;
	const refused = [...run.ownerRefused].slice(-50);
	await saveSkillPendingIntent({
		userId: run.userId,
		conversationId: run.conversationId,
		// Prazo maior que a validade padrão: a intenção vive até o prazo (e um pouco depois, para o job a encontrar).
		ttlMs: waitMinutes ? Math.max(DEV_APPROVAL_TTL_MS, (waitMinutes + 10) * 60_000) : DEV_APPROVAL_TTL_MS,
		payload: { kind: "confirm", action: "tool-call", confirmId, ...(run.botId ? { botId: run.botId } : {}), toolCall: { callKey, tool: name, label, ...(refused.length > 0 ? { refused } : {}), ...(waitMinutes ? { waitMinutes } : {}) } },
	});
	const deadlineAt = waitMinutes ? await scheduleCardDeadline(run, { card: "tool-call", cardId: confirmId, toolName: name, what: label, minutes: waitMinutes }) : undefined;
	const card = { type: "confirm" as const, confirmId, title: `${label}?`, description: details, confirmLabel: "Permitir", cancelLabel: "Agora não", callKey, ...(deadlineAt ? { deadlineAt } : {}) };
	await persistConversationCardFromEvent(run.conversationId, card).catch(() => undefined);
	const summary = waitMinutes && !deadlineAt ? `${APPROVAL_PARKED} ${NO_DEADLINE_NOTE}` : APPROVAL_PARKED;
	return { kind: "parked", summary, card };
}
