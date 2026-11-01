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

export type EnginePolicy = {
	engine: RunEngine;
	workProfile: WorkProfileSetting;
	longWorkBudgetUsd: number;
	longWorkMinutes: number;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
		workProfile,
		longWorkBudgetUsd: clampedNumber(policy.longWorkBudgetUsd, LONG_WORK_DEFAULT_BUDGET_USD, LONG_WORK_MIN_USD, LONG_WORK_MAX_USD),
		longWorkMinutes: clampedNumber(policy.longWorkMinutes, LONG_WORK_DEFAULT_MINUTES, LONG_WORK_MIN_MINUTES, LONG_WORK_MAX_MINUTES),
	};
}

/** Nova política com o motor trocado, sem perder as outras chaves. `v1` remove a chave (padrão). */
export function withBotEngine(policyJson: unknown, engine: RunEngine): Record<string, unknown> {
	const base = { ...asRecord(policyJson) };
	if (engine === "v2") base.engine = "v2";
	else delete base.engine;
	return base;
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
 * Origens que o v2 atende nesta fase: só a conversa direta do dono com o bot. Rotina, webhook, proativo,
 * e-mail, bot→bot, subagente e grupo continuam no v1 (ver docs/features/motor-v2.md).
 */
export function engineV2SupportsRun(input: { origin: string; isGroupRun: boolean; isSubagent?: boolean }): boolean {
	return input.origin === "chat" && !input.isGroupRun && input.isSubagent !== true;
}

/** Motor do run: o que já foi gravado vence (retomada); senão o do bot, se esta origem for suportada. */
export function chooseRunEngine(input: { stored?: RunEngine; policy: EnginePolicy; origin: string; isGroupRun: boolean; isSubagent?: boolean }): RunEngine {
	if (input.stored) return input.stored;
	if (input.policy.engine !== "v2") return "v1";
	return engineV2SupportsRun(input) ? "v2" : "v1";
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
