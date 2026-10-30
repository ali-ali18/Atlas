import type { LlmContentPart, LlmMessage } from "./chat-tools.js";
import { SYSTEM_NOTE_OPEN } from "./system-notes.js";

/**
 * Cache de prompt via OpenRouter. Modelos Anthropic exigem breakpoints
 * explícitos (`cache_control: {type:"ephemeral"}` em partes de texto);
 * OpenAI/DeepSeek/Gemini 2.5 cacheiam sozinhos e não recebem nada.
 * A Anthropic aceita no máximo 4 breakpoints por request.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

export function supportsExplicitPromptCache(model: string): boolean {
	return /^anthropic\//i.test(model) || /claude/i.test(model);
}

type CacheablePart = Extract<LlmContentPart, { type: "text" }>;

export type PromptCacheTtl = "1h";

/**
 * Validade do cache de prompt da Claude: 5 minutos (padrão do provedor) ou 1 hora, ligada por
 * `ATLAS_PROMPT_CACHE_TTL=1h`. A escrita de 1 hora custa mais; vale em conversa com pausas longas entre os turnos.
 */
export function configuredCacheTtl(env: Record<string, string | undefined> = process.env): PromptCacheTtl | undefined {
	return env.ATLAS_PROMPT_CACHE_TTL?.trim().toLowerCase() === "1h" ? "1h" : undefined;
}

const ephemeral = (ttl?: PromptCacheTtl) => ({ type: "ephemeral" as const, ...(ttl ? { ttl } : {}) });

/** Marca o último texto da mensagem; devolve null se não há onde marcar. */
function withBreakpoint(message: LlmMessage, ttl?: PromptCacheTtl): LlmMessage | null {
	const { content } = message;
	if (typeof content === "string") {
		if (content.length === 0) return null;
		const part: CacheablePart = {
			type: "text",
			text: content,
			cache_control: ephemeral(ttl),
		};
		return { ...message, content: [part] };
	}
	if (!Array.isArray(content)) return null;
	for (let i = content.length - 1; i >= 0; i -= 1) {
		const part = content[i];
		if (part?.type !== "text" || part.text.length === 0) continue;
		// Nota efêmera (hora, lembretes) muda a cada passo: o breakpoint fica no texto estável antes dela.
		if (part.text.startsWith(SYSTEM_NOTE_OPEN)) continue;
		const parts = content.slice();
		parts[i] = { ...part, cache_control: ephemeral(ttl) };
		return { ...message, content: parts };
	}
	return null;
}

/**
 * Breakpoints (≤ 4), nesta ordem de valor:
 * 1. prompt de sistema (cobre também o bloco de tools, que vem antes);
 * 2. a última mensagem (grava o prefixo deste passo);
 * 3. a mensagem logo antes do último `assistant` — é exatamente o fim do
 *    request anterior, então garante o READ do cache do passo passado.
 * 4. (opcional) `stableIndex`: fim do último trecho do histórico que o
 *    runtime não reescreve mais (ex.: resultados já colapsados). O prefixo em
 *    cache cresce com o histórico em vez de ficar no prompt estático.
 * Não muta a entrada. Mensagens sem texto marcável são puladas.
 */
export function applyCacheBreakpoints(
	messages: readonly LlmMessage[],
	max: number = MAX_CACHE_BREAKPOINTS,
	options: { stableIndex?: number; ttl?: PromptCacheTtl } = {},
): LlmMessage[] {
	const out = messages.slice();
	const budget = Math.max(0, Math.min(max, MAX_CACHE_BREAKPOINTS));
	if (budget === 0 || out.length === 0) return out;

	const targets: number[] = [];
	const systemIndex = out.findIndex((m) => m.role === "system");
	if (systemIndex >= 0) targets.push(systemIndex);
	const last = out.length - 1;
	if (!targets.includes(last)) targets.push(last);
	const { stableIndex } = options;
	const stableValid =
		stableIndex !== undefined &&
		Number.isInteger(stableIndex) &&
		stableIndex >= 0 &&
		stableIndex < last &&
		!targets.includes(stableIndex);
	let beforeAssistant = -1;
	for (let i = last; i >= 0; i -= 1) {
		if (out[i]?.role !== "assistant") continue;
		beforeAssistant = i - 1;
		break;
	}
	// Um `stableIndex` DEPOIS do fim do pedido anterior (ex.: o histórico inteiro, quando camadas efêmeras vão
	// coladas no fim) vale mais que ele: é o prefixo que o próximo passo vai reler.
	if (stableValid && stableIndex! > beforeAssistant) targets.push(stableIndex!);
	if (beforeAssistant >= 0 && !targets.includes(beforeAssistant)) targets.push(beforeAssistant);
	if (stableValid && !targets.includes(stableIndex!)) targets.push(stableIndex!);

	let used = 0;
	for (const index of targets) {
		if (used >= budget) break;
		const marked = withBreakpoint(out[index] as LlmMessage, options.ttl);
		if (!marked) continue;
		out[index] = marked;
		used += 1;
	}
	return out;
}

/** Remove os breakpoints (fallback quando o provider recusa cache_control). */
export function stripCacheBreakpoints(
	messages: readonly LlmMessage[],
): LlmMessage[] {
	return messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		return {
			...message,
			content: message.content.map((part) => {
				if (part.type !== "text" || !part.cache_control) return part;
				const { cache_control: _drop, ...rest } = part;
				return rest;
			}),
		};
	});
}
