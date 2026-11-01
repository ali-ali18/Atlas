/**
 * Motor v2 (ADR 0002, F2): qual motor roda o run e com qual perfil de orçamento.
 * Tudo puro e sem migration: a escolha mora em `Bot.policyJson` (por bot) e é congelada no
 * `AgentRun.budgetJson` no começo do run, para a retomada continuar no motor em que nasceu.
 */

export type RunEngine = "v1" | "v2";
export type RunProfile = "chat" | "long_work";
/** `auto` decide pelo pedido; os outros dois forçam o perfil. */
export type WorkProfileSetting = "auto" | RunProfile;

/** Decisão do dono (31/10): trabalho longo = até US$ 0,50 e 20 min por tarefa, ajustável por bot. */
export const LONG_WORK_DEFAULT_BUDGET_USD = 0.5;
export const LONG_WORK_DEFAULT_MINUTES = 20;
export const LONG_WORK_MIN_USD = 0.05;
export const LONG_WORK_MAX_USD = 20;
export const LONG_WORK_MIN_MINUTES = 1;
export const LONG_WORK_MAX_MINUTES = 120;

/**
 * Onde o v2 roda num bot que o ligou: `chat` (padrão) = só a conversa direta com o dono; `all` = também rotinas,
 * grupo e bot→bot. Subagente, proativo, alerta e evento de configuração do bot seguem no v1 (o v2 não tem esses recursos).
 */
export type EngineScope = "chat" | "all";
/** Padrão global do deploy (`ATLAS_ENGINE_V2_DEFAULT`) para bots que não escolheram o motor: `off` (padrão), `chat` ou `all`. */
export type EngineDefault = "off" | EngineScope;

export type EnginePolicy = {
	engine: RunEngine;
	/** Escolha explícita do bot (`policyJson.engine`): `v1` explícito nunca vai para o v2, nem pelo padrão global. */
	explicit?: RunEngine;
	scope: EngineScope;
	workProfile: WorkProfileSetting;
	longWorkBudgetUsd: number;
	longWorkMinutes: number;
	/** O bot gravou o valor (`policyJson.longWorkBudgetUsd` / `longWorkMinutes`): decisão do dono que vale mais que o teto por execução da conta. */
	longWorkBudgetExplicit: boolean;
	longWorkMinutesExplicit: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isFiniteNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/** Lê o que o bot configura para o motor. Valor ausente ou inválido cai no padrão (v1, auto, 0,50 / 20 min). */
export function readEnginePolicy(policyJson: unknown): EnginePolicy {
	const policy = asRecord(policyJson);
	const workProfile: WorkProfileSetting = policy.workProfile === "chat" || policy.workProfile === "long_work" ? policy.workProfile : "auto";
	return {
		engine: policy.engine === "v2" ? "v2" : "v1",
		explicit: policy.engine === "v1" || policy.engine === "v2" ? policy.engine : undefined,
		scope: policy.engineScope === "all" ? "all" : "chat",
		workProfile,
		longWorkBudgetUsd: clampedNumber(policy.longWorkBudgetUsd, LONG_WORK_DEFAULT_BUDGET_USD, LONG_WORK_MIN_USD, LONG_WORK_MAX_USD),
		longWorkMinutes: clampedNumber(policy.longWorkMinutes, LONG_WORK_DEFAULT_MINUTES, LONG_WORK_MIN_MINUTES, LONG_WORK_MAX_MINUTES),
		longWorkBudgetExplicit: isFiniteNumber(policy.longWorkBudgetUsd),
		longWorkMinutesExplicit: isFiniteNumber(policy.longWorkMinutes),
	};
}

/**
 * Nova política com o motor trocado, sem perder as outras chaves. `v1` grava `engine: "v1"` de forma explícita
 * (e não remove a chave): com o padrão global ligado, só a escolha explícita segura o bot no motor atual.
 * Voltar ao v1 também desliga o escopo ampliado.
 */
export function withBotEngine(policyJson: unknown, engine: RunEngine): Record<string, unknown> {
	const base = { ...asRecord(policyJson) };
	base.engine = engine;
	if (engine === "v1") delete base.engineScope;
	return base;
}

/** Padrão global do deploy. Qualquer valor desconhecido ou ausente = `off` (nada muda para ninguém). */
export function readEngineDefault(raw: unknown): EngineDefault {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return value === "chat" || value === "all" ? value : "off";
}

/** Motor e escopo que valem para o bot: a escolha explícita vence; sem ela, vale o padrão global. */
export function resolveBotEngineRouting(policy: EnginePolicy, globalDefault: EngineDefault = "off"): { engine: RunEngine; scope: EngineScope } {
	if (policy.explicit === "v1") return { engine: "v1", scope: "chat" };
	if (policy.explicit === "v2") return { engine: "v2", scope: policy.scope };
	if (globalDefault === "off") return { engine: "v1", scope: "chat" };
	// Sem escolha explícita, o escopo pedido no bot ("all") vale junto com o do padrão global: o maior dos dois.
	return { engine: "v2", scope: policy.scope === "all" ? "all" : globalDefault };
}

/** Motor gravado no `budgetJson` do run (`undefined` = o run ainda não escolheu). */
export function readRunEngine(budgetJson: unknown): RunEngine | undefined {
	const engine = asRecord(budgetJson).engine;
	return engine === "v1" || engine === "v2" ? engine : undefined;
}

/** Perfil gravado no `budgetJson` do run (retomada mantém o perfil do começo). */
export function readRunProfile(budgetJson: unknown): RunProfile | undefined {
	const profile = asRecord(budgetJson).engineProfile;
	return profile === "chat" || profile === "long_work" ? profile : undefined;
}

/** `budgetJson` com a escolha do motor e do perfil gravada, preservando o resto (humanTurn, contextLength...). */
export function withRunEngine(budgetJson: unknown, choice: { engine: RunEngine; profile?: RunProfile }): Record<string, unknown> {
	return { ...asRecord(budgetJson), engine: choice.engine, ...(choice.profile ? { engineProfile: choice.profile } : {}) };
}

/**
 * Origens que o v2 atende. Escopo `chat`: só a conversa direta do dono com o bot. Escopo `all`: também rotina,
 * grupo (run de membro na conversa do grupo) e bot→bot. Webhook, e-mail, proativo e subagente seguem no v1
 * (sem humano para o v2 perguntar e com recursos que ele não tem; ver docs/features/motor-v2.md).
 */
export function engineV2SupportsRun(input: { origin: string; isGroupRun: boolean; isSubagent?: boolean; scope?: EngineScope }): boolean {
	if (input.isSubagent === true) return false;
	if (input.origin === "chat") return input.scope === "all" || !input.isGroupRun;
	return input.scope === "all" && (input.origin === "routine" || input.origin === "bot") && !input.isGroupRun;
}

/**
 * Motor do run: o que já foi gravado vence (retomada); senão o do bot (ou o padrão global, se o bot não escolheu),
 * se esta origem for suportada no escopo dele.
 */
export function chooseRunEngine(input: {
	stored?: RunEngine;
	policy: EnginePolicy;
	origin: string;
	isGroupRun: boolean;
	isSubagent?: boolean;
	globalDefault?: EngineDefault;
}): RunEngine {
	if (input.stored) return input.stored;
	const routing = resolveBotEngineRouting(input.policy, input.globalDefault);
	if (routing.engine !== "v2") return "v1";
	return engineV2SupportsRun({ ...input, scope: routing.scope }) ? "v2" : "v1";
}

/**
 * O pedido parece uma tarefa (pesquisa, relatório, levantamento) e não conversa curta? Heurística barata e
 * deliberadamente conservadora: "Bom dia" e perguntas de uma linha ficam em `chat`. Quem quer outra coisa força
 * `workProfile` na política do bot.
 */
export function looksLikeLongTask(text: string): boolean {
	const plain = (text ?? "")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.trim();
	if (plain.length < 25) return false;
	const verb = /\b(pesquis\w+|levant\w+|analis\w+|compar\w+|mapea\w+|investig\w+|monte|montar|elabor\w+|prepar\w+|gere|gerar|crie|criar|escrev\w+|faca|fazer|researc\w+|analy[sz]e|compare|build|prepare|draft|write|create|generate|benchmark\w*)\b/;
	const deliverable = /\b(relatorio|estudo|pesquisa de mercado|panorama|benchmark|dossie|planilha|apresentacao|painel|dashboard|analise|comparativo|levantamento|report|study|market research|spreadsheet|presentation|deep dive|overview)\b/;
	if (verb.test(plain) && deliverable.test(plain)) return true;
	// Pedido longo com verbo de trabalho (várias linhas de instrução) também é tarefa.
	return plain.length >= 200 && verb.test(plain);
}

/** Perfil do run: forçado pela política do bot ou decidido pelo pedido (só importa no v2). */
export function resolveRunProfile(input: { policy: EnginePolicy; text: string }): RunProfile {
	if (input.policy.workProfile !== "auto") return input.policy.workProfile;
	return looksLikeLongTask(input.text) ? "long_work" : "chat";
}
