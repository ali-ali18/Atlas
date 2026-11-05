// O laço burro do motor v4. Estados explícitos e serializáveis:
//
//   PREPARE → MODEL → TOOLS → SETTLE → PREPARE …
//                       └→ PARKED (aprovação/handoff; a retomada volta a TOOLS)
//   PREPARE (limite) → FINAL (um passo de resposta honesta) → DONE
//   MODEL sem tool call → DONE
//
// O kernel não empurra comportamento: resposta sem tool encerra o turno. Só há retries de transporte
// (model-step.ts), as travas que protegem o dono (limits.ts) e o laço infinito (loop-guard.ts).
import { createLoadedSet } from "../capabilities/index.js";
import { channelMessage, type RunNonce } from "../channels/index.js";
import { createExecutor, RunProvenance, redactDeep } from "../contract/index.js";
import type { LlmToolSpec } from "../ports/llm.js";
import type { Tool } from "../tools/define-tool.js";
import { createAskOwnerTool, ASK_OWNER_TOOL } from "./ask-owner.js";
import { declinedOffersNote, emptyConversation, openOffer, settleOffers } from "./offers.js";
import { finalStepNote, reachedLimit, spendText } from "./limits.js";
import { observeCall, REPEAT_NOTE, signatureOf } from "./loop-guard.js";
import { compactContext, contextTokens, DEFAULT_COMPACT_RATIO, DEFAULT_KEEP_RECENT, shouldCompact } from "./compaction.js";
import { callModel } from "./model-step.js";
import { addRuntimeNote, initSnapshot, isSnapshot, saveCheckpoint } from "./session.js";
import { runPending } from "./tool-step.js";
import { createNoteReadTool, DEFAULT_PAGE_CHARS, fitOutput } from "./work-notes.js";
import type { KernelEvent, KernelState, PendingCall, RunAgentDeps, RunResult } from "./types.js";

export async function runAgent(deps: RunAgentDeps): Promise<RunResult> {
	const { ports, runId, ownerId, registry } = deps;
	const conversationId = deps.input.conversationId;

	/** Fecha as ofertas abertas (ignorada = o dono falou sem tocar no cartão) e devolve o aviso de `declinedOffers`. Não herda tarefa nenhuma. */
	async function offerNotes(): Promise<string[]> {
		if (!conversationId) return [];
		const before = await ports.store.conversations.get(ownerId, conversationId);
		const ownerSpoke = deps.input.history.at(-1)?.kind === "owner";
		const after = settleOffers(before, { responses: deps.input.cardResponses ?? [], ownerSpoke });
		if (JSON.stringify(after) !== JSON.stringify(before)) await ports.store.conversations.save(ownerId, conversationId, after);
		const note = declinedOffersNote(after.declinedOffers);
		return note ? [note] : [];
	}

	const emit = async (e: KernelEvent) => void (await ports.events.emit({ type: e.type, runId, userId: ownerId, data: e.data }));

	const saved = await ports.store.runs.loadCheckpoint(ownerId, runId);
	const resumed = saved !== null && isSnapshot(saved.payload);
	const snap = resumed ? structuredClone(saved.payload as ReturnType<typeof initSnapshot>) : initSnapshot(deps.input, ports, await offerNotes());
	if (resumed && saved.state === "DONE" && snap.result) return snap.result;

	const loaded = createLoadedSet(registry, snap.loadedIds);
	const executor = createExecutor({ runId, ownerId, ports, hash: deps.hash, policy: deps.policy, provenance: RunProvenance.restore(snap.provenance), ...(deps.signal && { signal: deps.signal }) });
	const pageChars = deps.options?.pageChars ?? DEFAULT_PAGE_CHARS;
	const kernelTools: readonly Tool[] = [createNoteReadTool(pageChars), createAskOwnerTool()];
	const toolMap = () => new Map<string, Tool>([...kernelTools, ...loaded.toolsForModel()].map((t) => [t.name, t]));
	const specs = (): LlmToolSpec[] => [...kernelTools.map((t) => t.toLlmToolSpec()), ...loaded.specsForModel()];
	const save = async (state: KernelState) => {
		snap.loadedIds = [...loaded.loadedIds()];
		snap.provenance = executor.provenance.snapshot();
		await saveCheckpoint(ports, ownerId, runId, state, snap);
	};
	const fit = (call: PendingCall, text: string) => fitOutput({ store: ports.store, ownerId, runId, callId: call.id, toolName: call.name, text, pageChars });

	let state: KernelState = resumed ? (saved.state === "PARKED" ? "TOOLS" : saved.state) : "PREPARE";
	if (!resumed) await save("PREPARE");
	await ports.store.runs.setStatus(ownerId, runId, "running");

	async function finish(status: RunResult["status"], text: string, extra: Partial<RunResult> = {}): Promise<RunResult> {
		const result: RunResult = { status, text, steps: snap.step, spentUsd: snap.spentUsd, unresolved: { ...snap.lastErrors }, ...(snap.stop && { stop: snap.stop }), ...extra };
		if (status === "parked") {
			await save("PARKED");
			await ports.store.runs.setStatus(ownerId, runId, "parked");
			return { ...result, parked: { ...snap.parked } };
		}
		snap.result = result;
		await save("DONE");
		await ports.store.runs.setStatus(ownerId, runId, status === "failed" ? "failed" : "done");
		await emit({ type: "final", data: { text, status, steps: snap.step, spentUsd: snap.spentUsd, ...(snap.stop && { stop: snap.stop }) } });
		return result;
	}
	const endStatus = (): RunResult["status"] => (snap.stop || Object.keys(snap.lastErrors).length > 0 ? "not_done" : "done");

	/** Cartão de pergunta/oferta: mostra, registra a oferta (se houver) e encerra o turno. */
	async function showQuestion(asked: PendingCall): Promise<string> {
		const args = asked.args as { question?: string; offer?: string };
		const cardId = `${runId}:${asked.id}`;
		await emit({ type: "card", data: { kind: "ask_owner", cardId, question: args.question ?? "", ...(args.offer && { offer: args.offer }) } });
		if (asked.name === ASK_OWNER_TOOL && args.offer && conversationId) {
			const state = await ports.store.conversations.get(ownerId, conversationId);
			await ports.store.conversations.save(ownerId, conversationId, openOffer(state ?? emptyConversation(), { cardId, label: args.offer }));
		}
		return cardId;
	}

	/** Compacta só com a janela do modelo quase cheia (nunca por custo): flush no caderno, depois resumo. */
	async function maybeCompact() {
		const window = await ports.llm.contextWindow("main");
		const ratio = deps.options?.compactAtRatio ?? DEFAULT_COMPACT_RATIO;
		if (!shouldCompact(contextTokens(snap), window, ratio)) return;
		const done = await compactContext({ snap, llm: ports.llm, store: ports.store, ownerId, runId, keepRecent: deps.options?.keepRecent ?? DEFAULT_KEEP_RECENT });
		if (!done) return;
		const why = done.summaryFailed ? ` The summary failed (${done.summaryFailed}); the full material is in work note ${done.noteId}.` : "";
		await emit({ type: "status", data: { reason: "compacted", message: `Conversation compacted: about ${done.before} tokens before, ${done.after} after.${why}` } });
	}

	try {
		for (;;) {
			if (state === "PREPARE") {
				const hit = reachedLimit({ step: snap.step, spentUsd: snap.spentUsd, limits: deps.limits });
				if (hit) {
					snap.stop = hit;
					addRuntimeNote(snap, finalStepNote(hit.label, spendText(snap.spentUsd, snap.stepsWithoutPrice, snap.step)));
					state = "FINAL";
				} else {
					await maybeCompact();
					state = "MODEL";
				}
				await save(state);
			} else if (state === "MODEL" || state === "FINAL") {
				const isFinal = state === "FINAL";
				await emit({ type: "step", data: { step: snap.step, final: isFinal } });
				const reply = await callModel({
					llm: ports.llm,
					messages: snap.messages,
					nonce: snap.nonce as RunNonce,
					request: { role: "main", tools: specs(), ...(isFinal && { toolChoice: "none" as const }), ...(deps.signal && { signal: deps.signal }) },
					onText: (text) => emit({ type: "text_delta", data: { text } }),
				});
				if (reply.costUsd === undefined) snap.stepsWithoutPrice++;
				else snap.spentUsd += reply.costUsd;
				snap.lastText = reply.text;
				snap.lastInputTokens = reply.inputTokens;
				snap.tokensAtCount = snap.messages.length;
				if (reply.problem === "model_error") {
					await emit({ type: "status", data: { reason: "model_error", message: "The model call failed twice in a row; the run was stopped." } });
					return await finish("failed", reply.text, { reason: "model_error" });
				}
				if (reply.text.length > 0 || reply.calls.length > 0) snap.messages.push({ role: "assistant", content: reply.text, ...(reply.calls.length > 0 && !isFinal && { toolCalls: reply.calls }) });
				if (reply.problem === "empty_reply") await emit({ type: "status", data: { reason: "empty_reply", message: "The model returned an empty reply twice (no text and no tool call)." } });
				if (reply.problem === "truncated") await emit({ type: "status", data: { reason: "truncated", message: "The reply hit the output length limit again after one continuation." } });
				if (isFinal && reply.calls.length > 0) await emit({ type: "status", data: { reason: "final_step_tools_ignored", message: "Tool calls in the final step were not run." } });
				if (isFinal || reply.calls.length === 0) return await finish(endStatus(), reply.text, reply.problem ? { reason: reply.problem } : {});
				snap.pending = reply.calls.map((c) => ({ id: c.id, name: c.name, args: c.args }));
				snap.results = {};
				snap.malformedNow = 0;
				state = "TOOLS";
				await save(state);
			} else if (state === "TOOLS") {
				const { malformed } = await runPending({ tools: toolMap(), executor, snap, emit, fit, ...(deps.input.resume && { resume: deps.input.resume }) });
				snap.malformedNow += malformed;
				if (Object.keys(snap.parked).length > 0) return await finish("parked", "");
				state = "SETTLE";
			} else if (state === "SETTLE") {
				let guardAction: "ok" | "note" | "final" = "ok";
				for (const call of snap.pending) {
					const content = snap.results[call.id] ?? "";
					snap.messages.push(channelMessage(snap.nonce as RunNonce, { kind: "data", source: `tool:${call.name}`, text: content, toolCallId: call.id }));
					const verdict = observeCall(snap.guard, signatureOf(call.name, call.args, content));
					snap.guard = verdict.state;
					if (verdict.action !== "ok") guardAction = verdict.action;
				}
				const asked = snap.endedBy ? snap.pending.find((c) => c.id === snap.endedBy) : undefined;
				snap.pending = [];
				snap.results = {};
				snap.step++;
				if (asked) return await finish(endStatus(), snap.lastText, { awaiting: await showQuestion(asked) });
				snap.malformedStreak = snap.malformedNow > 0 ? snap.malformedStreak + 1 : 0;
				if (snap.malformedStreak > 1) {
					await emit({ type: "status", data: { reason: "malformed_tool_call", message: "The model sent malformed tool calls twice in a row after being shown the error; the run was stopped." } });
					return await finish("not_done", "", { reason: "malformed_tool_call" });
				}
				if (guardAction === "note") addRuntimeNote(snap, REPEAT_NOTE);
				if (guardAction === "final") {
					snap.stop = { kind: "repeated", label: "repeated identical calls" };
					addRuntimeNote(snap, finalStepNote("repeated identical calls that were not making progress", spendText(snap.spentUsd, snap.stepsWithoutPrice, snap.step)));
					state = "FINAL";
				} else state = "PREPARE";
				await save(state);
			} else return await finish(endStatus(), "");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const aborted = deps.signal?.aborted === true;
		await emit({ type: "status", data: { reason: aborted ? "cancelled" : "kernel_error", message: aborted ? "The run was cancelled." : redactDeep(message) } });
		await ports.store.runs.setStatus(ownerId, runId, aborted ? "cancelled" : "failed");
		return { status: "failed", text: "", steps: snap.step, spentUsd: snap.spentUsd, unresolved: { ...snap.lastErrors }, reason: aborted ? "cancelled" : "kernel_error" };
	}
}
