import type { ChatTool } from "@workspace/llm";
import { persistConversationCardFromEvent, saveSkillPendingIntentIfFree, takeToolCallApproval } from "@workspace/db";
import { decideAction, redactSecrets, type EffectiveAutonomy } from "@workspace/shared";
import type { McpToolEntry } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { needsOwnerWithoutHuman } from "../policy/decide.js";
import { collectRefs } from "../secrets/session.js";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import type { ToolResult } from "../tools/registry/types.js";
import { actionLabel, approvalDetails, APPROVAL_MAX_DETAIL_CHARS, toolCallKey } from "./approval.js";
import { argProblems, coerceJsonText, coerceNumericText, firstSentence, type CatalogEntry } from "./bridge.js";
import { unknownArgs, unknownArgsMessage, toolSignatureWithShapes } from "./failures.js";
import type { V3Run } from "./state.js";

/**
 * `prepare_for_owner` (motor v3, PR8b; desenho seção 7, regra 1). Run sem pessoa não vê envio, escrita externa, dinheiro,
 * link público nem credencial. Em vez de "não dá", deixa a ação como rascunho no chat do dono, no cartão genérico de
 * aprovação do v3 (`confirm` com a intenção `tool-call`, marcada `prepared`). Nada executa aqui.
 * O dono aprova: a API abre o run de continuação (semente com este run), o modelo chama a MESMA ação com os MESMOS
 * args e ela roda uma vez (`takeOwnerApprovedCall` consome a aprovação). "Agora não": descartado, sem run novo.
 *
 * Escrita de conector (PR8e, decisão do dono de 04/11): o alvo pode ser uma tool de conector que a política esconde sem
 * pessoa (a rotina continua só-leitura: o rascunho é a saída dela). O rascunho vira a intenção `mcp-call` marcada
 * `prepared`; no "Permitir" a API executa UMA vez, com os args exatos, direto pelo conector do dono (sem VM, sem
 * segundo cartão: o rascunho já é a confirmação do `confirmWrites`). "Agora não" descarta, sem balão nem run novo.
 */

/** O dono pode aprovar o rascunho até 3 dias depois (o run sem pessoa não fica esperando: segue e termina). */
export const PREPARED_DRAFT_TTL_MS = 3 * 24 * 60 * 60_000;

export const PREPARED_DRAFT_RESULT = (label: string) =>
	`Draft created for the owner: "${label}". Nothing was done: the owner approves it (it then runs once) or dismisses it in the chat. Do not try another way to do it. In your reply, say in one short sentence that it is waiting for their approval.`;
export const PREPARE_ONE_PER_RUN = "A draft for the owner was already created in this run (one per run). Do not create another; put the rest in your reply so the owner can ask for it.";
export const PREPARE_OWNER_BUSY = "Draft not created: the owner already has another request waiting in this conversation (one at a time). Do not retry. In your reply, say what you did, what still needs the owner, and that a request of theirs is already waiting.";
/** Anexado à recusa de uma ação escondida que pode virar rascunho. */
export const DRAFT_HINT = "It needs the owner: to leave it for their approval, call prepare_for_owner with this tool name and these exact args.";
export const PREPARE_NO_CONVERSATION = "Drafts for the owner need a conversation with the owner, and this run has none. Say in your reply what the owner needs to do.";

/** Conectores do dono neste run e o que já está visível (a escrita visível não precisa de rascunho). */
export type HeldBackConnectors = {
	mcp: McpRuntime | null;
	autonomy: EffectiveAutonomy;
	/** Filtro do run (brief, conferência, ajudante): tool fora dele não vira alvo. */
	allow: (name: string) => boolean;
	/** A tool está no catálogo deste run (núcleo ou manifesto). */
	visible: (name: string) => boolean;
};

/**
 * Tools escondidas por falta de pessoa para aprovar (efeito externo), com o schema: nativas e, com `connectors`, as de
 * escrita dos conectores do dono (só-leitura nunca; bloqueada pela autonomia nunca; fora do filtro do run nunca).
 */
export function heldBackTools(natives: readonly ChatTool[], hides: (name: string) => boolean, connectors?: HeldBackConnectors): ReadonlyMap<string, ChatTool> {
	const held = new Map<string, ChatTool>();
	for (const tool of natives) {
		const name = tool.function.name;
		const meta = getToolMeta(name);
		if (!meta || meta.needsHuman || !hides(name)) continue;
		if (needsOwnerWithoutHuman(meta.catalogEffect ?? meta.effect)) held.set(name, tool);
	}
	for (const [name, tool] of connectors?.mcp?.toolset.available ?? []) {
		const entry = connectors!.mcp!.toolset.entries.get(name);
		if (!entry || entry.readOnly || !connectors!.allow(name) || connectors!.visible(name)) continue;
		if (decideAction(connectors!.autonomy, entry.autonomyMeta) === "block") continue;
		held.set(name, tool);
	}
	return held;
}

/**
 * Entradas de busca do que só sai como rascunho (PR8e): `tool_search` acha a ação escondida e diz o caminho, sem nada
 * no prompt fixo (o "Bom dia" e o manifesto da rotina ficam iguais).
 */
export function heldBackSearchEntries(run: Pick<V3Run, "heldBack" | "entryOf">): CatalogEntry[] {
	return [...run.heldBack].map(([name, tool]) => {
		const entry = run.entryOf(name);
		return { name, tool, source: entry ? "connector" : "native", ...(entry ? { connector: entry.connectionName } : {}), summary: firstSentence(tool.function.description), draftOnly: true } satisfies CatalogEntry;
	});
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
	const json = coerceJsonText(target, args);
	if ("error" in json) throw draftError(`invalid arguments for ${target.function.name}: ${json.error}. Expected: ${toolSignatureWithShapes(target)}.`);
	const normalized = coerceNumericText(target, json.args);
	const problems = argProblems(target, normalized);
	if (problems.length > 0) throw draftError(`invalid arguments for ${target.function.name}: ${problems.join("; ")}. Expected: ${toolSignatureWithShapes(target)}.`);
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
	const entry = run.entryOf(name);
	if (entry) return await prepareConnectorDraft(run, { name, entry, args, note: input.note, details, callKey });
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
	const card = { type: "confirm" as const, confirmId, title: `${label}?`, description: `${note}\n\n${details}`, confirmLabel: "Permitir", cancelLabel: "Agora não", callKey, ownerCard: "draft" as const };
	await persistConversationCardFromEvent(run.conversationId, card).catch(() => undefined);
	await run.emit(card);
	return { summary: PREPARED_DRAFT_RESULT(label) };
}

/**
 * Rascunho de escrita de conector: a intenção `mcp-call` (a mesma que a API executa no "confirmado" do cartão do
 * conector) com `prepared`, ligada a este run e a este bot. Segredo do Cofre não vai em rascunho (o run sem pessoa não
 * escolhe o que o dono vai mandar a terceiros).
 */
async function prepareConnectorDraft(run: V3Run, input: { name: string; entry: McpToolEntry; args: Record<string, unknown>; note: string; details: string; callKey: string }): Promise<ToolResult> {
	if (!run.botId) throw new Error(PREPARE_NO_CONVERSATION);
	if (collectRefs(input.args).length > 0) throw draftError("saved secrets cannot go in a draft. Leave them out and say in your reply what the owner needs to add.");
	const confirmId = `confirm-draft${input.callKey.slice(0, 8)}-${run.runId}`;
	const label = `${input.entry.connectionName}: ${input.entry.toolName.replace(/_/g, " ")}`;
	const saved = await saveSkillPendingIntentIfFree({
		userId: run.userId,
		conversationId: run.conversationId!,
		ttlMs: PREPARED_DRAFT_TTL_MS,
		payload: {
			kind: "confirm",
			action: "mcp-call",
			confirmId,
			botId: run.botId,
			mcpCall: {
				connectionId: input.entry.connectionId,
				connectorName: input.entry.connectionName,
				toolName: input.entry.toolName,
				exposedName: input.name,
				actionClass: input.entry.actionClass === "irreversible" ? "irreversible" : "write",
				args: input.args,
				runId: run.runId,
				prepared: true,
			},
		},
	});
	if (!saved) throw new Error(PREPARE_OWNER_BUSY);
	run.draftsPrepared += 1;
	await run.persistCheckpoint().catch(() => undefined);
	const note = redactSecrets(input.note.trim());
	const card = { type: "confirm" as const, confirmId, title: `${label}?`, description: `${note}\n\n${input.details}`, confirmLabel: "Permitir", cancelLabel: "Agora não", callKey: input.callKey };
	await persistConversationCardFromEvent(run.conversationId!, card).catch(() => undefined);
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
