import { createOpencodeGoStreamChat, createProviderStreamChat, streamChatWithTools } from "@workspace/llm";
import { parseModelRef } from "@workspace/shared";
import type { StreamChat } from "../mock-model.js";

/**
 * Modelo real da avaliação da ponte. A chave vem do AMBIENTE e nunca é impressa nem gravada:
 * - `OPENROUTER_API_KEY` (a mesma que o `packages/llm` e o worker já usam): qualquer id sem prefixo, ex. `deepseek/...`;
 * - `OPENCODE_GO_API_KEY` (nome só deste CLI: em produção a chave do OpenCode Go vive no cofre do usuário): ids `opencode-go/<slug>`.
 * Plano ChatGPT (OAuth) e Anthropic direto também são chave do usuário no cofre: aqui use o slug equivalente no OpenRouter.
 */

export const OPENROUTER_ENV = "OPENROUTER_API_KEY";
export const OPENCODE_GO_ENV = "OPENCODE_GO_API_KEY";

export type RealModel = { streamChat: StreamChat; apiKey: string; secrets: string[] };

/** Erro claro (nome da variável, nunca o valor) para o que falta ou não é suportado, ANTES de gastar qualquer token. */
export function assertKeysFor(models: readonly string[], env: Record<string, string | undefined> = process.env): void {
	const missing = new Set<string>();
	const unsupported: string[] = [];
	for (const model of models) {
		const { provider } = parseModelRef(model);
		if (provider === "openrouter" && !env[OPENROUTER_ENV]?.trim()) missing.add(OPENROUTER_ENV);
		else if (provider === "opencode-go" && !env[OPENCODE_GO_ENV]?.trim()) missing.add(OPENCODE_GO_ENV);
		else if (provider === "chatgpt" || provider === "anthropic") unsupported.push(`${model} (use o slug do OpenRouter, ex.: ${provider === "chatgpt" ? "openai/gpt-5-mini" : "anthropic/claude-sonnet-4.5"})`);
	}
	if (unsupported.length > 0) throw new Error(`provedor sem chave de ambiente no eval: ${unsupported.join("; ")}`);
	if (missing.size > 0) throw new Error(`variável de ambiente ausente: ${[...missing].join(", ")} (exporte ou passe --env-file <.env>; o valor nunca é impresso). Nada foi executado.`);
}

export function createRealModel(env: Record<string, string | undefined> = process.env): RealModel {
	const openrouter = env[OPENROUTER_ENV]?.trim() ?? "";
	const opencode = env[OPENCODE_GO_ENV]?.trim() ?? "";
	const router = createProviderStreamChat({
		openrouter: streamChatWithTools,
		chatgpt: () => {
			throw new Error("plano ChatGPT usa OAuth do usuário: no eval use o slug do OpenRouter");
		},
		...(opencode ? { opencodeGo: createOpencodeGoStreamChat({ getApiKey: async () => opencode }) } : {}),
	});
	return { streamChat: (params, handlers) => router(params, handlers ?? {}), apiKey: openrouter || opencode, secrets: [openrouter, opencode].filter(Boolean) };
}
