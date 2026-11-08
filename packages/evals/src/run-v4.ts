import { createHash } from "node:crypto";
import {
	createEventsAdapter,
	createHelpers,
	createMemoryStoreBackend,
	createSpendLedger,
	chainsForAllRoles,
	createLlmAdapter,
	createQueueAdapter,
	createSseMapper,
	createStoreAdapter,
	createSystemClock,
	createSystemRandom,
	createVaultAdapter,
	FakeAgenda,
	FakeDeliverables,
	FakeFileStore,
	FakeMemory,
	FakeSettings,
	FakeTaskListStore,
	runAgent,
	setupPreset,
	type CapabilityRegistry,
	type PolicyContext,
	type PriorProvenance,
	type RunLimits,
	type Sandbox,
} from "@workspace/agent";
import { DEFAULT_PROACTIVE_SETTINGS, parseModelRef, type ComputerUseEvent, type RunStop } from "@workspace/shared";
import { EVAL_USER_ID } from "./environment.js";
import type { StreamChat } from "./mock-model.js";
import type { Scenario } from "./scenario.js";
import { createFixtureEmail, createFixtureShopping, fixtureSearchFor } from "./v4-ports.js";

/**
 * Motor v4 no eval: `runAgent` com o preset `full`, o mesmo que o worker monta (F3, auditoria T1), e portas falsas em
 * memória. É a ponta que faz `matrix --engines v4` rodar o pipeline inteiro; NÃO é paridade com o legado. Limites:
 *  - web: `Search` responde pelos fixtures `web_search`/`web_extract` do cenário (`v4-ports.ts`), para a mãe e para os
 *    ajudantes; entregas, memória, configurações e tarefas são falsas em memória (`Fake*` do agent);
 *  - `research`: ajudantes REAIS (`createHelpers`, papel `helper` do mesmo LLM do run, livro de gasto ligado ao kernel da
 *    mãe, como em `apps/worker/src/engine-v4.ts`). As chamadas dos ajudantes passam pelo mesmo `streamChat`, então entram
 *    no custo medido do run;
 *  - compras: `FakeShopping` com as páginas montadas dos fixtures `web_extract` (JSON-LD), cartões e compras em memória;
 *  - agenda: `FakeAgenda` no fuso do cenário e relógio fixo em 05/11/2026 (`EVAL_NOW`); o run de agenda (wake) não roda aqui;
 *  - os fixtures de conector do cenário (agenda, e-mail…) não são ligados: cenário que depende deles falha por falta de
 *    capacidade;
 *  - o histórico do cenário entra como falas do dono/assistente em texto (turnos com tool viram nota de texto).
 */

/** Relógio fixo do eval: a data dos cenários é 05/11/2026, então "amanhã" e os horários do roteiro são os mesmos em qualquer dia de execução. */
export const EVAL_NOW = new Date("2026-11-05T12:00:00.000Z");

const sha256 = (payload: string): string => createHash("sha256").update(payload).digest("hex");

const noSandbox: Sandbox = { run: async () => ({ ok: false, error: "Sem VM no eval do motor v4." }), release: async () => undefined };

export type RunV4Params = {
	scenario: Scenario;
	apiKey: string;
	model: string;
	runId: string;
	streamChat: StreamChat;
	maxSteps: number;
	signal: AbortSignal;
	onEvent: (event: ComputerUseEvent) => void;
};

export async function runScenarioV4(params: RunV4Params): Promise<{ text: string; stop: RunStop }> {
	const { scenario } = params;
	const ref = parseModelRef(params.model);
	const entry = { provider: ref.provider, model: ref.slug };
	const chains = chainsForAllRoles(entry);
	const clock = createSystemClock();
	const evalClock = { now: () => EVAL_NOW };
	const mapper = createSseMapper({ runId: params.runId, model: params.model });
	const policy: PolicyContext = { surface: "chat", ownerPresent: true, autonomy: "balanced", rules: [] };
	const limits: RunLimits = { ownerMaxSteps: params.maxSteps };
	const search = fixtureSearchFor(scenario);
	const language = scenario.bot.language === "auto" ? undefined : scenario.bot.language;
	const ledger = createSpendLedger();
	let motherRegistry: CapabilityRegistry | undefined;
	let motherProvenance: (() => PriorProvenance) | undefined;
	const llm = createLlmAdapter({ streamChat: params.streamChat as never, chains, apiKeyFor: () => params.apiKey || "eval", clock });
	const helpers = createHelpers({
		runId: params.runId,
		ownerId: EVAL_USER_ID,
		llm,
		clock,
		random: createSystemRandom(),
		hash: sha256,
		motherRegistry: () => {
			if (!motherRegistry) throw new Error("helpers: o registro da mãe ainda não está pronto");
			return motherRegistry;
		},
		motherPolicy: policy,
		motherLimits: limits,
		motherProvenance: () => motherProvenance?.(),
		ledger,
		search,
		...(language && { language }),
	});
	const shopping = createFixtureShopping(scenario.tools.fixtures);
	const email = createFixtureEmail(scenario.tools.fixtures, EVAL_USER_ID);
	const setup = setupPreset("full", { search, files: new FakeFileStore(), deliverables: new FakeDeliverables().ports(), memory: new FakeMemory(), settings: new FakeSettings(), taskLists: new FakeTaskListStore(), helpers, shopping: shopping.ports, email: email.ports, agenda: new FakeAgenda({ ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: scenario.locale?.timezone ?? DEFAULT_PROACTIVE_SETTINGS.timezone }) });
	motherRegistry = setup.registry;
	const history = [
		...scenario.history.map((message) => {
			const text = "content" in message && typeof message.content === "string" ? message.content : "";
			return message.role === "assistant" ? ({ kind: "assistant", text } as const) : ({ kind: "owner", text } as const);
		}),
		{ kind: "owner", text: scenario.user } as const,
	].filter((item) => item.text.length > 0);
	const result = await runAgent({
		runId: params.runId,
		ownerId: EVAL_USER_ID,
		input: { stableSystem: setup.stableSystem, contextSections: [], history: history as never },
		ports: {
			llm,
			store: createStoreAdapter(createMemoryStoreBackend()),
			queue: createQueueAdapter({ add: async () => { throw new Error("Sem fila no eval do motor v4."); }, getJob: async () => null }),
			sandbox: noSandbox,
			vault: createVaultAdapter({ listHandles: async () => [], resolveSecret: async () => null }),
			clock: evalClock,
			random: createSystemRandom(),
			events: createEventsAdapter({ runId: params.runId, userId: EVAL_USER_ID, map: (event) => mapper.mapRunEvent(event), persist: params.onEvent }),
		},
		registry: setup.registry,
		policy,
		limits,
		hash: sha256,
		spend: ledger.motherHook(),
		exposeProvenance: (read) => {
			motherProvenance = read;
		},
		...(language && { language }),
		signal: params.signal,
	});
	if (result.status === "failed") throw new Error(`Motor v4 falhou: ${result.reason ?? "erro desconhecido"}`);
	return { text: result.text, stop: { reason: result.stop?.kind === "cost" ? "budget_cost" : result.stop ? "budget_steps" : "answered" } };
}
