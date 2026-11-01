import type { MockTurn } from "../scenario.js";
import { MOCK_MODEL, type StreamChat } from "../mock-model.js";

/**
 * Modelo roteirizado do comparativo. Diferente do `createMockModel` dos cenários, o uso (tokens) é proporcional ao que
 * o motor de fato enviou: o prompt maior/menor de cada motor e o histórico que cresce aparecem no custo estimado.
 * Tokens ≈ caracteres / 4. Sem rede; mesma sequência de saída sempre.
 */

const approxTokens = (value: unknown) => Math.ceil((typeof value === "string" ? value : JSON.stringify(value ?? "")).length / 4);

export function createScriptedModel(turns: readonly MockTurn[]): StreamChat {
	let index = 0;
	let callSeq = 0;
	return async (params, handlers) => {
		// Perguntas de sim/não do runtime sobre a resposta (portões baratos): resposta fixa neutra.
		if (params.tools.length === 0 && String(params.messages[0]?.content ?? "").includes("Answer JSON only")) {
			return { model: MOCK_MODEL, message: { role: "assistant", content: '{"promisesFile": false, "fixFile": false}' }, usage: { promptTokens: approxTokens(params.messages), completionTokens: 8, totalTokens: 0 } };
		}
		const turn = turns[index] ?? { say: "(fim do roteiro)" };
		index += 1;
		const promptTokens = approxTokens(params.messages) + approxTokens(params.tools);
		if ("say" in turn) {
			for (let at = 0; at < turn.say.length; at += 64) handlers?.onDelta?.(turn.say.slice(at, at + 64));
			const completionTokens = approxTokens(turn.say);
			return { model: MOCK_MODEL, message: { role: "assistant", content: turn.say }, finishReason: "stop", usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
		}
		const toolCalls = turn.calls.map((call) => {
			callSeq += 1;
			return { id: `script_${callSeq}`, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } };
		});
		const completionTokens = approxTokens(toolCalls.map((call) => call.function.arguments).join("")) + 12;
		return { model: MOCK_MODEL, message: { role: "assistant", content: null, tool_calls: toolCalls }, finishReason: "tool_calls", usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
	};
}
