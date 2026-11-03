import type { ChatTool, LlmContentPart, LlmToolCall } from "@workspace/llm";
import { persistConversationCardFromEvent } from "@workspace/db";
import { runSandboxOperation } from "@workspace/sandbox";
import { buildToolResultStatus, isMcpToolName, isUntrustedContentTool, type AwaitingKind, type ComputerUseEvent } from "@workspace/shared";
import { toolIdempotencyKey } from "../checkpoint.js";
import { errorFromAbortSignal, isControlFlowError } from "../errors.js";
import { INTERRUPTED_WRITE_NOTE, ToolEffectUncertainError, hashEffectArgs, isJournaledWrite } from "../execution/journal.js";
import { parseArgs } from "../parse-args.js";
import { toolArgsKey, toolResultKey } from "../progress.js";
import { MAX_PARALLEL_READS } from "../read-execution.js";
import { toolStepTelemetry } from "../telemetry/step-telemetry.js";
import { classifyToolFailure } from "../tool-failure.js";
import { BATCH_SKIPPED_MESSAGE, createBatchFailureGate } from "../tools/batch-failure.js";
import { executeTool } from "../tools/registry/execute.js";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import { isSandboxTool } from "../tools/registry/sandbox-tools.js";
import { dedupeLoginAsk, unattendedLoginOutcome } from "../engine-v2/login.js";
import { SKIPPED_FOR_PARK, SKIPPED_FOR_USER_MESSAGE, closestToolNames, honestError, invalidArgsMessage, missingRequiredArgs, normalizeToolName, toolSignature, unknownToolMessage } from "./failures.js";
import { decideCall, deniedMessage, spanPolicyDecision } from "./policy.js";
import { BLOCKED_REPEATED } from "./repetition.js";
import { pollSteer } from "./steering.js";
import type { ToolContextFactory } from "./tool-context.js";
import type { V3Run } from "./state.js";

type LoginEvent = Extract<ComputerUseEvent, { type: "login" }>;

export type CallOutcome = { call: LlmToolCall; name: string; ok: boolean; summary: string; skipped?: boolean; media?: LlmContentPart[] };

export type BatchResult = {
	outcomes: CallOutcome[];
	awaiting?: AwaitingKind;
	login?: LoginEvent;
	/** Alguma tool com `endsTurn` rodou: o turno termina depois do lote. */
	endsTurn: boolean;
	/** A guarda pós-compactação pediu o FINAL_STEP. */
	final: boolean;
};

const targetOf = (args: Record<string, unknown>) => {
	for (const key of ["ref", "url", "selector", "target", "id", "index"]) {
		const value = args[key];
		if (typeof value === "string" || typeof value === "number") return String(value).slice(0, 200);
	}
	return "";
};

/**
 * TOOLS (desenho 2.1): `policy.decide` → executar → resultado, com as notas de freio anexadas ao resultado. Leituras
 * liberadas rodam em paralelo; o resto em série, com steering entre uma e outra.
 */
export function createToolsStep(run: V3Run, contextFor: ToolContextFactory) {
	const params = run.params;
	const recentLoginAsks = { asked: new Set<string>(), loaded: false };
	const toolOf = (name: string): ChatTool | undefined => run.tools.find((tool) => tool.function.name === name);

	const span = async (call: LlmToolCall, sub: number, name: string, ok: boolean, summary: string, decision: "allow" | "confirm" | "blocked", durationMs = 0, extra: Record<string, unknown> = {}) => {
		await params.onStep?.({
			decisionIndex: run.step,
			subIndex: sub + 1,
			type: "tool_result",
			status: ok ? "completed" : "failed",
			idempotencyKey: toolIdempotencyKey({ runId: run.runId, decisionIndex: run.step, toolCallId: call.id, toolName: name }),
			durationMs,
			telemetry: toolStepTelemetry(name, durationMs, { policyDecision: decision }),
			outputJson: { summary, ok, ...extra },
		});
	};
	/** Falha antes de executar (nome, args, política, repetição): o modelo recebe o erro como resultado da tool. */
	const refuse = async (call: LlmToolCall, sub: number, name: string, summary: string, decision: "allow" | "blocked" = "blocked"): Promise<CallOutcome> => {
		await run.emit({ type: "tool_call", id: call.id, name, args: call.function.arguments, step: run.step });
		await run.emit({ type: "tool_result", id: call.id, name, ok: false, summary });
		await span(call, sub, name, false, summary, decision);
		return { call, name, ok: false, summary };
	};

	const processCall = async (call: LlmToolCall, sub: number): Promise<CallOutcome> => {
		// --- nome: exato, normalizado, adiado (carrega o grupo) ou desconhecido (até 3 próximos) ---
		let name = call.function.name;
		if (!toolOf(name) && toolOf(normalizeToolName(name))) name = normalizeToolName(name);
		if (!toolOf(name)) {
			const deferral = run.catalog.deferral;
			const deferred = deferral?.isDeferred(name) ? name : deferral?.isDeferred(normalizeToolName(name)) ? normalizeToolName(name) : undefined;
			if (deferral && deferred) {
				const { notes } = deferral.loadGroupOf(deferred);
				return await refuse(call, sub, deferred, `Tool ${deferred} was not loaded; it is loaded now. Call it again.${notes ? `\n${notes}` : ""}`, "allow");
			}
			// Existe mas a política tirou do catálogo: o modelo recebe o motivo, não "não existe".
			const hiddenEntry = run.entryOf(name);
			if (hiddenEntry || getToolMeta(name)) {
				let hiddenArgs: Record<string, unknown> = {};
				try { hiddenArgs = parseArgs(call.function.arguments); } catch { /* o motivo da política vale sem os args */ }
				const hidden = decideCall({ name, args: hiddenArgs, ...(hiddenEntry ? { entry: hiddenEntry } : {}), base: run.policy, autonomy: run.autonomy.get() });
				if (hidden.decision === "deny" || hidden.decision === "hide") return await refuse(call, sub, name, deniedMessage(hidden.reason));
			}
			const known = [...run.tools.map((tool) => tool.function.name), ...(deferral?.pending() ?? [])];
			return await refuse(call, sub, name, unknownToolMessage(name, closestToolNames(name, known)));
		}
		const tool = toolOf(name)!;
		// --- args ---
		let args: Record<string, unknown>;
		try {
			args = parseArgs(call.function.arguments);
		} catch (error) {
			return await refuse(call, sub, name, invalidArgsMessage(tool, honestError(error)));
		}
		const missing = missingRequiredArgs(tool, args);
		if (missing.length > 0) return await refuse(call, sub, name, invalidArgsMessage(tool, `missing required ${missing.join(", ")}`));
		// --- política (decide de verdade) ---
		const entry = run.entryOf(name);
		const pre = run.preTools.run(name, args, entry);
		if (pre.error) return await refuse(call, sub, name, pre.error);
		const verdict = decideCall({ name, args, ...(entry ? { entry } : {}), base: run.policy, autonomy: run.autonomy.get(), confirmAlways: pre.forceConfirm });
		if (verdict.decision === "deny" || verdict.decision === "hide") return await refuse(call, sub, name, deniedMessage(verdict.reason));
		// --- rede de repetição ---
		const meta = getToolMeta(name);
		const argsKey = toolArgsKey(name, args);
		const errorTarget = `${name}|${targetOf(args)}`;
		if (run.repetition.shouldBlock({ argsKey, poll: meta?.poll === true, errorTarget })) return await refuse(call, sub, name, BLOCKED_REPEATED);

		// --- execução (mesmo executor do v1/v2; escrita externa com journal não repete) ---
		const idempotencyKey = toolIdempotencyKey({ runId: run.runId, decisionIndex: run.step, toolCallId: call.id, toolName: name });
		await run.emit({ type: "tool_call", id: call.id, name, args: call.function.arguments, step: run.step });
		const replay = await params.findCompletedTool?.(idempotencyKey);
		if (replay) {
			await run.emit({ type: "tool_result", id: call.id, name, ok: replay.ok, summary: replay.summary });
			return { call, name, ok: replay.ok, summary: replay.summary };
		}
		const journaled = isJournaledWrite(name, entry);
		if (journaled && (await params.findStartedTool?.(idempotencyKey))) {
			await run.emit({ type: "tool_result", id: call.id, name, ok: false, summary: INTERRUPTED_WRITE_NOTE });
			return { call, name, ok: false, summary: INTERRUPTED_WRITE_NOTE };
		}
		await params.onStep?.({ decisionIndex: run.step, subIndex: sub + 1, type: "tool", status: "running", idempotencyKey, inputJson: { name, args, ...(journaled ? { attemptId: idempotencyKey, argsHash: hashEffectArgs(args) } : {}) } });
		run.toolCallCounts.set(name, (run.toolCallCounts.get(name) ?? 0) + 1);
		if (entry) run.catalog.pinMcpTool(name);
		const decision = spanPolicyDecision(verdict.decision);
		let ok = true;
		let summary = "";
		let uncertain = false;
		let pendingCard = false;
		let awaiting: AwaitingKind | undefined;
		let login: LoginEvent | undefined;
		const cards: ComputerUseEvent[] = [];
		let media: LlmContentPart[] = [];
		const startedAt = Date.now();
		try {
			// `ask` com humano: o executor mostra o cartão de confirmação existente (conector) e o run estaciona.
			const outcome = await runSandboxOperation({ signal: params.abortSignal }, isSandboxTool(name) ? 180_000 : undefined, (signal) => executeTool(name, args, contextFor(call, signal, verdict.decision === "ask")));
			if (isUntrustedContentTool(name) && !(isMcpToolName(name) && outcome.confirmEvent)) await run.markUntrusted();
			summary = outcome.summary;
			const pending = (event?: { status?: string }) => Boolean(event) && (event!.status ?? "pending") === "pending";
			if (outcome.confirmEvent) { cards.push(outcome.confirmEvent); if (pending(outcome.confirmEvent)) { awaiting = "confirm"; pendingCard = true; } }
			if (outcome.skillEvent) cards.push(outcome.skillEvent);
			if (outcome.skillProposalEvent) { cards.push(outcome.skillProposalEvent); if (pending(outcome.skillProposalEvent)) awaiting ??= "skill_card"; }
			if (outcome.botProposalEvent) { cards.push(outcome.botProposalEvent); if (pending(outcome.botProposalEvent)) awaiting ??= "skill_card"; }
			if (outcome.routineEvent) cards.push(outcome.routineEvent);
			if (outcome.questionnaireEvent) { cards.push(outcome.questionnaireEvent); awaiting ??= "questionnaire"; }
			if (outcome.profileEvent) { cards.push(outcome.profileEvent); if (pending(outcome.profileEvent)) awaiting ??= "profile"; }
			if (outcome.fileEvent) cards.push(outcome.fileEvent);
			if (!pendingCard) run.preTools.noteSuccess(name, entry);
			if (outcome.loginEvent) {
				const unattended = unattendedLoginOutcome({ event: outcome.loginEvent, summary, unattended: run.unattended });
				summary = unattended.summary;
				if (unattended.event) {
					if (!recentLoginAsks.loaded && run.userId !== "default" && params.recentLoginAsks) {
						recentLoginAsks.loaded = true;
						for (const site of (await params.recentLoginAsks().catch(() => null))?.asked ?? []) recentLoginAsks.asked.add(site);
					}
					const deduped = dedupeLoginAsk({ event: unattended.event, summary, asked: recentLoginAsks.asked });
					summary = deduped.summary;
					login = deduped.event;
				}
			}
			const shots = outcome.visionArtifactIds ?? [];
			if (outcome.image && params.persistScreenshot && outcome.image.startsWith("data:")) {
				media = [{ type: "screenshot_ref", artifactId: await params.persistScreenshot(outcome.image.replace(/^data:image\/\w+;base64,/, "")) }];
			} else if (shots.length > 0 && params.canSeeUserImages !== false) media = shots.map((artifactId): LlmContentPart => ({ type: "screenshot_ref", artifactId }));
		} catch (error) {
			if (params.abortSignal?.aborted) throw errorFromAbortSignal(params.abortSignal);
			if (isControlFlowError(error)) throw error;
			ok = false;
			if (isUntrustedContentTool(name)) await run.markUntrusted();
			uncertain = error instanceof ToolEffectUncertainError;
			summary = honestError(error);
			if (!isSandboxTool(name) && classifyToolFailure(summary) === "argument") summary = `${summary}\nExpected: ${toolSignature(tool)}`;
		}
		const durationMs = Date.now() - startedAt;
		await span(call, sub, name, ok, summary, decision, durationMs, {
			status: buildToolResultStatus({ ok, writes: journaled && !pendingCard, uncertain, code: uncertain ? "no_result" : ok ? undefined : "other" }),
		});
		await run.emit({ type: "tool_result", id: call.id, name, ok, summary });
		for (const card of cards) {
			if (card.type === "file") await persistConversationCardFromEvent(run.conversationId, card).catch(() => undefined);
			await run.emit(card);
		}
		if (login) {
			// Nesta fase o login é sempre da pessoa (sem preenchimento automático do Cofre): o cartão vai sem a oferta.
			const { vault: _offer, ...human } = login;
			login = human;
			await persistConversationCardFromEvent(run.conversationId, human).catch(() => undefined);
			await run.emit(human);
		}
		const { notes, final } = run.repetition.record({ argsKey, resultKey: toolResultKey(summary, ok), poll: meta?.poll === true, ok, ...(ok ? {} : { errorKey: `${errorTarget}\u0000${summary.slice(0, 200)}` }) });
		const withNotes = notes.length > 0 ? `${summary}\n\n${notes.join("\n")}` : summary;
		return Object.assign({ call, name, ok, summary: withNotes, media }, awaiting ? { awaiting } : {}, login ? { login } : {}, final ? { final } : {}, meta?.endsTurn && ok ? { endsTurn: true } : {});
	};

	const parallelSafe = (call: LlmToolCall) => {
		const name = call.function.name;
		const entry = run.entryOf(name);
		if (!toolOf(name) || isSandboxTool(name) || name === "update_task_list") return false;
		if (entry ? !entry.readOnly : getToolMeta(name)?.effect !== "read") return false;
		try {
			return decideCall({ name, args: parseArgs(call.function.arguments), ...(entry ? { entry } : {}), base: run.policy, autonomy: run.autonomy.get() }).decision === "allow";
		} catch {
			return false;
		}
	};

	return async (calls: LlmToolCall[]): Promise<BatchResult> => {
		if (calls.some((call) => isJournaledWrite(call.function.name, run.entryOf(call.function.name)))) await run.persistCheckpoint();
		type Full = CallOutcome & { awaiting?: AwaitingKind; login?: LoginEvent; final?: boolean; endsTurn?: boolean };
		const outcomes: Full[] = [];
		if (calls.length > 1 && calls.every(parallelSafe)) {
			for (let at = 0; at < calls.length; at += MAX_PARALLEL_READS) outcomes.push(...(await Promise.all(calls.slice(at, at + MAX_PARALLEL_READS).map((call, index) => processCall(call, at + index)))));
		} else {
			const gate = createBatchFailureGate();
			for (const [index, call] of calls.entries()) {
				const skip = (summary: string) => ({ call, name: call.function.name, ok: false, summary, skipped: true });
				if (outcomes.some((outcome) => outcome.awaiting || outcome.login)) { outcomes.push(skip(SKIPPED_FOR_PARK)); continue; }
				// Steering: a mensagem nova do usuário vale mais que o resto do lote planejado antes dela.
				if (index > 0 && (await pollSteer(run))) {
					await run.emit({ type: "tool_result", id: call.id, name: call.function.name, ok: false, summary: SKIPPED_FOR_USER_MESSAGE });
					outcomes.push(skip(SKIPPED_FOR_USER_MESSAGE));
					continue;
				}
				if (gate.shouldSkip(call.function.name)) {
					await run.emit({ type: "tool_result", id: call.id, name: call.function.name, ok: false, summary: BATCH_SKIPPED_MESSAGE });
					outcomes.push(skip(BATCH_SKIPPED_MESSAGE));
					continue;
				}
				const outcome = await processCall(call, index);
				gate.recordResult(outcome.name, outcome.ok);
				outcomes.push(outcome);
			}
		}
		const awaiting = outcomes.find((outcome) => outcome.awaiting)?.awaiting;
		const login = outcomes.find((outcome) => outcome.login)?.login;
		return {
			outcomes,
			...(awaiting ? { awaiting } : {}),
			...(login ? { login } : {}),
			endsTurn: outcomes.some((outcome) => outcome.endsTurn && !outcome.skipped),
			final: outcomes.some((outcome) => outcome.final),
		};
	};
}

export type ToolsStep = ReturnType<typeof createToolsStep>;
