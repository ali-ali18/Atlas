import type { ChatTool } from "@workspace/llm";
import { persistConversationCardFromEvent, saveSkillPendingIntentIfFree, takeToolCallApproval } from "@workspace/db";
import { redactSecrets } from "@workspace/shared";
import { needsOwnerWithoutHuman } from "../policy/decide.js";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import type { ToolResult } from "../tools/registry/types.js";
import { actionLabel, approvalDetails, APPROVAL_MAX_DETAIL_CHARS, toolCallKey } from "./approval.js";
import { argProblems, coerceNumericText } from "./bridge.js";
import { unknownArgs, unknownArgsMessage, toolSignature } from "./failures.js";
import type { V3Run } from "./state.js";

/**
 * `prepare_for_owner` (motor v3, PR8b; desenho seção 7, regra 1). Run sem pessoa não vê envio, escrita externa, dinheiro,
 * link público nem credencial. Em vez de "não dá", deixa a ação como rascunho no chat do dono, no cartão genérico de
 * aprovação do v3 (`confirm` com a intenção `tool-call`, marcada `prepared`). Nada executa aqui.
 * O dono aprova: a API abre o run de continuação (semente com este run), o modelo chama a MESMA ação com os MESMOS
 * args e ela roda uma vez (`takeOwnerApprovedCall` consome a aprovação). "Agora não": descartado, sem run novo.
 */

/** O dono pode aprovar o rascunho até 3 dias depois (o run sem pessoa não fica esperando: segue e termina). */
export const PREPARED_DRAFT_TTL_MS = 3 * 24 * 60 * 60_000;

export const PREPARED_DRAFT_RESULT = (label: string) =>
	`Draft created for the owner: "${label}". Nothing was done: the owner approves it (it then runs once) or dismisses it in the chat. Do not try another way to do it. In your reply, say in one short sentence that it is waiting for their approval.`;
export const PREPARE_ONE_PER_RUN = "A draft for the owner was already created in this run (one per run). Do not create another; put the rest in your reply so the owner can ask for it.";
export const PREPARE_OWNER_BUSY = "Draft not created: the owner already has another request waiting in this conversation (one at a time). Do not retry. In your reply, say what you did, what still needs the owner, and that a request of theirs is already waiting.";
export const PREPARE_NO_CONVERSATION = "Drafts for the owner need a conversation with the owner, and this run has none. Say in your reply what the owner needs to do.";

/** Tools nativas escondidas por falta de pessoa para aprovar (efeito externo), com o schema. */
export function heldBackTools(natives: readonly ChatTool[], hides: (name: string) => boolean): ReadonlyMap<string, ChatTool> {
	const held = new Map<string, ChatTool>();
	for (const tool of natives) {
		const name = tool.function.name;
		const meta = getToolMeta(name);
		if (!meta || meta.needsHuman || !hides(name)) continue;
		if (needsOwnerWithoutHuman(meta.catalogEffect ?? meta.effect)) held.set(name, tool);
	}
	return held;
}

/** Erro honesto: o rascunho não saiu, com o motivo e o que fazer. */
const draftError = (reason: string) => new Error(`Draft not created: ${reason}`);

function targetFor(run: V3Run, name: string): ChatTool {
	const target = run.heldBack.get(name);
	if (target) return target;
	if (run.catalog.entries.has(name)) throw draftError(`${name} is available in this run; call it directly (drafts are only for actions that need the owner).`);
	const accepted = [...run.heldBack.keys()].sort();
	throw draftError(accepted.length > 0 ? `"${name.slice(0, 80)}" is not an action that needs the owner here. Accepted: ${accepted.join(", ")}.` : `"${name.slice(0, 80)}" cannot be prepared: no action in this run needs the owner's approval.`);
}

/** Valida os args contra o schema da tool alvo (campo desconhecido falha com a lista dos aceitos) e normaliza como a execução. */
export function validatePreparedArgs(target: ChatTool, args: Record<string, unknown>): Record<string, unknown> {
	const unknown = unknownArgs(target, args);
	if (unknown.length > 0) throw draftError(unknownArgsMessage(target, unknown));
	const normalized = coerceNumericText(target, args);
	const problems = argProblems(target, normalized);
	if (problems.length > 0) throw draftError(`invalid arguments for ${target.function.name}: ${problems.join("; ")}. Expected: ${toolSignature(target)}.`);
	return normalized;
}

export async function prepareDraftForOwner(run: V3Run, input: { tool: string; args: Record<string, unknown>; note: string }): Promise<ToolResult> {
	if (!run.canPrepareForOwner || !run.conversationId || run.userId === "default") throw new Error(PREPARE_NO_CONVERSATION);
	const name = input.tool.trim();
	const target = targetFor(run, name);
	const args = validatePreparedArgs(target, input.args);
	if (run.draftsPrepared >= 1) throw new Error(PREPARE_ONE_PER_RUN);
	const details = approvalDetails(args);
	if (details === null) throw draftError(`the arguments are too long to show in full on the owner's card (over ${APPROVAL_MAX_DETAIL_CHARS} characters). Make it shorter.`);
	const callKey = toolCallKey(name, args);
	// Mesmo formato do cartão genérico: `confirm-tool<8 hex>-<runId>` liga a aprovação a ESTE run (semente da continuação).
	const confirmId = `confirm-tool${callKey.slice(0, 8)}-${run.runId}`;
	const label = actionLabel(name);
	// Nunca sobrescreve um pedido vivo do dono nesta conversa (um por conversa): sem rascunho, resposta honesta.
	const saved = await saveSkillPendingIntentIfFree({
		userId: run.userId,
		conversationId: run.conversationId,
		ttlMs: PREPARED_DRAFT_TTL_MS,
		payload: { kind: "confirm", action: "tool-call", confirmId, ...(run.botId ? { botId: run.botId } : {}), toolCall: { callKey, tool: name, label, prepared: true } },
	});
	if (!saved) throw new Error(PREPARE_OWNER_BUSY);
	run.draftsPrepared += 1;
	// O contador vai ao checkpoint já: depois de uma retomada (limite, queda) o "um por run" continua valendo.
	await run.persistCheckpoint().catch(() => undefined);
	const note = redactSecrets(input.note.trim());
	const card = { type: "confirm" as const, confirmId, title: `${label}?`, description: `${note}\n\n${details}`, confirmLabel: "Permitir", cancelLabel: "Agora não", callKey };
	await persistConversationCardFromEvent(run.conversationId, card).catch(() => undefined);
	await run.emit(card);
	return { summary: PREPARED_DRAFT_RESULT(label) };
}

/**
 * Run de continuação de um rascunho aprovado: a ação só roda pelo caminho aprovado se o dono aprovou EXATAMENTE esta
 * chamada (tool + args) no cartão do run que preparou. Consome a aprovação (uma execução só). Quem chama decide se a
 * tool pode usar este caminho (escondida por falta de pessoa, ou com cartão próprio).
 */
export async function takeOwnerApprovedCall(run: V3Run, name: string, args: Record<string, unknown>): Promise<boolean> {
	if (!run.continuesRunId || !run.conversationId || run.userId === "default") return false;
	const decided = await takeToolCallApproval(run.userId, run.conversationId, toolCallKey(name, args), run.continuesRunId, PREPARED_DRAFT_TTL_MS).catch(() => null);
	return decided === "approved";
}
