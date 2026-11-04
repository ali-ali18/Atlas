/**
 * Motor v3 (harness v3, desenho seções 1-2): laço burro. Continua enquanto o modelo chama tools; para quando ele
 * responde sem tool. Nada de roteador, juiz, rodapé ou portão de texto: só sinais estruturais (finish reason,
 * protocolo, lista de tarefas do próprio modelo) empurram para a frente, com teto.
 *
 *   PREPARE ─► MODEL_STEP ──tools──► TOOLS ──► MODEL_STEP …
 *                 │ sem tool               ├─ cartão/login ─► PARKED      └─ cancel ─► CANCELLED (erro de controle)
 *                 ▼                        └─ endsTurn ─► DONE
 *              SETTLE ──► DONE  (ou empurrão estrutural ─► MODEL_STEP)
 *   limite (passos/US$/tempo/repetição) ─► FINAL_STEP (toolChoice "none", tools mantidas) ─► DONE(capped)
 *   transporte esgotado ─► FAILED (o erro sobe; o worker mostra a mensagem honesta)
 *
 * Contrato igual ao do v1/v2 (`ComputerUseParams` → `RunComputerUseResult`): o worker troca de motor sem mudar o resto.
 * Só emite tipos de `RUN_EVENT_TYPES`; o fim do run (`done`/`paused`/`cancelled`/`error`) é do worker.
 */
import { persistConversationCardFromEvent } from "@workspace/db";
import type { LlmContentPart } from "@workspace/llm";
import type { RunStop } from "@workspace/shared";
import { AgentRunCancelledError, AgentRunPausedError, errorFromAbortSignal, isControlFlowError } from "../errors.js";
import { EMPTY_REPLY_FALLBACK_TEXT } from "../execution/task-state.js";
import { budgetStopFallbackText } from "../run-messages.js";
import { sanitizeAssistantText } from "../sanitize-assistant-text.js";
import { OFFERED_TOOLS_SUB_INDEX, type ComputerUseParams, type RunComputerUseResult } from "../run-types.js";
import { stopReasonPhrase } from "../engine-v2/delivery.js";
import { repairUnansweredCalls } from "./checkpoint.js";
import { createCompactor } from "./compaction.js";
import { OWNER_STOPPED_NOTE, capStop, finalStepNote, parksAtLimit, reachedCap, type CapKind } from "./limits.js";
import { canParkAtLimit, effectiveCostCap, effectiveStepLimit, parkAtLimit, resumeFromLimit, waitCapKind } from "./limit-wait.js";
import { createModelStep } from "./model-step.js";
import { RUNTIME_PREFIX, nudgeSignal, nudgeText } from "./nudges.js";
import { applyCatalogPolicy } from "./policy.js";
import { prepareRun, type EngineV3Options } from "./prepare.js";
import { flushSteer, pollSteer } from "./steering.js";
import { loginResumeText } from "./owner-wait.js";
import { createToolContextFactory } from "./tool-context.js";
import { createToolsStep, type BatchResult } from "./tools-step.js";
import type { V3Run } from "./state.js";

export type { EngineV3Options } from "./prepare.js";

export type EngineV3Deps = {
	/** Espera entre tentativas de transporte (teste injeta uma espera instantânea). */
	sleep?: (ms: number) => Promise<void>;
	transportDelaysMs?: readonly number[];
};

const hasOpenItems = (run: V3Run) => (run.ownTaskList ?? []).some((item) => item.status !== "completed");

/** Resultados do lote no histórico: pares chamada/resultado íntegros e, depois, as capturas numa mensagem só. */
function settle(run: V3Run, batch: BatchResult): void {
	const media: LlmContentPart[] = [];
	for (const outcome of batch.outcomes) {
		run.conversation.push({ role: "tool", tool_call_id: outcome.call.id, content: outcome.summary });
		media.push(...(outcome.media ?? []));
	}
	if (media.length > 0) run.conversation.push({ role: "user", content: [{ type: "text", text: `${RUNTIME_PREFIX} Current screen:` }, ...media] });
}

export async function runEngineV3(params: ComputerUseParams, options: EngineV3Options = {}, deps: EngineV3Deps = {}): Promise<RunComputerUseResult> {
	const { run, restored } = await prepareRun(params, options);
	const modelStep = createModelStep(run, deps);
	const contextFactory = createToolContextFactory(run);
	const toolsStep = createToolsStep(run, contextFactory);
	const compact = createCompactor(run, contextFactory);
	const ensureRunning = async () => {
		if (params.abortSignal?.aborted) throw errorFromAbortSignal(params.abortSignal);
		if (params.shouldContinue && !(await params.shouldContinue())) throw new AgentRunCancelledError();
		if (params.shouldPause && (await params.shouldPause())) throw new AgentRunPausedError();
	};
	const finish = async (text: string, stop: RunStop): Promise<RunComputerUseResult> => {
		await run.persistCheckpoint(run.step + 1);
		await run.flushCheckpoints();
		return { text, model: run.lastModel, hitWall: false, usage: run.usage, stop };
	};

	/** FINAL_STEP: última chamada sem tools (mantidas no pedido), resposta honesta do que fez e do que falta. Nunca aborta. */
	const finalStep = async (kind: CapKind, ownerStopped = false): Promise<RunComputerUseResult> => {
		const messageId = `${run.turnId}-final`;
		run.conversation.push({ role: "user", content: `${RUNTIME_PREFIX} ${ownerStopped ? OWNER_STOPPED_NOTE : finalStepNote(kind, !run.personWatching)}` });
		const base = capStop(kind, hasOpenItems(run));
		const stop: RunStop = ownerStopped ? { ...base, detail: `${base.detail}:owner_stopped` } : base;
		let text = "";
		try {
			text = (await modelStep({ messageId, toolChoice: "none" })).text;
		} catch (error) {
			if (params.abortSignal?.aborted) throw errorFromAbortSignal(params.abortSignal);
			if (isControlFlowError(error)) throw error;
		}
		if (!text.trim()) {
			text = budgetStopFallbackText(stopReasonPhrase(stop.reason, run.language), run.language);
			await run.emit({ type: "assistant_delta", id: messageId, delta: text });
		}
		run.conversation.push({ role: "assistant", content: text });
		return await finish(text, stop);
	};

	void Promise.resolve(
		params.onStep?.({
			decisionIndex: 0,
			subIndex: OFFERED_TOOLS_SUB_INDEX,
			type: "checkpoint",
			status: "completed",
			idempotencyKey: `${run.runId}:offered-tools`,
			outputJson: { offeredTools: run.tools.map((tool) => tool.function.name), ...(run.catalog.deferred.length > 0 ? { deferredTools: [...run.catalog.deferred] } : {}), engine: "v3" },
		}),
	).catch(() => undefined);

	try {
		// --- retomada do cartão "Cheguei no limite. Continuo?" (D4): Continuar soma o limite; Agora não = resposta final ---
		const limitWait = run.limitWait;
		if (limitWait && resumeFromLimit(run) === "stop") return await finalStep(waitCapKind(limitWait, run.limit), true);
		// --- retomada: login concluído, ou crash no meio de um lote ---
		if (run.pendingLogin) {
			const resumed = run.pendingLogin;
			run.pendingLogin = undefined;
			// Saída do cartão (PR8a): o botão grava `outcome`; sem ele o run acordou por mensagem nova do dono = "ignorou".
			// Sem botão nem mensagem (cliente antigo, retomada manual) vale o "Terminei" de sempre.
			const outcome = resumed.outcome ?? ((await pollSteer(run)) ? "ignored" : "done");
			if (outcome === "done") {
				run.conversation.push({
					role: "user",
					content: `${RUNTIME_PREFIX} The user says they finished ${resumed.reason === "captcha" ? "the verification" : "logging in"} on ${resumed.site}. Your next action must be browser_snapshot to re-read the page, then continue from where you stopped. Never type credentials.`,
				});
			} else {
				if (outcome === "takeover") run.ownerHasComputer = true;
				const message = outcome === "ignored" ? run.pendingSteer.map((input) => input.content).join("\n").slice(0, 2_000) : undefined;
				run.conversation.push({ role: "user", content: loginResumeText({ outcome, site: resumed.site, ...(resumed.what ? { what: resumed.what } : {}), ...(message !== undefined ? { message } : {}), ...(resumed.waitMinutes ? { minutes: resumed.waitMinutes } : {}) }) });
			}
			const done = { type: "login" as const, loginId: resumed.loginId, site: resumed.site, url: resumed.url, runId: run.runId, status: "done" as const, outcome, ...(resumed.reason ? { reason: resumed.reason } : {}) };
			await persistConversationCardFromEvent(run.conversationId, done).catch(() => undefined);
			await run.emit(done);
		} else if (restored) repairUnansweredCalls(run.conversation);

		let final: CapKind | undefined;
		let truncated: { id: string; raw: string } | undefined;
		for (;;) {
			await ensureRunning();
			if (await pollSteer(run)) flushSteer(run);
			final ??= reachedCap({ step: run.step, limit: effectiveStepLimit(run), spentUsd: run.spentUsd(), costCapUsd: effectiveCostCap(run), activeMs: run.activeMs(), wallCapMs: params.budget?.maxWallMs }) ?? (run.repetition.reachedFinal() ? "repeated" : undefined);
			// Sem humano, passos e US$ estacionam com o cartão "Continuo?" (o run não morre); o resto é o passo final honesto.
			if (final && parksAtLimit(final) && canParkAtLimit(run, final)) await parkAtLimit(run, final);
			if (final) return await finalStep(final);
			// Autonomia mudada no meio do run: o que a política passou a esconder sai do pedido.
			applyCatalogPolicy(run.tools, { base: run.policy, autonomy: run.autonomy.get(), entryOf: run.entryOf });
			// Compactação (4.3): poda na cópia e, se ainda passar do teto, resumo. Falhou 3 vezes: FINAL_STEP honesto.
			if ((await compact()) === "give_up") return await finalStep("context");
			await run.persistCheckpoint();

			// --- MODEL_STEP ---
			const messageId = truncated?.id ?? `${run.turnId}-step-${run.step}`;
			const reply = await modelStep({ messageId, toolChoice: "auto" });

			if (reply.toolCalls.length === 0) {
				// --- SETTLE: resposta sem tool encerra o turno, salvo um sinal estrutural com teto ---
				// Resposta cortada continua no mesmo balão: junta o texto cru (o que saiu ao vivo) e só então limpa.
				const raw = `${truncated?.raw ?? ""}${reply.raw}`;
				const text = truncated ? sanitizeAssistantText(raw) : reply.text;
				const signal = nudgeSignal(reply, run.ownTaskList);
				if (signal && run.nudges.take(signal)) {
					if (reply.text.length > 0) run.conversation.push({ role: "assistant", content: reply.text });
					// Vazio/malformado depois de um corte seguem no mesmo balão; a lista aberta é resposta completa.
					truncated = signal === "open_list" ? undefined : signal === "truncated" || truncated ? { id: messageId, raw } : undefined;
					run.conversation.push({ role: "user", content: nudgeText(signal, run.ownTaskList) });
					run.step += 1;
					continue;
				}
				truncated = undefined;
				if (!text.trim()) {
					await run.emit({ type: "assistant_delta", id: messageId, delta: EMPTY_REPLY_FALLBACK_TEXT });
					return await finish(EMPTY_REPLY_FALLBACK_TEXT, { reason: "answered", detail: "empty_reply" });
				}
				run.conversation.push({ role: "assistant", content: reply.text });
				return await finish(text, hasOpenItems(run) ? { reason: "answered", detail: "tasklist_open" } : { reason: "answered" });
			}

			// --- TOOLS ---
			truncated = undefined;
			run.conversation.push({ role: "assistant", content: reply.text.length > 0 ? reply.text : null, tool_calls: reply.toolCalls, ...(reply.providerItems ? { providerItems: reply.providerItems } : {}) });
			const batch = await toolsStep(reply.toolCalls);
			settle(run, batch);
			flushSteer(run);
			run.step += 1;
			await run.persistCheckpoint();
			await params.onStep?.({ decisionIndex: run.step - 1, subIndex: 99, type: "checkpoint", status: "completed", idempotencyKey: `${run.runId}:checkpoint:${run.step - 1}` });

			// --- PARKED: login (pausa e retoma pelo checkpoint) ou cartão que espera a pessoa ---
			if (batch.login) {
				const ask = batch.login;
				run.pendingLogin = { loginId: ask.loginId, site: ask.site, url: ask.url, ...(ask.reason === "captcha" ? { reason: "captcha" as const } : {}), ...(ask.composioToolkit ? { composioToolkit: ask.composioToolkit } : {}), ...(ask.connector ? { connector: ask.connector } : {}) };
				await run.persistCheckpoint();
				await params.onLoginRequired?.({ ...run.pendingLogin });
				throw new AgentRunPausedError("Aguardando o login do usuário");
			}
			if (batch.awaiting) {
				await run.flushCheckpoints();
				return { text: "", model: run.lastModel, hitWall: false, usage: run.usage, stop: { reason: "awaiting_confirmation", detail: batch.awaiting } };
			}
			if (batch.final) final = "repeated";
			else if (batch.endsTurn) return await finish(reply.text, { reason: "answered", detail: "ends_turn" });
		}
	} finally {
		await run.flushCheckpoints();
	}
}
