import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { Scenario } from "./scenario.js";

/**
 * Modelo roteirizado do modo mock (CI): devolve os turnos de `scenario.mock` em ordem. Valida o harness (schema,
 * verificações, fiação do runner), nunca a qualidade de um modelo. Sem rede.
 */

export type StreamChat = (params: CompleteChatWithToolsParams, handlers?: { onDelta?: (delta: string) => void }) => Promise<CompleteChatWithToolsResult>;

export const MOCK_MODEL = "mock/scripted";
const DEFAULT_CHEAP_ANSWER = '{"promisesFile": false, "fixFile": false}';

export function createMockModel(scenario: Scenario): StreamChat {
	const turns = scenario.mock?.turns ?? [];
	let index = 0;
	let callSeq = 0;
	return async (params, handlers) => {
		// Chamadas auxiliares sem tools: as perguntas de sim/não sobre a resposta recebem a resposta fixa; a triagem de
		// mensagem do meio do run fica indisponível (o runtime cai no caminho neutro, como na simulação).
		if (params.tools.length === 0) {
			if (String(params.messages[0]?.content ?? "").includes("Answer JSON only")) {
				return { model: MOCK_MODEL, message: { role: "assistant", content: scenario.mock?.cheapAnswer ?? DEFAULT_CHEAP_ANSWER }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
			}
			throw new Error("chamada auxiliar indisponível no modo mock");
		}
		const turn = turns[index] ?? { say: "(fim do roteiro)" };
		index += 1;
		const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
		if ("say" in turn) {
			for (let at = 0; at < turn.say.length; at += 16) handlers?.onDelta?.(turn.say.slice(at, at + 16));
			return { model: MOCK_MODEL, message: { role: "assistant", content: turn.say }, finishReason: "stop", usage };
		}
		const toolCalls = turn.calls.map((call) => {
			callSeq += 1;
			return { id: `mock_${callSeq}`, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } };
		});
		return { model: MOCK_MODEL, message: { role: "assistant", content: null, tool_calls: toolCalls }, finishReason: "tool_calls", usage };
	};
}
