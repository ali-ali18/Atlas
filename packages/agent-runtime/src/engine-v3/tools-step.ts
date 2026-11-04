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
import { TOOL_CALL_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "../tools/tool-bridge.js";
import { argProblems, coerceJsonText, coerceNumericText, jsonTextNote, unwrapEnvelope } from "./bridge.js";
import { SKIPPED_FOR_APPROVAL, SKIPPED_FOR_PARK, SKIPPED_FOR_USER_MESSAGE, closestToolNames, honestError, invalidArgsMessage, missingRequiredArgs, unknownArgs, unknownArgsMessage, normalizeToolName, notOfferedMessage, toolSignatureWithShapes, unknownToolMessage } from "./failures.js";
import { decideCall, deniedMessage, spanPolicyDecision } from "./policy.js";
import { BLOCKED_REPEATED } from "./repetition.js";
import { pollSteer } from "./steering.js";
import { hasOwnApprovalCard, nativeApprovalGate } from "./approval.js";
import { takeOwnerApprovedCall } from "./prepared.js";
import { NO_DEADLINE_NOTE, OWNER_HAS_COMPUTER, WAIT_ARG, alreadyRefusedMessage, refusedToolKey, scheduleCardDeadline, takeWaitMinutes } from "./owner-wait.js";
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
	// Toda tool do catálogo (núcleo ou manifesto) roda pelo nome: nada é "carregado" no meio do run.
	const toolOf = (name: string): ChatTool | undefined => run.catalog.entries.get(name)?.tool ?? run.tools.find((tool) => tool.function.name === name);
	const resolveName = (name: string): string | undefined => (toolOf(name) ? name : toolOf(normalizeToolName(name)) ? normalizeToolName(name) : undefined);

	/**
	 * Envelope repetido, array/objeto mandado como texto JSON e número em texto (estrutural, sem ler texto do usuário):
	 * devolve os args prontos (e os campos convertidos de texto JSON, para a nota) ou o erro com a assinatura.
	 */
	const normalizeArgs = (tool: ChatTool, args: Record<string, unknown>, acceptedNames: readonly string[]): { args: Record<string, unknown>; converted: string[] } | { error: string } => {
		const unwrapped = unwrapEnvelope(tool, args, acceptedNames);
		if ("error" in unwrapped) return { error: invalidArgsMessage(tool, unwrapped.error) };
		const json = coerceJsonText(tool, unwrapped.args);
		if ("error" in json) return { error: invalidArgsMessage(tool, json.error) };
		return { args: coerceNumericText(tool, json.args), converted: json.converted };
	};

	/**
	 * `tool_call(name, args)`: troca pela chamada real (mesmo id) antes de tudo, então política, aprovação, journal,
	 * eventos e cards veem o nome real. Nome ou args que não valem voltam como erro com a assinatura (ou nomes próximos).
	 */
	const unwrapBridge = (call: LlmToolCall): { call: LlmToolCall; error?: { name: string; summary: string }; converted?: string[] } => {
		if (call.function.name !== TOOL_CALL_TOOL_NAME) return { call };
		const bridge = toolOf(TOOL_CALL_TOOL_NAME)!;
		let outer: Record<string, unknown>;
		try {
			outer = parseArgs(call.function.arguments);
		} catch (error) {
			return { call, error: { name: TOOL_CALL_TOOL_NAME, summary: invalidArgsMessage(bridge, honestError(error)) } };
		}
		if (typeof outer.name !== "string" || !outer.name.trim()) return { call, error: { name: TOOL_CALL_TOOL_NAME, summary: invalidArgsMessage(bridge, "missing required name") } };
		const name = resolveName(outer.name.trim());
		if (!name || name === TOOL_CALL_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME) {
			if (name) return { call, error: { name: TOOL_CALL_TOOL_NAME, summary: `Call ${name} directly, not through tool_call.` } };
			const hidden = outer.name.trim();
			if (run.entryOf(hidden) || getToolMeta(hidden)) return { call: { ...call, function: { name: hidden, arguments: JSON.stringify(outer.args ?? {}) } } };
			return { call, error: { name: TOOL_CALL_TOOL_NAME, summary: unknownToolMessage(hidden, closestToolNames(hidden, [...run.catalog.entries.keys()])) } };
		}
		let inner: unknown = outer.args ?? {};
		if (typeof inner === "string") {
			try {
				inner = parseArgs(inner);
			} catch (error) {
				return { call, error: { name, summary: invalidArgsMessage(toolOf(name)!, honestError(error)) } };
			}
		}
		if (!inner || typeof inner !== "object" || Array.isArray(inner)) return { call, error: { name, summary: invalidArgsMessage(toolOf(name)!, "args must be a JSON object") } };
		const normalized = normalizeArgs(toolOf(name)!, inner as Record<string, unknown>, [name, outer.name.trim()]);
		if ("error" in normalized) return { call, error: { name, summary: normalized.error } };
		// `waitMinutes` (prazo da espera pelo dono) não é campo da tool: segue na chamada e sai em `processCall`.
		const { [WAIT_ARG]: _wait, ...declared } = normalized.args;
		const problems = argProblems(toolOf(name)!, declared);
		if (problems.length > 0) return { call, error: { name, summary: invalidArgsMessage(toolOf(name)!, problems.join("; ")) } };
		return { call: { ...call, function: { name, arguments: JSON.stringify(normalized.args) } }, converted: normalized.converted };
	};

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
	/**
	 * Falha antes de executar (nome, args, política, repetição): o modelo recebe o erro como resultado da tool. Entra na
	 * rede de repetição com a mesma escada (chave tool + args + erro): insistir na mesma recusa recebe nota e depois bloqueio.
	 */
	const refuse = async (call: LlmToolCall, sub: number, name: string, summary: string, options: { decision?: "allow" | "blocked"; argsKey?: string; checked?: boolean } = {}): Promise<CallOutcome> => {
		const argsKey = options.argsKey ?? `${name}:${call.function.arguments.slice(0, 2_000)}`;
		const base = !options.checked && run.repetition.shouldBlock({ argsKey, poll: false }) ? BLOCKED_REPEATED : summary;
		const { notes } = run.repetition.record({ argsKey, resultKey: toolResultKey(base, false), poll: false, ok: false, errorKey: `${name}|\u0000${base.slice(0, 200)}` });
		const text = notes.length > 0 ? `${base}\n\n${notes.join("\n")}` : base;
		await run.emit({ type: "tool_call", id: call.id, name, args: call.function.arguments, step: run.step });
		await run.emit({ type: "tool_result", id: call.id, name, ok: false, summary: text });
		await span(call, sub, name, false, text, options.decision ?? "blocked");
		return { call, name, ok: false, summary: text };
	};

	/** `batch.parked`: um cartão de aprovação já saiu neste lote; as outras aprovações esperam a resposta do dono. */
	const processCall = async (outerCall: LlmToolCall, sub: number, batch: { parked: boolean }): Promise<CallOutcome> => {
		const bridged = unwrapBridge(outerCall);
		if (bridged.error) return await refuse(outerCall, sub, bridged.error.name, bridged.error.summary);
		let call = bridged.call;
		// Campos que chegaram como texto JSON e foram convertidos: a nota vai junto do resultado.
		const converted = [...(bridged.converted ?? [])];
		// --- nome: exato, normalizado, escondido pela política (motivo) ou desconhecido (até 3 próximos) ---
		let name = call.function.name;
		name = resolveName(name) ?? name;
		// Continuação de um rascunho de `prepare_for_owner`: a ação escondida por falta de pessoa pode rodar UMA vez, se
		// o dono aprovou exatamente esta chamada (conferido depois de validar os args, antes da política).
		const heldTool = !toolOf(name) && run.continuesRunId ? run.heldBack.get(name) : undefined;
		if (!toolOf(name) && !heldTool) {
			// Existe mas a política tirou do catálogo: o modelo recebe o motivo, não "não existe".
			const hiddenEntry = run.entryOf(name);
			if (hiddenEntry || getToolMeta(name)) {
				let hiddenArgs: Record<string, unknown> = {};
				try { hiddenArgs = parseArgs(call.function.arguments); } catch { /* o motivo da política vale sem os args */ }
				const hidden = decideCall({ name, args: hiddenArgs, ...(hiddenEntry ? { entry: hiddenEntry } : {}), base: run.policy, autonomy: run.autonomy.get() });
				if (hidden.decision === "deny" || hidden.decision === "hide") return await refuse(call, sub, name, deniedMessage(hidden.reason), { argsKey: toolArgsKey(name, hiddenArgs) });
			}
			const near = closestToolNames(name, [...run.catalog.entries.keys()]);
			return await refuse(call, sub, name, hiddenEntry || getToolMeta(name) ? notOfferedMessage(name, near) : unknownToolMessage(name, near));
		}
		const tool = toolOf(name) ?? heldTool!;
		// --- args ---
		let args: Record<string, unknown>;
		try {
			args = parseArgs(call.function.arguments);
		} catch (error) {
			return await refuse(call, sub, name, invalidArgsMessage(tool, honestError(error)));
		}
		const normalized = normalizeArgs(tool, args, [call.function.name, name]);
		if ("error" in normalized) return await refuse(call, sub, name, normalized.error);
		converted.push(...normalized.converted);
		if (normalized.args !== args) {
			args = normalized.args;
			call = { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
		}
		// Prazo da espera pelo dono (`waitMinutes`): metadado da chamada, sai antes da chave, da política e do executor.
		const waited = takeWaitMinutes(tool, args);
		if ("error" in waited) return await refuse(call, sub, name, waited.error);
		const waitMinutes = waited.minutes;
		if (waited.args !== args) {
			args = waited.args;
			call = { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
		}
		const argsKey = toolArgsKey(name, args);
		const missing = missingRequiredArgs(tool, args);
		if (missing.length > 0) return await refuse(call, sub, name, invalidArgsMessage(tool, `missing required ${missing.join(", ")}`), { argsKey });
		const unknown = unknownArgs(tool, args);
		if (unknown.length > 0) return await refuse(call, sub, name, unknownArgsMessage(tool, unknown), { argsKey });
		// --- política (decide de verdade) ---
		const entry = run.entryOf(name);
		const pre = run.preTools.run(name, args, entry);
		if (pre.error) return await refuse(call, sub, name, pre.error, { argsKey });
		// Ação aprovada pelo dono num rascunho: a política decide como se ele estivesse aqui (o clique foi a aprovação).
		// Também com a tool visível (continuação que herdou turno humano, deploy com api antiga): tool com cartão próprio
		// (e-mail) aprovada no rascunho roda pelo caminho exato, sem o segundo cartão. As demais nativas visíveis já usam a
		// mesma aprovação no `nativeApprovalGate`.
		const approvable = Boolean(run.continuesRunId) && !entry && (Boolean(heldTool) || hasOwnApprovalCard(name));
		const ownerApproved = approvable ? await takeOwnerApprovedCall(run, name, args) : false;
		if (heldTool && !ownerApproved) {
			const hidden = decideCall({ name, args, base: run.policy, autonomy: run.autonomy.get() });
			return await refuse(call, sub, name, deniedMessage(hidden.reason), { argsKey });
		}
		const base = ownerApproved ? { ...run.policy, humanPresent: true, humanTurn: true } : run.policy;
		const verdict = decideCall({ name, args, ...(entry ? { entry } : {}), base, autonomy: run.autonomy.get(), confirmAlways: pre.forceConfirm });
		if (verdict.decision === "deny" || verdict.decision === "hide") return await refuse(call, sub, name, deniedMessage(verdict.reason), { argsKey });
		// --- rede de repetição ---
		const meta = getToolMeta(name);
		const errorTarget = `${name}|${targetOf(args)}`;
		if (run.repetition.shouldBlock({ argsKey, poll: meta?.poll === true, errorTarget })) return await refuse(call, sub, name, BLOCKED_REPEATED, { argsKey, checked: true });
		// --- `ask` em tool nativa: cartão genérico e o run estaciona (conector e tool com cartão próprio usam o deles) ---
		const nativeAsk = !ownerApproved && verdict.decision === "ask" && !entry && !hasOwnApprovalCard(name);
		if (nativeAsk) {
			// Lote paralelo: a checagem e a marca acontecem antes de qualquer await, então só um cartão sai por lote.
			if (batch.parked) {
				await run.emit({ type: "tool_result", id: call.id, name, ok: false, summary: SKIPPED_FOR_APPROVAL });
				return { call, name, ok: false, summary: SKIPPED_FOR_APPROVAL, skipped: true };
			}
			batch.parked = true;
			const gate = await nativeApprovalGate(run, name, args, waitMinutes);
			if (gate.kind !== "parked") batch.parked = false;
			if (gate.kind === "refuse") return await refuse(call, sub, name, gate.summary, { argsKey });
			if (gate.kind === "parked") {
				await run.emit({ type: "tool_call", id: call.id, name, args: call.function.arguments, step: run.step });
				await run.emit({ type: "tool_result", id: call.id, name, ok: true, summary: gate.summary });
				await run.emit(gate.card);
				await span(call, sub, name, true, gate.summary, "confirm");
				return Object.assign({ call, name, ok: true, summary: gate.summary }, { awaiting: "confirm" as const });
			}
		}

		// O dono está com o computador ("Assumir"): nada de navegador, tela ou shell da VM até ele devolver.
		if (run.ownerHasComputer && isSandboxTool(name)) return await refuse(call, sub, name, OWNER_HAS_COMPUTER, { argsKey });
		// Pergunta que o dono pulou ou deixou sem resposta neste trabalho não volta (decide com um padrão sensato).
		if (meta?.needsHuman && run.ownerRefused.has(refusedToolKey(name))) return await refuse(call, sub, name, alreadyRefusedMessage("your previous question"), { argsKey });

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
			// `ask` com humano em conector: o executor mostra o cartão dele e o run estaciona. Nativa já aprovada roda aqui.
			const outcome = await runSandboxOperation({ signal: params.abortSignal }, isSandboxTool(name) ? 180_000 : undefined, (signal) => {
				const toolCtx = ownerApproved ? { ...contextFor(call, signal, false), ownerApproved: true as const } : contextFor(call, signal, verdict.decision === "ask" && !nativeAsk);
				const own = run.toolHandlers.get(name);
				return own ? executeTool(name, args, toolCtx, own) : executeTool(name, args, toolCtx);
			});
			if (isUntrustedContentTool(name) && !(isMcpToolName(name) && outcome.confirmEvent)) await run.markUntrusted();
			summary = outcome.summary;
			const pending = (event?: { status?: string }) => Boolean(event) && (event!.status ?? "pending") === "pending";
			if (outcome.confirmEvent) { cards.push(outcome.confirmEvent); if (pending(outcome.confirmEvent)) { awaiting = "confirm"; pendingCard = true; } }
			if (outcome.skillEvent) cards.push(outcome.skillEvent);
			if (outcome.skillProposalEvent) { cards.push(outcome.skillProposalEvent); if (pending(outcome.skillProposalEvent)) awaiting ??= "skill_card"; }
			if (outcome.botProposalEvent) { cards.push(outcome.botProposalEvent); if (pending(outcome.botProposalEvent)) awaiting ??= "skill_card"; }
			if (outcome.routineEvent) cards.push(outcome.routineEvent);
			if (outcome.questionnaireEvent) {
				let questionnaire = outcome.questionnaireEvent;
				if (waitMinutes) {
					const deadlineAt = await scheduleCardDeadline(run, { card: "questionnaire", cardId: questionnaire.questionnaireId, toolName: name, what: questionnaire.title, minutes: waitMinutes });
					if (deadlineAt) questionnaire = { ...questionnaire, deadlineAt };
					else summary = `${summary} ${NO_DEADLINE_NOTE}`;
				}
				cards.push(questionnaire);
				awaiting ??= "questionnaire";
			}
			if (outcome.returnEvent) cards.push(outcome.returnEvent);
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
			if (!isSandboxTool(name) && classifyToolFailure(summary) === "argument") summary = `${summary}\nExpected: ${toolSignatureWithShapes(tool)}`;
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
		const allNotes = converted.length > 0 ? [jsonTextNote(converted), ...notes] : notes;
		const withNotes = allNotes.length > 0 ? `${summary}\n\n${allNotes.join("\n")}` : summary;
		return Object.assign({ call, name, ok, summary: withNotes, media }, awaiting ? { awaiting } : {}, login ? { login } : {}, final ? { final } : {}, meta?.endsTurn && ok ? { endsTurn: true } : {});
	};

	const parallelSafe = (outerCall: LlmToolCall) => {
		const { call, error } = unwrapBridge(outerCall);
		if (error) return false;
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
		const batchState = { parked: false };
		const outcomes: Full[] = [];
		if (calls.length > 1 && calls.every(parallelSafe)) {
			for (let at = 0; at < calls.length; at += MAX_PARALLEL_READS) outcomes.push(...(await Promise.all(calls.slice(at, at + MAX_PARALLEL_READS).map((call, index) => processCall(call, at + index, batchState)))));
		} else {
			const gate = createBatchFailureGate();
			for (const [index, call] of calls.entries()) {
				const skip = (summary: string) => ({ call, name: call.function.name, ok: false, summary, skipped: true });
				if (outcomes.some((outcome) => outcome.awaiting)) { outcomes.push(skip(SKIPPED_FOR_APPROVAL)); continue; }
				if (outcomes.some((outcome) => outcome.login)) { outcomes.push(skip(SKIPPED_FOR_PARK)); continue; }
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
				const outcome = await processCall(call, index, batchState);
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
