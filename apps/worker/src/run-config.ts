import {
	BUDGET_HARD_CAP,
	type AgentBudgetPolicy,
	type ModelTiersRuntime,
} from "@workspace/agent-runtime";
import { getAccountConfig, getAccountConfigByConversation } from "@workspace/db";
import {
	MODEL_TIERS,
	hasModelTiers,
	mergeModelTiers,
	isMaintenanceModel,
	parseModelRef,
	readBotModelTiers,
	readCodingModel,
	resolveCodingModel,
	parseRunConfigSnapshot,
	resolveEffectiveConfig,
	resolveMaintenanceModel,
	toRunConfigSnapshot,
	type AccountConfigV1,
	type AgentRunCheckpoint,
	type ConfigEnv,
	type ContextMemory,
	type ModelTiers,
	type RunConfigSnapshot,
} from "@workspace/shared";

/**
 * Configuração da conta no worker. O `loadWorkerConfig` fica só com infra e
 * segredos (lido no boot); tudo que é escolha do usuário é resolvido AQUI, por
 * run ou por job, a partir do dono (usuário > env > padrão do código).
 * O env entra por parâmetro e nunca é mutado.
 */

export type RunConfigDeps = {
	env?: ConfigEnv;
	loadConfig?: (userId: string) => Promise<AccountConfigV1>;
};

const DEFAULT_MAINTENANCE_MODEL = "openai/gpt-6-luna";

/** Falha ao ler a conta cai no env/padrão (como `getUserSettings` já faz); só o nome do erro vai ao log. */
async function loadConfigOrEmpty(userId: string, load: NonNullable<RunConfigDeps["loadConfig"]>): Promise<unknown> {
	try {
		return await load(userId);
	} catch (error) {
		console.error("load account config failed; using server defaults", error instanceof Error ? error.name : "unknown");
		return null;
	}
}

/**
 * Snapshot do run: retomada reusa o que está no checkpoint; run novo resolve
 * uma vez com o `userId` do run. Mudar a conta no meio do run não o afeta.
 */
export async function resolveRunConfigSnapshot(
	input: { userId: string; sandboxAutoStart: boolean | null | undefined; restored?: unknown },
	deps: RunConfigDeps = {},
): Promise<{ snapshot: RunConfigSnapshot; reused: boolean }> {
	const restored = parseRunConfigSnapshot(input.restored);
	if (restored) return { snapshot: restored, reused: true };
	const config = await loadConfigOrEmpty(input.userId, deps.loadConfig ?? getAccountConfig);
	const effective = resolveEffectiveConfig({
		user: { config, sandboxAutoStart: input.sandboxAutoStart },
		env: deps.env ?? process.env,
	});
	return { snapshot: toRunConfigSnapshot(effective), reused: false };
}

/** Todo checkpoint gravado leva o snapshot, para a retomada e os subagentes verem os mesmos valores. */
export function withConfigSnapshot(checkpoint: AgentRunCheckpoint, snapshot: RunConfigSnapshot): AgentRunCheckpoint {
	return { ...checkpoint, configSnapshot: snapshot };
}

/**
 * Padrão da conta para o orçamento: fica ENTRE o bot e o código
 * (request > bot > conta > código). `maxSteps` do request é legado e vale 100 quando omitido;
 * por isso o limite da conta só vale se o request não pediu menos que o teto.
 */
export function accountBudgetPolicy(snapshot: RunConfigSnapshot, requestMaxSteps: number): AgentBudgetPolicy {
	const policy: AgentBudgetPolicy = {};
	// Legacy request default is 100; account limit applies if request is at or above that (i.e., not asking for less).
	const LEGACY_REQUEST_DEFAULT_MAX_STEPS = 100;
	if (snapshot.maxSteps !== undefined && requestMaxSteps >= LEGACY_REQUEST_DEFAULT_MAX_STEPS) {
		policy.hardMaxSteps = snapshot.maxSteps;
	}
	if (snapshot.maxWallMinutes !== undefined) policy.maxWallMs = snapshot.maxWallMinutes * 60_000;
	return policy;
}

/** Histórico entre turnos carregado no run novo: Econômico mantém 40 mensagens (ou 6 com resumo fresco); Padrão, 80 sempre. */
export const HISTORY_LIMIT_ECONOMY = 40;
export const HISTORY_LIMIT_STANDARD = 80;

/**
 * Janela de histórico de um run novo pela memória da conta. O "ciclo limpo" (resumo da conversa +
 * 6 mensagens) é do Econômico: no Padrão a conversa segue inteira e o resumo entra só quando o
 * contexto chega perto do limite do modelo.
 */
export function historyWindowFor(memory: ContextMemory | undefined, hasFreshSummary: boolean): { compact: boolean; limit: number } {
	if (memory === "economy") return { compact: hasFreshSummary, limit: HISTORY_LIMIT_ECONOMY };
	return { compact: false, limit: HISTORY_LIMIT_STANDARD };
}

/** Acrescenta o objetivo como última fala do usuário, sem repeti-lo quando o histórico já termina nele. */
export function appendObjective<T extends { role: string; content: string }>(history: readonly T[], objective: string): Array<T | { role: "user"; content: string }> {
	if (objective.trim().length === 0) return [...history];
	const last = history[history.length - 1];
	if (last?.role === "user" && last.content === objective) return [...history];
	return [...history, { role: "user", content: objective }];
}

/** Parâmetros de `runComputerUse` vindos do snapshot (a lib mantém o env como último recurso). */
export function runtimeParamsFromSnapshot(snapshot: RunConfigSnapshot) {
	return {
		jevMcpMode: snapshot.jevMcpMode,
		jevModes: snapshot.jevModes,
		executionDiscipline: snapshot.executionDiscipline,
		contextEconomy: snapshot.contextEconomy,
		contextMemory: snapshot.contextMemory,
		maxOutputTokens: snapshot.maxOutputTokens,
		toolResultMaxChars: snapshot.toolResultMaxChars,
		modelCallTimeoutMs: snapshot.llmTimeouts.totalMs,
		firstEventTimeoutMs: snapshot.llmTimeouts.firstEventMs,
		idleTimeoutMs: snapshot.llmTimeouts.idleMs,
		fallbackModels: snapshot.fallbackModels,
		imageModel: snapshot.imageModel,
		sandboxEnabled: snapshot.sandboxAutoStart,
		...(snapshot.maxRunCostUsd !== undefined ? { budget: { maxCostUsd: snapshot.maxRunCostUsd } } : {}),
	};
}

/** Modelo de leitura de imagem: qualquer provedor com chave, nunca `chatgpt/*`. `undefined` = sem reserva (como hoje). */
export function visionFallbackFromSnapshot(snapshot: RunConfigSnapshot): string | undefined {
	return snapshot.visionModel ? (isMaintenanceModel(snapshot.visionModel) ? snapshot.visionModel : "openai/gpt-4o-mini") : undefined;
}

type MaintenanceKind = "summary" | "memory-review" | "reflection" | "connector-guide";

/**
 * Modelo de manutenção por job: o do usuário dono (se escolheu) > o que o worker
 * já resolve do env no boot (`summarizerModel`/`maintenanceModel`) > padrão.
 * Nunca `chatgpt/*` (`resolveMaintenanceModel`). Sem dono, vale o do boot.
 */
export async function resolveMaintenanceModelForJob(
	input: {
		kind: MaintenanceKind;
		config: { summarizerModel: string; maintenanceModel?: string };
		userId?: string;
		conversationId?: string;
	},
	deps: { loadConfig?: (userId: string) => Promise<AccountConfigV1>; loadByConversation?: (conversationId: string) => Promise<AccountConfigV1> } = {},
): Promise<string> {
	const booted = resolveMaintenanceModel(
		input.kind === "summary" ? input.config.summarizerModel : input.config.maintenanceModel?.trim() || input.config.summarizerModel,
		DEFAULT_MAINTENANCE_MODEL,
	);
	let user: AccountConfigV1 | null = null;
	try {
		if (input.userId) user = await (deps.loadConfig ?? getAccountConfig)(input.userId);
		else if (input.conversationId) user = await (deps.loadByConversation ?? getAccountConfigByConversation)(input.conversationId);
	} catch (error) {
		console.error("load account config failed; using server defaults", error instanceof Error ? error.name : "unknown");
	}
	const chosen = user?.models?.maintenance;
	return chosen ? resolveMaintenanceModel(chosen, booted) : booted;
}

/** Modelo padrão de jobs sem modelo explícito: o do usuário (se escolheu) > o do servidor. */
export async function resolveDefaultModelForJob(
	input: { userId?: string; serverDefault: string },
	deps: { loadConfig?: (userId: string) => Promise<AccountConfigV1> } = {},
): Promise<string> {
	if (!input.userId) return input.serverDefault;
	const config = await loadConfigOrEmpty(input.userId, deps.loadConfig ?? getAccountConfig);
	return (config as AccountConfigV1 | null)?.models?.default ?? input.serverDefault;
}

/**
 * Modelo para código do run: bot > conta, só se o usuário consegue usá-lo agora
 * (ChatGPT ligado e modelo conhecido; OpenRouter com chave no worker e modelo
 * conhecido). Indisponível = `null` (o run segue no modelo normal), com um log.
 * Catálogo fora do ar (`isKnown` → null) não bloqueia, como no resto do worker.
 */
export async function resolveRunCodingModel(input: {
	botPolicy: unknown;
	snapshot: Pick<RunConfigSnapshot, "codingModel" | "chatgptEnabled">;
	runModel: string;
	openRouterKey: boolean;
	isKnown: (modelId: string) => Promise<boolean | null>;
	log?: (message: string) => void;
}): Promise<string | null> {
	const resolution = await resolveCodingModel({
		bot: readCodingModel(input.botPolicy),
		account: input.snapshot.codingModel,
		normal: input.runModel,
		isAvailable: async (model) => {
			const provider = parseModelRef(model).provider;
			if (provider === "chatgpt" && !input.snapshot.chatgptEnabled) return false;
			if (provider === "openrouter" && !input.openRouterKey) return false;
			// Chave própria (Anthropic, OpenCode Go): o catálogo do usuário só conhece o provedor conectado.
			return (await input.isKnown(model)) !== false;
		},
	});
	if (resolution.unavailable) {
		(input.log ?? console.warn)(
			`[coding-model] ${resolution.unavailable} indisponível para este usuário; seguindo com ${input.runModel}`,
		);
	}
	return resolution.model === input.runModel ? null : resolution.model;
}

/**
 * Modelos por dificuldade do run (modo Automático): níveis da conta com os do bot por cima, só
 * com modelos que o usuário consegue usar agora (ChatGPT ligado; OpenRouter com chave; modelo
 * conhecido no catálogo). Nível que ficou vazio herda o modelo do run e as reservas. Sem modo
 * Automático ou sem nenhum nível configurado = `undefined`: o run segue o modelo dele, como sempre.
 */
export async function resolveRunModelTiers(input: {
	auto: boolean;
	botPolicy: unknown;
	snapshot: Pick<RunConfigSnapshot, "modelTiers" | "classifyWithReviewer" | "chatgptEnabled">;
	openRouterKey: boolean;
	isKnown: (modelId: string) => Promise<boolean | null>;
}): Promise<ModelTiersRuntime | undefined> {
	if (!input.auto) return undefined;
	const merged = mergeModelTiers(input.snapshot.modelTiers, readBotModelTiers(input.botPolicy));
	if (!hasModelTiers(merged)) return undefined;
	const usable = async (model: string): Promise<boolean> => {
		const provider = parseModelRef(model).provider;
		if (provider === "chatgpt" && !input.snapshot.chatgptEnabled) return false;
		if (provider === "openrouter" && !input.openRouterKey) return false;
		return (await input.isKnown(model).catch(() => null)) !== false;
	};
	const tiers: ModelTiers = {};
	for (const tier of MODEL_TIERS) {
		const ids = merged[tier] ?? [];
		const keep = (await Promise.all(ids.map(usable))).map((ok, index) => (ok ? ids[index]! : null));
		const list = keep.filter((id): id is string => id !== null);
		if (list.length > 0) tiers[tier] = list;
	}
	if (!hasModelTiers(tiers)) return undefined;
	return { tiers, ...(input.snapshot.classifyWithReviewer ? { classifyWithReviewer: true } : {}) };
}
