import { runComputerUse } from "@workspace/agent-runtime";
import { applyComputerUseEventsToTranscript, TRANSCRIPT_SLOT, type ComputerUseEvent, type SerializedLlmMessage } from "@workspace/shared";
import { buildEnvironment, EVAL_BOT_ID, EVAL_USER_ID } from "./environment.js";
import type { StreamChat } from "./mock-model.js";
import type { Scenario } from "./scenario.js";
import type { RecordedModelCall, Trajectory } from "./trajectory.js";

/**
 * Executa um cenário com `runComputerUse` de verdade: o modelo é o `streamChat` dado (real via OpenRouter ou o
 * roteirizado), as tools vêm do ambiente falso. Grava a trajetória inteira (pedidos ao modelo, chamadas, eventos).
 */

type RunParams = Parameters<typeof runComputerUse>[0];

export type RunScenarioOptions = {
	model: string;
	/** Chave do OpenRouter (só repassada ao `streamChat`; nunca gravada). Vazia no modo mock. */
	apiKey: string;
	streamChat: StreamChat;
	variant?: string;
	/** Parâmetros do runtime que a variante de harness troca (ex.: `executionDiscipline: false`). */
	runtimeOverrides?: Partial<RunParams>;
	repeat?: number;
	timeoutMs?: number;
};

const textOf = (content: unknown): string => (typeof content === "string" ? content : content === null || content === undefined ? "" : JSON.stringify(content));

function hasToolTurns(scenario: Scenario): boolean {
	return scenario.history.some((message) => message.role === "tool" || "toolCalls" in message);
}

/** Histórico com chamadas de tool vai como transcrição dos turnos anteriores (mesmo caminho do worker). */
export function toRunMessages(scenario: Scenario): Pick<RunParams, "messages" | "priorTranscript"> {
	if (!hasToolTurns(scenario)) {
		return { messages: [...scenario.history.map((message) => ({ role: message.role as "user" | "assistant", content: (message as { content: string }).content })), { role: "user", content: scenario.user }] };
	}
	const priorTranscript: SerializedLlmMessage[] = scenario.history.map((message) => {
		if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
		if ("toolCalls" in message) {
			return { role: "assistant", content: message.content ?? null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
		}
		return { role: message.role, content: message.content };
	});
	return { messages: [{ role: "system", content: TRANSCRIPT_SLOT }, { role: "user", content: scenario.user }], priorTranscript };
}

export async function runScenario(scenario: Scenario, options: RunScenarioOptions): Promise<Trajectory> {
	const startedAt = Date.now();
	const env = buildEnvironment(scenario);
	const events: Array<Record<string, unknown>> = [];
	const modelCalls: RecordedModelCall[] = [];
	const delivered: string[] = [];
	const pendingSteer = [...scenario.steer];
	const abort = new AbortController();
	const timeoutMs = options.timeoutMs ?? 180_000;
	let timedOut = false;
	let text = "";
	let error: string | undefined;

	const recordingStream: StreamChat = async (params, handlers) => {
		const call: RecordedModelCall = {
			index: modelCalls.length,
			kind: params.tools.length > 0 ? "main" : "aux",
			model: params.model,
			messages: structuredClone(params.messages) as unknown[],
			tools: params.tools.map((tool) => tool.function.name),
			durationMs: 0,
		};
		modelCalls.push(call);
		const begin = Date.now();
		try {
			const result = await options.streamChat(params, handlers);
			call.response = { content: result.message.content, ...(result.message.tool_calls?.length ? { toolCalls: result.message.tool_calls.map((item) => ({ name: item.function.name, arguments: item.function.arguments })) } : {}) };
			if (result.finishReason) call.finishReason = result.finishReason;
			if (result.usage) call.usage = { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, costUsd: result.usage.costUsd, costUnknown: result.usage.costUnknown };
			return result;
		} catch (caught) {
			call.error = caught instanceof Error ? caught.message.slice(0, 300) : "erro";
			throw caught;
		} finally {
			call.durationMs = Date.now() - begin;
		}
	};

	const run = runComputerUse({
		manager: {} as RunParams["manager"],
		getSessionId: async () => {
			throw new Error("sem sandbox no eval");
		},
		sandboxEnabled: false,
		apiKey: options.apiKey,
		model: options.model,
		runId: `eval-${scenario.id}-${options.repeat ?? 0}-${Math.random().toString(36).slice(2, 8)}`,
		userId: EVAL_USER_ID,
		botId: EVAL_BOT_ID,
		origin: scenario.run.origin,
		contextEconomy: true,
		maxSteps: scenario.run.maxSteps,
		abortSignal: abort.signal,
		...toRunMessages(scenario),
		...env.params,
		onEvent: (event) => {
			const record = event as unknown as Record<string, unknown>;
			env.observe(record);
			events.push(record);
		},
		consumeSteerInputs: async () => {
			const mainCount = modelCalls.filter((call) => call.kind === "main").length;
			const ready = pendingSteer.filter((steer) => mainCount >= steer.afterModelCalls);
			for (const steer of ready) pendingSteer.splice(pendingSteer.indexOf(steer), 1);
			delivered.push(...ready.map((steer) => steer.content));
			return ready.map((steer, index) => ({ id: `steer-${index}-${mainCount}`, content: steer.content, mode: "join" }));
		},
		streamChat: recordingStream,
		...(options.runtimeOverrides ?? {}),
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			abort.abort();
			resolve("timeout");
		}, timeoutMs);
	});
	try {
		const outcome = await Promise.race([run, timeout]);
		if (outcome === "timeout") error = `tempo esgotado (${Math.round(timeoutMs / 1000)}s)`;
		else text = outcome.text;
	} catch (caught) {
		error = caught instanceof Error ? caught.message.slice(0, 500) : "erro desconhecido";
	} finally {
		clearTimeout(timer);
	}
	// Um run abortado pelo prazo pode rejeitar depois; não deixa virar rejeição sem tratamento.
	run.catch(() => undefined);

	const transcript = applyComputerUseEventsToTranscript([], events as unknown as ComputerUseEvent[]);
	const toolCalls = events
		.filter((event) => event.type === "tool_call")
		.map((event) => {
			let args: Record<string, unknown> = {};
			try {
				const parsed = JSON.parse(String(event.args ?? "{}")) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
			} catch {
				// argumento malformado: fica vazio, o texto cru vai em argsRaw
			}
			return { id: String(event.id), name: String(event.name), args, argsRaw: String(event.args ?? ""), ...(typeof event.step === "number" ? { step: event.step } : {}) };
		});
	const usage = modelCalls.map((call) => call.usage).filter((item): item is NonNullable<RecordedModelCall["usage"]> => !!item);
	return {
		scenarioId: scenario.id,
		model: options.model,
		variant: options.variant ?? "base",
		repeat: options.repeat ?? 0,
		startedAt: new Date(startedAt).toISOString(),
		durationMs: Date.now() - startedAt,
		text,
		...(error ? { error } : {}),
		...(timedOut ? { timedOut } : {}),
		modelCalls,
		toolCalls,
		toolResults: events
			.filter((event) => event.type === "tool_result")
			.map((event) => ({ id: String(event.id), name: String(event.name), ok: Boolean(event.ok), summary: textOf(event.summary), source: env.sourceOf(String(event.id), String(event.name)) })),
		events,
		visible: transcript.filter((bubble) => !bubble.revised && bubble.text.trim()).map((bubble) => bubble.text),
		revised: transcript.filter((bubble) => bubble.revised).map((bubble) => ({ text: bubble.text, reason: String(bubble.revised) })),
		discards: events.filter((event) => event.type === "assistant_discard").map((event) => String(event.reason)),
		steerDelivered: delivered,
		unmocked: [...env.unmocked],
		costUsd: usage.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
		costUnknown: usage.some((item) => item.costUnknown === true),
		tokens: { prompt: usage.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0), completion: usage.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0) },
	};
}
