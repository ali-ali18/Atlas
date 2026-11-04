import type { CompleteChatWithToolsParams } from "@workspace/llm";
import type { FinishReason } from "@workspace/shared";
import { MOCK_MODEL, type StreamChat } from "../../mock-model.js";
import type { MockTurn } from "../../scenario.js";

/**
 * Modelo roteirizado do comparativo v2 x v3. Igual ao `createScriptedModel` do v1 x v2 (tokens proporcionais ao que o motor
 * de fato enviou), mais duas coisas que a avaliação precisa medir:
 * - cache de prefixo SIMULADO: tokens em cache = prefixo comum (em caracteres, /4) com o pedido anterior do MESMO run, com o
 *   piso de 1024 tokens dos provedores. A ordem é a da Anthropic (tools, depois as mensagens), então carregar uma tool no
 *   meio do run (v2) ou mudar o prompt esfria o cache e o prefixo fixo (v3) não. É simulação: mede estabilidade do prefixo,
 *   não o desconto real de um provedor;
 * - captura do tamanho de cada pedido (`toolsChars`, `requestChars`), que a trajetória não guarda (só os nomes das tools).
 */

export type ScriptTurn = MockTurn | { say: string; finishReason: FinishReason };

export type RequestCapture = {
	/** Caracteres do JSON de tools e das mensagens do pedido. */
	toolsChars: number;
	messagesChars: number;
	/** Tamanho do prefixo: tools + tudo menos a última mensagem do usuário (a fala do pedido). */
	prefixChars: number;
	promptTokens: number;
	cachedTokens: number;
	/** Pedido sem tools (resumo de compactação, verificações baratas). */
	aux: boolean;
};

/** Piso de cache dos provedores (tokens): prefixo menor não é cacheado. */
export const CACHE_MIN_TOKENS = 1024;
const approxTokens = (chars: number) => Math.ceil(chars / 4);

const serialize = (params: CompleteChatWithToolsParams): { head: string; messages: string[] } => ({
	head: JSON.stringify(params.tools),
	messages: params.messages.map((message) => JSON.stringify(message)),
});

function commonPrefixChars(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let at = 0;
	while (at < max && a.charCodeAt(at) === b.charCodeAt(at)) at += 1;
	return at;
}

/** Chars do prefixo comum entre dois pedidos (tools primeiro, depois as mensagens, em ordem). */
export function sharedPrefixChars(previous: ReturnType<typeof serialize>, current: ReturnType<typeof serialize>): number {
	const headShared = commonPrefixChars(previous.head, current.head);
	if (headShared < previous.head.length || headShared < current.head.length) return headShared;
	let shared = headShared;
	for (let index = 0; index < Math.min(previous.messages.length, current.messages.length); index += 1) {
		const a = previous.messages[index]!;
		const b = current.messages[index]!;
		if (a === b) {
			shared += a.length;
			continue;
		}
		return shared + commonPrefixChars(a, b);
	}
	return shared;
}

const isJsonGate = (params: CompleteChatWithToolsParams) => params.tools.length === 0 && String(params.messages[0]?.content ?? "").includes("Answer JSON only");

/** Texto fixo do resumo de compactação do modelo de manutenção (>= 40 caracteres para o motor aceitar). */
export const MOCK_SUMMARY_TEXT =
	"Objective: finish the multi-step review the user asked for. Done: the items read so far were confirmed by tool result and nothing needed changes. Open items: read the remaining items and report the result to the user.";

export type ScriptedV3Model = { streamChat: StreamChat; captures: RequestCapture[] };

export function createScriptedV3Model(turns: readonly ScriptTurn[]): ScriptedV3Model {
	let index = 0;
	let callSeq = 0;
	let previous: ReturnType<typeof serialize> | undefined;
	const captures: RequestCapture[] = [];

	const measure = (params: CompleteChatWithToolsParams) => {
		const current = serialize(params);
		const toolsChars = current.head.length;
		const messagesChars = current.messages.reduce((sum, item) => sum + item.length, 0);
		const lastUser = [...params.messages].reverse().find((message) => message.role === "user");
		const lastUserChars = lastUser ? JSON.stringify(lastUser).length : 0;
		const promptTokens = approxTokens(toolsChars + messagesChars);
		// Só pedidos com tools entram na cadeia de cache do run (as chamadas auxiliares têm prefixo próprio).
		const aux = params.tools.length === 0;
		let cachedTokens = 0;
		if (!aux) {
			if (previous) cachedTokens = Math.min(promptTokens, Math.floor(sharedPrefixChars(previous, current) / 4));
			if (cachedTokens < CACHE_MIN_TOKENS) cachedTokens = 0;
			previous = current;
		}
		captures.push({ toolsChars, messagesChars, prefixChars: toolsChars + messagesChars - lastUserChars, promptTokens, cachedTokens, aux });
		return { promptTokens, cachedTokens };
	};

	const streamChat: StreamChat = async (params, handlers) => {
		// Perguntas de sim/não do runtime (portões baratos): resposta fixa neutra.
		if (isJsonGate(params)) {
			const { promptTokens } = measure(params);
			return { model: MOCK_MODEL, message: { role: "assistant", content: '{"promisesFile": false, "fixFile": false}' }, usage: { promptTokens, completionTokens: 8, totalTokens: promptTokens + 8 } };
		}
		// Chamada sem tools que não é portão: o resumo de compactação.
		if (params.tools.length === 0) {
			const { promptTokens } = measure(params);
			const completionTokens = approxTokens(MOCK_SUMMARY_TEXT.length);
			return { model: MOCK_MODEL, message: { role: "assistant", content: MOCK_SUMMARY_TEXT }, finishReason: "stop", usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
		}
		const turn: ScriptTurn = turns[index] ?? { say: "(fim do roteiro)" };
		index += 1;
		const { promptTokens, cachedTokens } = measure(params);
		if ("say" in turn) {
			for (let at = 0; at < turn.say.length; at += 64) handlers?.onDelta?.(turn.say.slice(at, at + 64));
			const completionTokens = approxTokens(turn.say.length);
			return {
				model: MOCK_MODEL,
				message: { role: "assistant", content: turn.say },
				finishReason: "finishReason" in turn ? turn.finishReason : "stop",
				usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens },
			};
		}
		const toolCalls = turn.calls.map((call) => {
			callSeq += 1;
			return { id: `script_${callSeq}`, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } };
		});
		const completionTokens = approxTokens(toolCalls.map((call) => call.function.arguments).join("").length) + 12;
		return { model: MOCK_MODEL, message: { role: "assistant", content: null, tool_calls: toolCalls }, finishReason: "tool_calls", usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens } };
	};
	return { streamChat, captures };
}

/** Envolve um `streamChat` (real ou roteirizado) para capturar o tamanho dos pedidos; o mock já captura sozinho. */
export function captureRequests(inner: StreamChat): ScriptedV3Model {
	const captures: RequestCapture[] = [];
	const streamChat: StreamChat = async (params, handlers) => {
		const current = serialize(params);
		const toolsChars = current.head.length;
		const messagesChars = current.messages.reduce((sum, item) => sum + item.length, 0);
		const lastUser = [...params.messages].reverse().find((message) => message.role === "user");
		const result = await inner(params, handlers);
		captures.push({
			toolsChars,
			messagesChars,
			prefixChars: toolsChars + messagesChars - (lastUser ? JSON.stringify(lastUser).length : 0),
			promptTokens: result.usage?.promptTokens ?? approxTokens(toolsChars + messagesChars),
			cachedTokens: result.usage?.cachedTokens ?? 0,
			aux: params.tools.length === 0,
		});
		return result;
	};
	return { streamChat, captures };
}
