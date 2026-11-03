/**
 * Motor v2 (ADR 0002, F2): qual motor roda o run e com qual perfil de orçamento.
 * Tudo puro e sem migration: a escolha mora em `Bot.policyJson` (por bot) e é congelada no
 * `AgentRun.budgetJson` no começo do run, para a retomada continuar no motor em que nasceu.
 */

export type RunEngine = "v1" | "v2";
/**
 * Motor que o bot pede (`policyJson.engine`). `v3` (harness v3) só é ENTENDIDO pelo leitor: ninguém o grava ainda
 * (set_engine e a rota recusam) e, enquanto o v3 não existe, o worker roda o v2. `RunEngine` segue sendo o motor de fato usado.
 */
export type RequestedEngine = RunEngine | "v3";
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
	/** O bot pediu o v3 (`policyJson.engine = "v3"`). Para o resto do código ele vale como v2 (`explicit`); só `resolveEngine` decide se o v3 vale. */
	requestedV3: boolean;
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
	// `v3` pedido vale como v2 aqui: sem o v3 (ou fora da allowlist) o bot roda no motor novo de hoje.
	const explicit: RunEngine | undefined = policy.engine === "v1" ? "v1" : policy.engine === "v2" || policy.engine === "v3" ? "v2" : undefined;
	const scopeRaw: EngineScope | undefined = policy.engineScope === "all" || policy.engineScope === "chat" ? policy.engineScope : undefined;
	return {
		engine: explicit ?? "v2",
		explicit,
		requestedV3: policy.engine === "v3",
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

/**
 * Resolve o motor pedido contra a flag do deploy. Pura: o worker lê o env na borda e passa aqui.
 * `v3` só vale com `ATLAS_ENGINE_V3` diferente de `off` (botão de emergência) E a conta em `ATLAS_ENGINE_V3_ACCOUNTS`
 * (lista separada por vírgula; vazia ou ausente = ninguém); senão cai no v2. `v1` e `v2` passam como vieram.
 */
export function resolveEngine(input: { requested: RequestedEngine; accountId?: string | null; env?: Record<string, string | undefined> }): RequestedEngine {
	if (input.requested !== "v3") return input.requested;
	const env = input.env ?? {};
	if ((env.ATLAS_ENGINE_V3 ?? "").trim().toLowerCase() === "off") return "v2";
	const account = input.accountId?.trim();
	if (!account) return "v2";
	const allowed = (env.ATLAS_ENGINE_V3_ACCOUNTS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
	return allowed.includes(account) ? "v3" : "v2";
}

/**
 * Motor gravado no `budgetJson` do run (`undefined` = o run ainda não escolheu). Um `v3` gravado (rollback do deploy
 * ou worker sem o v3) retoma no v2: o v3 nunca quebra um run que um worker mais velho precise continuar.
 */
export function readRunEngine(budgetJson: unknown): RunEngine | undefined {
	const engine = asRecord(budgetJson).engine;
	return engine === "v1" ? "v1" : engine === "v2" || engine === "v3" ? "v2" : undefined;
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
 * Perfil do run: forçado pela política do bot (`workProfile`); em `auto` o run NASCE em `chat`. Decisão do dono (03/11): nada de
 * regex sobre o texto do pedido para decidir comportamento. A promoção a trabalho longo vem de sinais estruturais, no meio do
 * run: a lista de 3+ passos que o modelo monta e a 1ª tool de navegador/desktop (`supervisor.gate`).
 */
export function resolveRunProfile(input: { policy: EnginePolicy }): RunProfile {
	return input.policy.workProfile !== "auto" ? input.policy.workProfile : "chat";
}

/** De onde veio um teto que o dono configurou: a conta, o servidor (operador) ou o bot. */
export type RunCapSource = "account" | "server" | "bot";

/** Tetos que valem para o run (gravados no `budgetJson` no começo), para o motivo da parada dizer valor e origem. */
export type RunCaps = {
	costUsd?: number;
	costSource?: RunCapSource;
	wallMs?: number;
	wallSource?: RunCapSource;
	/** Teto de passos EFETIVO do run (no v2, no máximo o limite de segurança). */
	steps?: number;
	/** Só quando o teto de passos efetivo é o que o dono configurou (conta, bot ou pedido); sem origem = limite de segurança. */
	stepsSource?: RunStepsSource;
};

/** De onde veio o teto de passos que o dono configurou. */
export type RunStepsSource = "account" | "bot" | "request";
const STEPS_SOURCES: ReadonlySet<string> = new Set(["account", "bot", "request"]);

const CAP_SOURCES: ReadonlySet<string> = new Set(["account", "server", "bot"]);

/** `budgetJson` com os tetos do run, preservando o resto. Sem nenhum teto devolve o `budgetJson` como estava. */
export function withRunCaps(budgetJson: unknown, caps: RunCaps): Record<string, unknown> {
	const base = asRecord(budgetJson);
	const clean: RunCaps = {
		...(caps.costUsd !== undefined && Number.isFinite(caps.costUsd) && caps.costUsd > 0 ? { costUsd: caps.costUsd, ...(caps.costSource ? { costSource: caps.costSource } : {}) } : {}),
		...(caps.wallMs !== undefined && Number.isFinite(caps.wallMs) && caps.wallMs > 0 ? { wallMs: Math.round(caps.wallMs), ...(caps.wallSource ? { wallSource: caps.wallSource } : {}) } : {}),
		...(caps.steps !== undefined && Number.isFinite(caps.steps) && caps.steps >= 1 ? { steps: Math.floor(caps.steps), ...(caps.stepsSource ? { stepsSource: caps.stepsSource } : {}) } : {}),
	};
	return Object.keys(clean).length > 0 ? { ...base, caps: clean } : { ...base };
}

/** Tetos gravados no `budgetJson` do run (`{}` = nenhum). */
export function readRunCaps(budgetJson: unknown): RunCaps {
	const raw = asRecord(asRecord(budgetJson).caps);
	const source = (value: unknown): RunCapSource | undefined => (typeof value === "string" && CAP_SOURCES.has(value) ? (value as RunCapSource) : undefined);
	const costUsd = typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd > 0 ? raw.costUsd : undefined;
	const wallMs = typeof raw.wallMs === "number" && Number.isFinite(raw.wallMs) && raw.wallMs > 0 ? raw.wallMs : undefined;
	const steps = typeof raw.steps === "number" && Number.isFinite(raw.steps) && raw.steps >= 1 ? Math.floor(raw.steps) : undefined;
	const stepsSource = typeof raw.stepsSource === "string" && STEPS_SOURCES.has(raw.stepsSource) ? (raw.stepsSource as RunStepsSource) : undefined;
	return {
		...(steps !== undefined ? { steps, ...(stepsSource ? { stepsSource } : {}) } : {}),
		...(costUsd !== undefined ? { costUsd, ...(source(raw.costSource) ? { costSource: source(raw.costSource) } : {}) } : {}),
		...(wallMs !== undefined ? { wallMs, ...(source(raw.wallSource) ? { wallSource: source(raw.wallSource) } : {}) } : {}),
	};
}
