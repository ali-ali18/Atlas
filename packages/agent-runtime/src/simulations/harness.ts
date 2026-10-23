import type { ChatTool, CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { applyComputerUseEventsToTranscript, type ComputerUseEvent } from "@workspace/shared";
import { runComputerUse } from "../computer-use.js";
import { MESSAGE_TRIAGE_SYSTEM } from "../loop/message-triage.js";
import { appendedToolNotes } from "../loop/tool-result-notes.js";

/**
 * Simulação de conversa de ponta a ponta: `runComputerUse` de verdade com um LLM roteirizado (sem rede). Guarda o
 * que é observável: eventos, balões do chat (ao vivo + rascunhos revisados), texto final e o que o modelo recebeu.
 */

export type Turn = CompleteChatWithToolsResult;

export const say = (content: string): Turn => ({ model: "sim", message: { role: "assistant", content }, finishReason: "stop" });

export function calls(...items: Array<[string, Record<string, unknown>]>): Turn {
	const toolCalls: LlmToolCall[] = items.map(([name, args], index) => ({ id: `sim_${name}_${index}_${Math.random().toString(36).slice(2, 7)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
	return { model: "sim", message: { role: "assistant", content: null, tool_calls: toolCalls }, finishReason: "tool_calls" };
}

export type ModelRequest = { messages: LlmMessage[]; tools: string[]; toolSchemas: ChatTool[] };

export type Simulation = {
	text: string;
	error?: unknown;
	events: Array<ComputerUseEvent & Record<string, unknown>>;
	requests: ModelRequest[];
	/** Balões visíveis no chat (texto), sem os rascunhos revisados. */
	visible: string[];
	/** Rascunhos revisados (continuam no chat, recolhidos) com o motivo. */
	revised: Array<[string, string]>;
	/** Mensagens de sistema do pedido `index` (o 1º passo é 0). */
	system: (index?: number) => string;
	/** Avisos do runtime anexados aos resultados de tool no pedido `index`. */
	notes: (index?: number) => string[];
	toolResults: Array<{ name: string; ok: boolean; summary: string }>;
	discards: string[];
};

export type SimulateInput = {
	/** `system` só para a marcação do histórico (TRANSCRIPT_SLOT) num 2º turno. */
	messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	script: Turn[] | ((index: number, request: CompleteChatWithToolsParams) => Turn);
	model?: string;
	language?: "pt-BR" | "en-US" | "es-ES";
	origin?: string;
	jev?: unknown;
	maxSteps?: number;
	/** Respostas das chamadas baratas de sim/não (arquivo prometido/corrigir arquivo); padrão: "não". */
	cheapAnswer?: string;
	extra?: Record<string, unknown>;
};

export async function simulate(input: SimulateInput): Promise<Simulation> {
	const events: Simulation["events"] = [];
	const requests: ModelRequest[] = [];
	let index = 0;
	let text = "";
	let error: unknown;
	try {
		const options: Parameters<typeof runComputerUse>[0] = {
			manager: {} as SandboxManager,
			getSessionId: async () => {
				throw new Error("simulação sem sandbox");
			},
			sandboxEnabled: false,
			apiKey: "sim",
			model: input.model ?? "sim/model",
			runId: "run-sim",
			userId: "user-sim",
			botId: "bot-sim",
			conversationId: "conv-sim",
			origin: input.origin ?? "chat",
			contextEconomy: true,
			messages: input.messages,
			maxSteps: input.maxSteps ?? 10,
			...(input.language ? { language: input.language } : {}),
			...(input.jev ? { jev: input.jev as Parameters<typeof runComputerUse>[0]["jev"] } : {}),
			onEvent: (event) => {
				events.push(event as Simulation["events"][number]);
			},
			streamChat: async (params, handlers) => {
				// Chamadas baratas de sim/não sobre a resposta (sem tools, toolChoice none): não são passos do roteiro.
				if (params.tools.length === 0 && params.toolChoice === "none" && String(params.messages[0]?.content).includes("Answer JSON only")) {
					return { model: "sim", message: { role: "assistant", content: input.cheapAnswer ?? '{"promisesFile": false, "fixFile": false}' } };
				}
				// Triagem da mensagem do meio do run: indisponível na simulação (o modelo principal decide, cabeçalho neutro).
				if (String(params.messages[0]?.content).startsWith(MESSAGE_TRIAGE_SYSTEM)) throw new Error("triagem indisponível na simulação");
				requests.push({ messages: structuredClone(params.messages), tools: params.tools.map((tool) => tool.function.name), toolSchemas: params.tools });
				const turn = typeof input.script === "function" ? input.script(index, params) : (input.script[index] ?? say("(fim do roteiro)"));
				index += 1;
				const content = turn.message.content ?? "";
				for (let at = 0; at < content.length; at += 16) handlers?.onDelta?.(content.slice(at, at + 16));
				return { ...turn, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
			},
		};
		const result = await runComputerUse({ ...options, ...(input.extra ?? {}) });
		text = result.text;
	} catch (caught) {
		error = caught;
	}
	const transcript = applyComputerUseEventsToTranscript([], events as unknown as ComputerUseEvent[]);
	const textOf = (message: LlmMessage) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content));
	return {
		text,
		error,
		events,
		requests,
		visible: transcript.filter((bubble) => !bubble.revised && bubble.text.trim()).map((bubble) => bubble.text),
		revised: transcript.filter((bubble) => bubble.revised).map((bubble) => [bubble.text, String(bubble.revised)]),
		system: (at = 0) => (requests[at]?.messages ?? []).filter((message) => message.role === "system").map(textOf).join("\n"),
		notes: (at = requests.length - 1) => appendedToolNotes(requests[at]?.messages ?? []),
		toolResults: events.filter((event) => event.type === "tool_result").map((event) => ({ name: String(event.name), ok: Boolean(event.ok), summary: String(event.summary) })),
		discards: events.filter((event) => event.type === "assistant_discard").map((event) => String(event.reason)),
	};
}

/** Nenhuma mensagem `system` nova depois que o run começou (só as do início). */
export function systemAfterStart(simulation: Simulation): string[] {
	return simulation.requests.flatMap((request) => {
		const first = request.messages.findIndex((message) => message.role === "assistant");
		return first < 0 ? [] : request.messages.slice(first).filter((message) => message.role === "system").map((message) => String(message.content));
	});
}
