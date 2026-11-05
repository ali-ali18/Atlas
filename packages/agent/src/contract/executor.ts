// O executor do contrato: o ÚNICO caminho de toda chamada de tool (cláusulas 2, 3, 6, 7, 8, 11, 12).
// Ordem: classe de efeito → autorizador (metadado) → aprovação por token → execução → resultado
// sem segredo. O laço (kernel) só chama `executeCall`; nenhuma tool roda por outro caminho.
import type { Ports } from "../ports/index.js";
import type { Tool } from "../tools/define-tool.js";
import type { ToolContext } from "../tools/types.js";
import { type ApprovalGrant, type Hash, checkGrant, payloadHashOf, requestApproval } from "./approval.js";
import { type PolicyContext, authorize } from "./authorize.js";
import { RunProvenance } from "./provenance.js";
import type { CallOutcome } from "./outcome.js";
import { sanitizeText } from "./sanitize.js";

export type ExecutorDeps = {
	runId: string;
	ownerId: string;
	ports: Ports;
	hash: Hash;
	policy: PolicyContext;
	/** Proveniência do run. Para retomar, restaure de `ProvenanceSnapshot` (vai no checkpoint). */
	provenance?: RunProvenance;
	/** Valores do cofre usados neste run, para redigir mesmo sem padrão reconhecível. */
	secrets?: () => readonly string[];
	signal?: AbortSignal;
};

/** Uma chamada do modelo. `grant` vem da camada de fora (dono aprovou), nunca dos argumentos. */
export type ToolCall = { callId: string; step: number; tool: Tool; args: unknown; grant?: ApprovalGrant };

const HIDDEN_MESSAGE =
	"This action is not available in this context. Tell the owner what you would do and offer what is possible: a draft, a note, or preparing it for them to confirm in the chat. Do not retry it.";
const HIDDEN_USER = "Isso não está disponível aqui. Posso deixar preparado para você confirmar na conversa.";
const INTERRUPTED_HINT =
	"This write was started in an earlier attempt and never confirmed, so it may or may not have happened. Do not repeat it blindly: check the target first (or ask the owner), then decide.";
const ALREADY_DONE_HINT = "This exact call already finished successfully earlier in this run. Do not repeat it; use the receipt.";
const HANDOFF_MESSAGE = "This step is always the owner's. Explain what they need to do and wait; do not attempt it.";
const HANDOFF_USER = "Esse passo é só seu. Te explico o que fazer e espero você.";

export function createExecutor(deps: ExecutorDeps) {
	/** Pedidos de aprovação já executados neste run: o grant vale uma vez. */
	const consumed = new Set<string>();
	const provenance = deps.provenance ?? new RunProvenance();
	const secrets = () => deps.secrets?.() ?? [];

	async function executeCall(call: ToolCall): Promise<CallOutcome> {
		const { tool, args } = call;
		const effect = tool.effectFor(args);
		const riskFacts = tool.riskFactsFor(args);
		let payloadHash: string;
		try {
			payloadHash = payloadHashOf(tool.name, args, deps.hash);
		} catch (error) {
			return { status: "error", error: sanitizeText(`Arguments for ${tool.name} cannot be serialized: ${(error as Error).message}`, secrets()) };
		}

		const verdict = authorize({
			...deps.policy,
			effect,
			toolName: tool.name,
			handoffKind: tool.handoffKindFor(args),
			taint: { untrustedReadInRun: provenance.untrustedReadInRun, argsCarryUntrusted: provenance.carries(args) },
			riskFacts,
			now: deps.ports.clock.now(),
		});

		if (verdict.kind === "handoff") return { status: "handoff", reason: verdict.reason, message: HANDOFF_MESSAGE, userMessage: HANDOFF_USER };
		if (verdict.kind === "hidden") return { status: "not_available", reason: verdict.reason, message: HIDDEN_MESSAGE, userMessage: HIDDEN_USER };

		// Efeito (tudo que não é `read`) passa pelo journal: a retomada nunca repete escrita às cegas (cláusula 6).
		const effectful = effect !== "read";
		const idempotencyKey = `${deps.runId}:${call.callId}:${payloadHash}`;
		const journalBase = { runId: deps.runId, userId: deps.ownerId, step: call.step, idempotencyKey, toolName: tool.name, argsHash: payloadHash } as const;
		if (effectful) {
			const prior = await deps.ports.store.journal.find(deps.ownerId, deps.runId, idempotencyKey);
			if (prior?.outcome === "started") return { status: "interrupted_write", hint: INTERRUPTED_HINT };
			if (prior?.outcome === "succeeded") return { status: "already_done", hint: ALREADY_DONE_HINT };
		}

		if (verdict.kind === "approve") {
			const request = requestApproval({ runId: deps.runId, callId: call.callId, toolName: tool.name, effect, args, riskFacts, hash: deps.hash, secrets: secrets() });
			if (!call.grant) return { status: "pending_approval", request };
			const check = checkGrant(call.grant, request, consumed);
			if (!check.ok) return { status: "approval_invalid", reason: check.reason, request };
			consumed.add(request.id);
		}

		if (effectful) await deps.ports.store.journal.append({ ...journalBase, outcome: "started" });
		const ctx: ToolContext = { runId: deps.runId, ownerId: deps.ownerId, ports: deps.ports, signal: deps.signal };
		const result = await tool.run(args, ctx);
		// Dado de fonte não confiável marca o run ANTES de voltar ao modelo (vale também para o texto de erro).
		if (tool.trust === "untrusted" && tool.source) provenance.record(result.ok ? result.summary : result.error, tool.source);
		if (!result.ok) {
			if (effectful) await deps.ports.store.journal.append({ ...journalBase, outcome: "failed" });
			return { status: "error", error: sanitizeText(result.error, secrets()), ...(result.hint && { hint: sanitizeText(result.hint, secrets()) }) };
		}
		if (effectful) {
			if (!result.receipt) {
				// O efeito pode ter acontecido: registra como feito (não repetir) e acusa a tool, nunca "sucesso".
				await deps.ports.store.journal.append({ ...journalBase, outcome: "succeeded" });
				return { status: "contract_error", error: `${tool.name} has effect "${effect}" but returned no receipt. Report this as a bug; do not retry the call.` };
			}
			const { what, where, externalId, url } = result.receipt;
			await deps.ports.store.receipts.append({
				runId: deps.runId,
				userId: deps.ownerId,
				toolName: tool.name,
				effect,
				summary: sanitizeText(what, secrets()),
				...(where && { where: sanitizeText(where, secrets()) }),
				...(externalId && { externalId }),
				...(url && { url: sanitizeText(url, secrets()) }),
				at: deps.ports.clock.now(),
			});
			await deps.ports.store.journal.append({ ...journalBase, outcome: "succeeded" });
		}
		return { status: "ok", summary: sanitizeText(result.summary, secrets()), ...(result.receipt && { receipt: result.receipt }) };
	}

	return { executeCall, provenance };
}

export type Executor = ReturnType<typeof createExecutor>;
