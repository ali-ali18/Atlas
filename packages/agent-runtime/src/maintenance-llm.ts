import { apiKeyService, type ApiKeyService } from "./providers/api-key-service.js";
import { getAccountConfig, recordMaintenanceResult } from "@workspace/db";
import {
	ANTHROPIC_API_BASE_URL,
	ProviderApiError,
	completeChat,
	completeChatWithTools,
	createAnthropicStreamChat,
	createApiKeyModelCatalog,
	createOpencodeGoStreamChat,
	type ProviderStreamChat,
} from "@workspace/llm";
import {
	API_KEY_PROVIDERS,
	DEFAULT_MAINTENANCE_MODEL,
	MAINTENANCE_NO_KEY_MESSAGE,
	buildMaintenanceCandidates,
	isMaintenanceFallbackError,
	parseModelRef,
	resolveMaintenanceModel,
	type AccountConfigV1,
	type MaintenanceCandidate,
	type MaintenanceJobKind,
	type MaintenanceKeyAvailability,
} from "@workspace/shared";
/** Config de boot necessária (o worker passa o seu `WorkerConfig`; a API monta do env). */
export type MaintenanceBootConfig = { openRouterApiKey: string | undefined; summarizerModel: string; maintenanceModel?: string };
type BootConfig = MaintenanceBootConfig;

const keyCatalog = createApiKeyModelCatalog({ getKey: (userId, provider) => apiKeyService.getKey(userId, provider) });

/**
 * Streams de chave própria (Anthropic, OpenCode Go) do usuário: os MESMOS adaptadores dos runs,
 * também usados pela manutenção e pelo revisor.
 */
export function createKeyProviderStreams(input: {
	userId: string;
	conversationId?: string | null;
	keys?: Pick<ApiKeyService, "getKey">;
	keyModels?: Pick<typeof keyCatalog, "protocolOf">;
}): { anthropic: ProviderStreamChat; opencodeGo: ProviderStreamChat } {
	const keys = input.keys ?? apiKeyService,
		keyModels = input.keyModels ?? keyCatalog;
	const requireKey = (provider: "anthropic" | "opencode-go") => async () => {
		const key = await keys.getKey(input.userId, provider);
		if (!key) throw new ProviderApiError(provider, 401, "auth_failed");
		return key;
	};
	return {
		anthropic: createAnthropicStreamChat({
			provider: "anthropic",
			getApiKey: requireKey("anthropic"),
			url: `${ANTHROPIC_API_BASE_URL}/v1/messages`,
			auth: "x-api-key",
		}),
		opencodeGo: createOpencodeGoStreamChat({
			getApiKey: requireKey("opencode-go"),
			conversationId: input.conversationId ?? undefined,
			protocolOf: (slug) => keyModels.protocolOf(input.userId, slug),
		}),
	};
}

export type MaintenanceLlmDeps = {
	loadConfig?: (userId: string) => Promise<AccountConfigV1>;
	/** Há chave própria conectada? Só presença: o valor é lido no momento da chamada. */
	hasKey?: (userId: string, provider: "anthropic" | "opencode-go") => Promise<boolean>;
	streams?: (userId: string) => { anthropic: ProviderStreamChat; opencodeGo: ProviderStreamChat };
	completeChat?: typeof completeChat;
	completeChatWithTools?: typeof completeChatWithTools;
	log?: (line: string) => void;
	record?: typeof recordMaintenanceResult;
};

export type MaintenanceLlm = {
	candidates: MaintenanceCandidate[];
	/** Modelo da primeira tentativa (ou o padrão do servidor, sem nenhuma chave). */
	model: string;
	/** Mesmo contrato de `completeChat`; `model`/`apiKey` do chamador são ignorados — vale a cadeia da manutenção. */
	complete: typeof completeChat;
	completeWithTools: typeof completeChatWithTools;
	/** Grava o sucesso/erro no Diagnóstico (nunca lança). */
	report: (outcome: { ok: true } | { ok: false; error: unknown }) => Promise<void>;
};

/** Padrão do servidor (env ou código): sempre OpenRouter, barato. */
function serverDefaultModel(kind: MaintenanceJobKind, config: BootConfig): string {
	const fromEnv = kind === "summary" ? config.summarizerModel : config.maintenanceModel?.trim() || config.summarizerModel;
	return resolveMaintenanceModel(fromEnv, DEFAULT_MAINTENANCE_MODEL);
}

const defaultHasKey: NonNullable<MaintenanceLlmDeps["hasKey"]> = async (userId, provider) => (await apiKeyService.status(userId, provider)).status === "connected";

/**
 * Modelo de manutenção da conta → cadeia de candidatos com chave disponível (mesmo cofre dos runs).
 * Escolhido pelo usuário > padrão da conta > padrão do servidor (OpenRouter). Nunca a assinatura ChatGPT.
 */
export async function resolveMaintenanceCandidates(
	input: { kind: MaintenanceJobKind; config: BootConfig; userId?: string },
	deps: MaintenanceLlmDeps = {},
): Promise<{ candidates: MaintenanceCandidate[]; serverDefault: string }> {
	const serverDefault = serverDefaultModel(input.kind, input.config);
	let account: AccountConfigV1 | null = null;
	const keys: MaintenanceKeyAvailability = { openrouter: Boolean(input.config.openRouterApiKey), anthropic: false, "opencode-go": false };
	if (input.userId) {
		try {
			account = await (deps.loadConfig ?? getAccountConfig)(input.userId);
		} catch (error) {
			console.error("load account config failed; using server defaults", error instanceof Error ? error.name : "unknown");
		}
		for (const provider of API_KEY_PROVIDERS) {
			keys[provider] = await (deps.hasKey ?? defaultHasKey)(input.userId, provider).catch(() => false);
		}
	}
	const candidates = buildMaintenanceCandidates({
		chosen: account?.models?.maintenance,
		accountDefault: account?.models?.default,
		serverDefault,
		keys,
	});
	return { candidates, serverDefault };
}

/**
 * Cliente LLM da manutenção. Cada chamada usa o candidato ativo; se falhar por política/disponibilidade
 * (modelo indisponível, ZDR, 400/404, 401/403), troca UMA vez para o próximo candidato e segue com ele.
 */
export async function createMaintenanceLlm(
	input: { kind: MaintenanceJobKind; config: BootConfig; userId?: string },
	deps: MaintenanceLlmDeps = {},
): Promise<MaintenanceLlm> {
	const { candidates, serverDefault } = await resolveMaintenanceCandidates(input, deps);
	const log = deps.log ?? ((line: string) => console.log(line));
	const streams = input.userId ? (deps.streams ?? ((userId: string) => createKeyProviderStreams({ userId })))(input.userId) : null;
	let active = 0;
	let switched = false;

	const viaFor = (candidate: MaintenanceCandidate): ProviderStreamChat | undefined =>
		candidate.provider === "anthropic" ? streams?.anthropic : candidate.provider === "opencode-go" ? streams?.opencodeGo : undefined;

	async function run<T>(call: (candidate: MaintenanceCandidate, via: ProviderStreamChat | undefined) => Promise<T>): Promise<T> {
		const first = candidates[active];
		if (!first) throw new Error(MAINTENANCE_NO_KEY_MESSAGE);
		try {
			return await call(first, viaFor(first));
		} catch (error) {
			const next = candidates[active + 1];
			if (switched || !next || !isMaintenanceFallbackError(error)) throw error;
			switched = true;
			active += 1;
			log(`[maintenance] ${input.kind}: ${first.model} falhou (${error instanceof Error ? error.name : "erro"}); usando ${next.model} (${next.role})`);
			return call(next, viaFor(next));
		}
	}

	const doComplete = deps.completeChat ?? completeChat;
	const doTools = deps.completeChatWithTools ?? completeChatWithTools;
	const apiKeyFor = (candidate: MaintenanceCandidate) => (candidate.provider === "openrouter" ? (input.config.openRouterApiKey ?? "") : "");
	const withCandidate = <P extends { model: string; apiKey: string }>(params: P, candidate: MaintenanceCandidate) => ({ ...params, model: candidate.model, apiKey: apiKeyFor(candidate) });

	return {
		candidates,
		model: candidates[0]?.model ?? serverDefault,
		complete: (params) => run((candidate, via) => doComplete({ ...withCandidate(params, candidate), ...(via ? { via } : {}) })),
		completeWithTools: (params) =>
			run((candidate, via) => {
				if (!via) return doTools(withCandidate(params, candidate));
				// Chave própria: o adaptador do provedor, o mesmo dos runs.
				return via({ ...withCandidate(params, candidate) }, {});
			}),
		report: async (outcome) => {
			if (!input.userId) return;
			await (deps.record ?? recordMaintenanceResult)(input.userId, input.kind, outcome);
		},
	};
}


/**
 * Adaptador de chave própria para o modelo (`anthropic-direct/…`, `opencode-go/…`); `undefined` = OpenRouter.
 * Para chamadas de texto simples (chat legado) que precisam seguir o modelo do usuário em qualquer provedor.
 */
export function keyProviderStreamFor(userId: string, model: string, streams?: (userId: string) => { anthropic: ProviderStreamChat; opencodeGo: ProviderStreamChat }): ProviderStreamChat | undefined {
	let provider: string;
	try {
		provider = parseModelRef(model).provider;
	} catch {
		return undefined;
	}
	if (provider !== "anthropic" && provider !== "opencode-go") return undefined;
	const built = (streams ?? ((id: string) => createKeyProviderStreams({ userId: id })))(userId);
	return provider === "anthropic" ? built.anthropic : built.opencodeGo;
}
