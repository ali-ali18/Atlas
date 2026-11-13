import {
	ANTHROPIC_API_BASE_URL,
	createAnthropicStreamChat,
	createOpencodeGoStreamChat,
	createProviderStreamChat,
	streamChatWithTools,
	type ProviderStreamChat,
} from "@workspace/llm";
import { parseModelRef } from "@workspace/shared";
import { readProviderKey, type MatrixProvider } from "./models.js";
import { costFromTokens, priceFor, type PriceEntry } from "./pricing.js";

/** Os três provedores do `matrix`, atrás da mesma assinatura do runtime. */
export type MatrixProviders = { anthropic: ProviderStreamChat; opencodeGo: ProviderStreamChat; openrouter: ProviderStreamChat };

/**
 * Provedores reais, com os adaptadores do `packages/llm` (nenhum cliente HTTP novo). A chave é lida do ambiente aqui
 * e fica só nos fechamentos; chame `assertProviderKeys` antes. `fetch` é injetável para teste.
 */
export function createRealProviders(env: Record<string, string | undefined>, options: { fetch?: typeof fetch } = {}): MatrixProviders {
	const keyFor = (provider: MatrixProvider) => async (): Promise<string> => {
		const key = readProviderKey(provider, env);
		if (!key) throw new Error(`chave ausente para ${provider}`);
		return key.value;
	};
	return {
		anthropic: createAnthropicStreamChat({ provider: "anthropic", getApiKey: keyFor("anthropic"), url: `${ANTHROPIC_API_BASE_URL}/v1/messages`, auth: "x-api-key", ...(options.fetch ? { fetch: options.fetch } : {}) }),
		opencodeGo: createOpencodeGoStreamChat({ getApiKey: keyFor("opencode-go"), ...(options.fetch ? { fetch: options.fetch } : {}) }),
		openrouter: async (params, handlers) => streamChatWithTools({ ...params, apiKey: await keyFor("openrouter")() }, handlers),
	};
}

/** Roteia pelo id interno (`parseModelRef`), com o roteador do próprio `packages/llm`. ChatGPT não existe no matrix. */
export function createMatrixRouter(providers: MatrixProviders): ProviderStreamChat {
	return createProviderStreamChat({
		chatgpt: () => {
			throw new Error("provedor chatgpt não é suportado no matrix");
		},
		anthropic: providers.anthropic,
		opencodeGo: providers.opencodeGo,
		openrouter: providers.openrouter,
	});
}

/**
 * Custo por execução. OpenRouter informa o custo real; Anthropic direto e OpenCode Go só devolvem tokens (o adaptador
 * marca `costUnknown`/`plan`), então o custo sai da tabela de preços. Modelo fora da tabela usa o preço conservador e
 * fica `costUnknown`. `onCost` recebe o custo de cada chamada (o juiz usa para entrar no teto).
 */
export function withCostAccounting(stream: ProviderStreamChat, options: { table?: Record<string, PriceEntry>; onCost?: (usd: number) => void } = {}): ProviderStreamChat {
	return async (params, handlers) => {
		const result = await stream(params, handlers);
		const ref = parseModelRef(params.model);
		const { costKind: _plan, ...usage } = result.usage ?? {};
		let costUsd: number;
		let unknown: boolean;
		if (ref.provider === "openrouter" && typeof usage.costUsd === "number" && !usage.costUnknown) {
			costUsd = usage.costUsd;
			unknown = false;
		} else {
			const key = ref.provider === "anthropic" ? `anthropic/${ref.slug}` : ref.provider === "opencode-go" ? `opencode-go/${ref.slug}` : `openrouter/${ref.slug}`;
			const { price, known } = priceFor(key, options.table);
			costUsd = costFromTokens(usage, price);
			unknown = !known || result.usage === undefined;
		}
		options.onCost?.(costUsd);
		const { costUnknown: _drop, ...rest } = usage;
		return { ...result, usage: { ...rest, costUsd, ...(unknown ? { costUnknown: true } : {}) } };
	};
}

/**
 * O OpenCode Go recusa chamada sem `x-opencode-session` (HTTP 400 MissingSessionID). O runtime do eval não manda
 * `sessionId`, então cada execução ganha uma sessão estável própria (o adaptador a vira cabeçalho).
 */
export function withSessionId(providers: MatrixProviders, sessionId: string): MatrixProviders {
	const go = providers.opencodeGo;
	return { ...providers, opencodeGo: (params, handlers) => go(params.sessionId ? params : { ...params, sessionId }, handlers) };
}
