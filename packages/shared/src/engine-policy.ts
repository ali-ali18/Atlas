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
export const LONG_WORK_DEFAULT_MINUTES = 60;
export const LONG_WORK_MIN_USD = 0.05;
export const LONG_WORK_MAX_USD = 20;
export const LONG_WORK_MIN_MINUTES = 1;
export const LONG_WORK_MAX_MINUTES = 180;

/**
 * Onde o v2 roda num bot que o ligou: `chat` = só a conversa direta com o dono; `all` = também rotinas
 * (alerta e brief inclusos), grupo, bot→bot, proativo, webhook e e-mail recebido. O subagente herda o motor do pai.
 */
export type EngineScope = "chat" | "all";
/** Padrão global do deploy (`ATLAS_ENGINE_V2_DEFAULT`) para bots que não escolheram o motor: `off`, `chat` ou `all`. */
export type EngineDefault = "off" | EngineScope;

/**
 * Decisão do dono (01/11): o motor novo (v2) é o PADRÃO de todo bot que não escolheu o motor, em todas as origens
 * suportadas. Esta constante é a fonte única: a decisão do worker (`readEngineDefault`) e o que a UI e a descrição
 * mostram (`readEnginePolicy`) saem dela, para o dono ver o mesmo que roda. `ATLAS_ENGINE_V2_DEFAULT` virou botão de
 * emergência do deploy: `off` desliga o motor novo para TODOS os bots (run novo vai ao v1, mesmo com `engine: "v2"`
 * explícito; run já gravado segue); `chat` limita ao chat os bots sem escolha.
 * O `off` de emergência NÃO aparece na UI (ela mostra o padrão). `engine: "v1"` explícito sempre vence.
 */
export const ENGINE_DEFAULT_SCOPE: EngineScope = "all";

export type EnginePolicy = {
	engine: RunEngine;
	/** Escolha explícita do bot (`policyJson.engine`): `v1` explícito nunca vai para o v2, nem pelo padrão global. */
	explicit?: RunEngine;
	/**
	 * Escopo como o dono vê (UI e descrição): o do bot (`engineScope`); bot sem escolha explícita mostra o do padrão
	 * (`ENGINE_DEFAULT_SCOPE`). O worker decide por `resolveBotEngineRouting`, que também considera o env de emergência.
	 */
	scope: EngineScope;
	/** `policyJson.engineScope` cru (`undefined` = não definido ou inválido). Só `"chat"` explícito limita o motor novo ao chat. */
	scopeRaw?: EngineScope;
	workProfile: WorkProfileSetting;
	/**
	 * Gasto máximo OPCIONAL por tarefa longa (`policyJson.longWorkBudgetUsd`, vazio por padrão = sem limite em US$). O árbitro
	 * do trabalho longo é progresso e tempo, não dinheiro (o preço varia demais entre modelos); se o dono preencher, vira
	 * teto duro e a escrita ainda tem a reserva garantida.
	 */
	longWorkBudgetUsd: number | undefined;
	/** Tempo máximo da tarefa longa em minutos (padrão 60, até 180). */
	longWorkMinutes: number;
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

/** Lê o que o bot configura para o motor. Sem escolha explícita vale o padrão (v2 em `ENGINE_DEFAULT_SCOPE`); perfil auto, sem limite de gasto, 60 min. */
export function readEnginePolicy(policyJson: unknown): EnginePolicy {
	const policy = asRecord(policyJson);
	const workProfile: WorkProfileSetting = policy.workProfile === "chat" || policy.workProfile === "long_work" ? policy.workProfile : "auto";
	const explicit: RunEngine | undefined = policy.engine === "v1" || policy.engine === "v2" ? policy.engine : undefined;
	const scopeRaw: EngineScope | undefined = policy.engineScope === "all" || policy.engineScope === "chat" ? policy.engineScope : undefined;
	return {
		engine: explicit ?? "v2",
		explicit,
		// Quem escolheu o motor novo sem `engineScope` vale como `all` (decisão do dono, 01/11); só `engineScope: "chat"` limita.
		scope: explicit === "v1" ? "chat" : (scopeRaw ?? ENGINE_DEFAULT_SCOPE),
		scopeRaw,
		workProfile,
		// 0 (ou negativo) = sem limite, igual a vazio e `null`; só valor positivo vira teto.
		longWorkBudgetUsd: isFiniteNumber(policy.longWorkBudgetUsd) && (policy.longWorkBudgetUsd as number) > 0 ? clampedNumber(policy.longWorkBudgetUsd, LONG_WORK_MIN_USD, LONG_WORK_MIN_USD, LONG_WORK_MAX_USD) : undefined,
		longWorkMinutes: clampedNumber(policy.longWorkMinutes, LONG_WORK_DEFAULT_MINUTES, LONG_WORK_MIN_MINUTES, LONG_WORK_MAX_MINUTES),
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

/**
 * Padrão global do deploy. Ausente, vazio ou desconhecido = padrão novo (`ENGINE_DEFAULT_SCOPE`, v2 em tudo): um erro de
 * digitação no deploy não pode desligar o motor por engano. Só `off` (emergência) e `chat` mudam o padrão.
 */
export function readEngineDefault(raw: unknown): EngineDefault {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return value === "off" || value === "chat" || value === "all" ? value : ENGINE_DEFAULT_SCOPE;
}

/** Motor e escopo que valem para o bot: `off` (emergência) vence tudo; depois a escolha explícita; sem ela, vale o padrão global. */
export function resolveBotEngineRouting(policy: EnginePolicy, globalDefault: EngineDefault = ENGINE_DEFAULT_SCOPE): { engine: RunEngine; scope: EngineScope } {
	// `off` é a emergência do deploy: desliga o motor novo para TODOS os bots (inclusive `engine: "v2"` explícito) em run novo.
	if (globalDefault === "off") return { engine: "v1", scope: "chat" };
	if (policy.explicit === "v1") return { engine: "v1", scope: "chat" };
	if (policy.explicit === "v2") return { engine: "v2", scope: policy.scopeRaw ?? ENGINE_DEFAULT_SCOPE };
	// Sem escolha explícita: um `engineScope` salvo no bot vale; senão, o do padrão global (`chat` ou `all`).
	return { engine: "v2", scope: policy.scopeRaw ?? globalDefault };
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

/** Perfil de onde o run foi promovido a `long_work` no meio do trabalho (`budgetJson.promotedFrom`). */
export function readRunPromotedFrom(budgetJson: unknown): RunProfile | undefined {
	const from = asRecord(budgetJson).promotedFrom;
	return from === "chat" || from === "long_work" ? from : undefined;
}

/**
 * `budgetJson` do run depois da promoção automática chat → trabalho longo: grava o perfil novo (a retomada e a
 * continuação herdam) e de onde veio. Preserva o resto.
 */
export function withRunPromotion(budgetJson: unknown): Record<string, unknown> {
	return { ...asRecord(budgetJson), engineProfile: "long_work", promotedFrom: "chat" };
}

/**
 * Origens que o v2 atende. Escopo `chat`: só a conversa direta do dono com o bot. Escopo `all`: também rotina
 * (inclui alerta, brief "Seu dia" e "só importante"), grupo (run de membro na conversa do grupo), bot→bot, proativo
 * (reflexão e lembrete do bot), webhook e e-mail recebido (ver docs/features/motor-v2.md).
 *
 * Subagente nunca passa por aqui como run do worker: o filho do `delegate_task` roda dentro do pai e herda o motor
 * dele (o pai no v2 usa os ajudantes do `delegate`, com os mesmos eventos e cartões). O guarda abaixo só protege
 * contra um run de origem `subagent` ser enfileirado e escolher motor sozinho.
 */
export function engineV2SupportsRun(input: { origin: string; isGroupRun: boolean; isSubagent?: boolean; scope?: EngineScope }): boolean {
	if (input.isSubagent === true || input.origin === "subagent") return false;
	if (input.origin === "chat") return input.scope === "all" || !input.isGroupRun;
	const viaScopeAll =
		input.origin === "routine" || input.origin === "bot" || input.origin === "proactive" || input.origin === "webhook" || input.origin === "email";
	return input.scope === "all" && viaScopeAll && !input.isGroupRun;
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
	const verb = /\b(pesquis\w+|levant\w+|analis\w+|compar\w+|mapea\w+|investig\w+|monte|montar|elabor\w+|prepar\w+|gere|gerar|crie|criar|escrev\w+|faca|fazer|assista|assistir|abra|abrir|pergunt\w+|resum\w+|researc\w+|analy[sz]e|compare|build|prepare|draft|write|create|generate|benchmark\w*|watch|summari[sz]e|open|ask)\b/;
	const deliverable = /\b(relatorio|estudo|pesquisa de mercado|panorama|benchmark|dossie|planilha|apresentacao|painel|dashboard|analise|comparativo|levantamento|report|study|market research|spreadsheet|presentation|deep dive|overview)\b/;
	if (verb.test(plain) && deliverable.test(plain)) return true;
	// Pedido de várias etapas encadeadas ("abra..., faça perguntas..., compare... e monte"): 3+ verbos de ação diferentes,
	// em pedido de tamanho razoável e com conectores de sequência (vírgulas, "e", "depois"). Pedido casual curto fica em chat.
	if (plain.length >= CHAINED_MIN_CHARS && distinctActionVerbs(plain) >= 3 && sequenceConnectors(plain) >= 2) return true;
	// Pedido longo com verbo de trabalho (várias linhas de instrução) também é tarefa.
	return plain.length >= 200 && verb.test(plain);
}

const ACTION_VERB_STEMS: ReadonlyArray<RegExp> = [
	/\b(pesquis\w+|researc\w+)\b/, /\b(levant\w+)\b/, /\b(analis\w+|analy[sz]e)\b/, /\b(compar\w+|compare)\b/, /\b(mapea\w+)\b/, /\b(investig\w+)\b/,
	/\b(monte|montar|build)\b/, /\b(elabor\w+|prepar\w+|prepare|draft)\b/, /\b(gere|gerar|generate)\b/, /\b(crie|criar|create)\b/, /\b(escrev\w+|write)\b/,
	/\b(faca|fazer)\b/, /\b(assista|assistir|watch)\b/, /\b(abra|abrir|open)\b/, /\b(pergunt\w+|ask)\b/, /\b(resum\w+|summari[sz]e)\b/,
];

/** Tamanho mínimo do pedido para 3+ verbos valerem como etapas encadeadas. */
const CHAINED_MIN_CHARS = 90;

function sequenceConnectors(plain: string): number {
	return (plain.match(/,|;|\b(e|depois|entao|em seguida|and then|then|and)\b/g) ?? []).length;
}

function distinctActionVerbs(plain: string): number {
	return ACTION_VERB_STEMS.reduce((count, stem) => count + (stem.test(plain) ? 1 : 0), 0);
}

/**
 * Perfil do run: forçado pela política do bot ou decidido pelo pedido (só importa no v2). E-mail recebido e webhook
 * nunca escolhem o perfil caro pelo texto: quem escreveu o e-mail/payload é de fora e o texto é dado não confiável; só o dono libera
 * `long_work` (pela política do bot).
 */
export function resolveRunProfile(input: { policy: EnginePolicy; text: string; origin?: string }): RunProfile {
	if (input.policy.workProfile !== "auto") return input.policy.workProfile;
	if (input.origin === "email" || input.origin === "webhook") return "chat";
	return looksLikeLongTask(input.text) ? "long_work" : "chat";
}
