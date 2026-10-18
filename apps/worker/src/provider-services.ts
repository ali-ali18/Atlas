import {
	apiKeyService,
	chatgptAuthService,
	SiwcAuthError,
	type ApiKeyService,
	type ChatgptAuthService,
} from "@workspace/agent-runtime";
import { getProviderConnection, updateProviderConnection } from "@workspace/db";
import {
	ANTHROPIC_API_BASE_URL,
	ProviderApiError,
	createAnthropicStreamChat,
	createApiKeyModelCatalog,
	createChatgptModelCatalog,
	createChatgptStreamChat,
	createOpencodeGoStreamChat,
	createProviderFallbackStream,
	streamChatWithTools,
	type ProviderStreamChat,
	type ProviderFallbackNotice,
} from "@workspace/llm";
import { getModelCapabilities, parseModelRef, resolveChatgptFallbackModel, type ApiKeyProvider, type ModelCapabilities } from "@workspace/shared";
import {
	getOpenRouterContextLength,
	isKnownOpenRouterModel,
	openRouterCatalogInfo,
} from "./openrouter-models.js";

const catalog = createChatgptModelCatalog(chatgptAuthService);
/**
 * Cooldown por MODELO do OpenCode Go (limite do plano). Em memória do worker: um reinício só
 * custa uma tentativa a mais; o limite de um modelo nunca bloqueia os outros nem o provedor.
 */
const goModelCooldowns = new Map<string, number>();
export function resetGoModelCooldowns(): void {
	goModelCooldowns.clear();
}
const keyCatalog = createApiKeyModelCatalog({ getKey: (userId, provider) => apiKeyService.getKey(userId, provider) });
/** Janela de contexto quando o catálogo não informa. */
const KEY_PROVIDER_CONTEXT: Record<ApiKeyProvider, number> = { anthropic: 200_000, "opencode-go": 128_000 };
export function createRunProviderServices(input: {
	userId: string;
	policy: unknown;
	/**
	 * Plano ChatGPT ligado no snapshot do run. `false` bloqueia o ChatGPT neste run; `true`
	 * ainda passa pela checagem ao vivo (`auth`), então desligar na UI vale na hora.
	 * Omitido = só a checagem ao vivo.
	 */
	chatgptEnabled?: boolean;
	onFallback(notice: ProviderFallbackNotice): void | Promise<void>;
	auth?: Pick<ChatgptAuthService, "getAccessToken" | "markNeedsLogin"> & Partial<Pick<ChatgptAuthService, "getAccountId">>;
	chatgpt?: ProviderStreamChat;
	openrouter?: ProviderStreamChat;
	getConnection?: typeof getProviderConnection;
	updateConnection?: (
		...args: Parameters<typeof updateProviderConnection>
	) => Promise<unknown>;
	models?: Pick<typeof catalog, "find" | "isKnown">;
	env?: NodeJS.ProcessEnv;
	/** Conversa do run: vira `x-opencode-session` estável no OpenCode Go. */
	conversationId?: string | null;
	/** Chaves de API do usuário (Anthropic, OpenCode Go). */
	keys?: Pick<ApiKeyService, "getKey" | "status" | "markLimitAt">;
	/** O worker tem chave do OpenRouter? Omitido = injeção de teste ou OPENROUTER_API_KEY do ambiente. */
	openRouterKey?: boolean;
	/** Modelo padrão escolhido pela conta (último recurso do fallback). */
	accountDefaultModel?: () => Promise<string | null>;
	keyModels?: Pick<typeof keyCatalog, "find" | "isKnown" | "protocolOf">;
	anthropic?: ProviderStreamChat;
	opencodeGo?: ProviderStreamChat;
}) {
	if (!input.userId.trim() || input.userId === "default")
		throw new Error("Dono do run obrigatório");
	const env = input.env ?? process.env,
		liveAuth = input.auth ?? chatgptAuthService,
		models = input.models ?? catalog;
	const auth: Pick<ChatgptAuthService, "getAccessToken" | "markNeedsLogin"> & Partial<Pick<ChatgptAuthService, "getAccountId">> = {
		getAccountId: liveAuth.getAccountId ? (userId) => liveAuth.getAccountId!(userId) : undefined,
		markNeedsLogin: (userId) => liveAuth.markNeedsLogin(userId),
		getAccessToken: async (userId, options) => {
			if (input.chatgptEnabled === false) throw new SiwcAuthError("not_found", 404);
			return liveAuth.getAccessToken(userId, options);
		},
	};
	const keys = input.keys ?? apiKeyService,
		keyModels = input.keyModels ?? keyCatalog;
	const requireKey = (provider: ApiKeyProvider) => async () => {
		const key = await keys.getKey(input.userId, provider);
		if (!key) throw new ProviderApiError(provider, 401, "auth_failed");
		return key;
	};
	const connection = input.getConnection ?? getProviderConnection,
		update = input.updateConnection ?? updateProviderConnection;
	const configuredContext = Number(env.ATLAS_CHATGPT_CONTEXT_TOKENS ?? 64000);
	const contextFallback =
		Number.isSafeInteger(configuredContext) &&
		configuredContext >= 1000 &&
		configuredContext <= 2_000_000
			? configuredContext
			: 64000;
	const configuredCooldown = Number(
		env.ATLAS_CHATGPT_LIMIT_COOLDOWN_MS ?? 900000
	);
	const cooldownMs =
		Number.isSafeInteger(configuredCooldown) &&
		configuredCooldown > 0 &&
		configuredCooldown <= 86_400_000
			? configuredCooldown
			: 900000;
	const openrouter: ProviderStreamChat =
		input.openrouter ??
		((params, handlers) => {
			if (!params.apiKey)
				throw new Error(
					"Configure a chave OpenRouter para usar este modelo ou o fallback."
				);
			return streamChatWithTools(params, handlers);
		});
	const streamChat = createProviderFallbackStream({
		openrouter,
		chatgpt:
			input.chatgpt ??
			createChatgptStreamChat({
				getAccessToken: (options) => auth.getAccessToken(input.userId, options),
				markNeedsLogin: () => auth.markNeedsLogin(input.userId),
				getAccountId: auth.getAccountId ? () => auth.getAccountId!(input.userId) : undefined,
			}),
		anthropic:
			input.anthropic ??
			createAnthropicStreamChat({
				provider: "anthropic",
				getApiKey: requireKey("anthropic"),
				url: `${ANTHROPIC_API_BASE_URL}/v1/messages`,
				auth: "x-api-key",
			}),
		opencodeGo:
			input.opencodeGo ??
			createOpencodeGoStreamChat({
				getApiKey: requireKey("opencode-go"),
				conversationId: input.conversationId ?? undefined,
				protocolOf: (slug) => keyModels.protocolOf(input.userId, slug),
			}),
		fallbackModel: resolveChatgptFallbackModel(input.policy),
		cooldownMs,
		modelCooldown: {
			until: async (model) => goModelCooldowns.get(`${input.userId}|${model}`) ?? null,
			mark: async (model, untilMs) => {
				goModelCooldowns.set(`${input.userId}|${model}`, untilMs);
				// Só informativo (tela de provedores); quem decide é o cooldown por modelo.
				await keys.markLimitAt(input.userId, "opencode-go", new Date()).catch(() => undefined);
			},
		},
		isModelAvailable: async (model) => {
			const { provider } = parseModelRef(model);
			if (provider === "openrouter") return input.openRouterKey ?? (input.openrouter ? true : Boolean(env.OPENROUTER_API_KEY));
			if (provider === "chatgpt") return input.chatgptEnabled !== false && (await connection(input.userId, "chatgpt"))?.status === "connected";
			return (await keys.status(input.userId, provider)).status === "connected";
		},
		accountDefaultModel: input.accountDefaultModel,
		onClassified: (info) => console.warn(`opencode-go failure classified model=${info.model} kind=${info.kind} status=${info.status}`),
		onFallback: input.onFallback,
		getLastLimitAt: async (provider = "chatgpt") =>
			provider === "opencode-go"
				? Date.parse((await keys.status(input.userId, "opencode-go")).lastLimitAt ?? "") || null
				: (await connection(input.userId, "chatgpt"))?.lastLimitAt?.getTime() ?? null,
		markLimitAt: async (at, provider = "chatgpt") => {
			if (provider === "opencode-go") await keys.markLimitAt(input.userId, "opencode-go", new Date(at));
			else await update(input.userId, "chatgpt", { lastLimitAt: new Date(at) });
		},
	});
	// Fonte única: override curado > catálogo do provedor > heurística (packages/shared/model-capabilities).
	// OpenCode Go só vê imagem quando o catálogo declara (modelo de texto responde 400); Anthropic lê por padrão;
	// ChatGPT tenta sem flag (o erro oficial informa a capacidade); OpenRouter ausente do catálogo = sem visão.
	const capabilitiesOf = async (id: string): Promise<ModelCapabilities> => {
		const { provider } = parseModelRef(id);
		if (provider === "anthropic" || provider === "opencode-go")
			return getModelCapabilities(id, await keyModels.find(input.userId, provider, id).catch(() => undefined));
		if (provider === "chatgpt")
			return getModelCapabilities(id, await models.find(input.userId, id).catch(unavailable));
		return getModelCapabilities(id, await openRouterCatalogInfo(id));
	};
	return {
		streamChat,
		isKnown: async (id: string): Promise<boolean | null> => {
			const { provider } = parseModelRef(id);
			if (provider === "anthropic" || provider === "opencode-go")
				return keyModels.isKnown(input.userId, provider, id).catch(() => null);
			return provider === "chatgpt"
				? models.isKnown(input.userId, id).catch((error) => {
						unavailable(error);
						return null;
					})
				: isKnownOpenRouterModel(id);
		},
		contextLength: async (id: string): Promise<number | null> => {
			const { provider } = parseModelRef(id);
			if (provider === "anthropic" || provider === "opencode-go")
				return getModelCapabilities(id, await keyModels.find(input.userId, provider, id).catch(() => undefined)).contextTokens ?? KEY_PROVIDER_CONTEXT[provider];
			return provider === "chatgpt"
				? (getModelCapabilities(id, await models.find(input.userId, id).catch(unavailable)).contextTokens ?? contextFallback)
				: getOpenRouterContextLength(id);
		},
		capabilities: capabilitiesOf,
		supportsImageInput: async (id: string): Promise<boolean> => (await capabilitiesOf(id)).vision,
	};
}

function unavailable(error: unknown): undefined {
	if (
		error &&
		typeof error === "object" &&
		"status" in error &&
		error.status === 503
	)
		return undefined;
	throw error;
}
