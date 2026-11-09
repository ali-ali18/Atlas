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
	agendaRunPolicy,
	buildAgendaWake,
	createAgendaRunCapability,
	createBriefCapability,
	createCapabilityRegistry,
	FakeDeliverables,
	FakeFileStore,
	FakeMemory,
	FakeSettings,
	FakeTaskListStore,
	runAgent,
	setupPreset,
	PRESETS,
	presetStablePrompt,
	type CapabilityRegistry,
	type PolicyContext,
	type PriorProvenance,
	type RunLimits,
	type Sandbox,
} from "@workspace/agent";
import { DEFAULT_PROACTIVE_SETTINGS, planAgendaItem, parseModelRef, type ComputerUseEvent, type RunStop } from "@workspace/shared";
import { EVAL_USER_ID } from "./environment.js";
import type { StreamChat } from "./mock-model.js";
import type { Scenario } from "./scenario.js";
import { createFixtureCodeSandbox } from "./v4-code-sandbox.js";
import { createFixtureBrowser, createFixtureBriefEmail, createFixtureCalendar, createFixtureEmail, createFixtureShopping, fixtureSearchFor } from "./v4-ports.js";

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
	const asBrief = scenario.run.agendaBrief === true;
	const policy: PolicyContext = asBrief ? agendaRunPolicy(null) : { surface: "chat", ownerPresent: true, autonomy: scenario.run.autonomy ?? "balanced", rules: [] };
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
	const timezone = scenario.locale?.timezone ?? DEFAULT_PROACTIVE_SETTINGS.timezone;
	const calendar = createFixtureCalendar(scenario.tools.fixtures, timezone);
	const agenda = new FakeAgenda({ ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone });
	const codeSandbox = scenario.run.codeFixture ? await createFixtureCodeSandbox(scenario.run.codeFixture) : undefined;
	// Navegador (F8.1): só quando o cenário monta uma página (`browser_page`); sem VM, a capacidade nem é oferecida.
	const browser = createFixtureBrowser(scenario.tools.fixtures);
	const setup = setupPreset("full", { ...(codeSandbox && { code: {} }), search, files: new FakeFileStore(), deliverables: new FakeDeliverables().ports(), memory: new FakeMemory(), settings: new FakeSettings(), taskLists: new FakeTaskListStore(), helpers, shopping: shopping.ports, email: email.ports, calendar: calendar.ports, agenda, ...(browser && { browser: true }) });
	// Plano do dia: o mesmo registro do worker para o run do brief (agenda_result + brief_sources + day_plan), com o item de brief
	// ligado ao run como a varredura faz, e o wake que o modelo lê. As fontes vêm dos fixtures (agenda do Google e e-mail).
	let registry = setup.registry;
	let briefHistory: ReturnType<typeof buildAgendaWake>["history"] | undefined;
	if (asBrief) {
		const settings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone };
		const planned = planAgendaItem({ request: { kind: "brief", note: "Prepare the owner's day plan: today's commitments, emails that need action, pending items and deliveries.", when: "2026-11-06T07:30" }, now: EVAL_NOW, settings });
		if (!planned.ok) throw new Error(planned.error);
		const created = await agenda.create(EVAL_USER_ID, planned.plan, { sourceRunId: "eval" });
		if (!created.ok) throw new Error(created.error);
		agenda.startRun(EVAL_USER_ID, created.item.id, params.runId);
		const briefEmail = createFixtureBriefEmail(scenario.tools.fixtures);
		registry = createCapabilityRegistry([createAgendaRunCapability(agenda), createBriefCapability({ agenda, calendar: calendar.ports.calendar, cards: { show: async () => undefined }, ...(briefEmail && { email: briefEmail }) })]);
		briefHistory = buildAgendaWake({ item: { kind: "brief", note: planned.plan.note, runCount: 1, maxRuns: null, untilAt: null, grant: null }, now: EVAL_NOW, timeZone: timezone }).history;
	}
	motherRegistry = registry;
	const history = briefHistory ?? [
		...scenario.history.map((message) => {
			const text = "content" in message && typeof message.content === "string" ? message.content : "";
			return message.role === "assistant" ? ({ kind: "assistant", text } as const) : ({ kind: "owner", text } as const);
		}),
		{ kind: "owner", text: scenario.user } as const,
	].filter((item) => item.text.length > 0);
	const result = await runAgent({
		runId: params.runId,
		ownerId: EVAL_USER_ID,
		input: { stableSystem: asBrief ? presetStablePrompt(PRESETS.full, registry) : setup.stableSystem, contextSections: [], history: history as never },
		ports: {
			llm,
			store: createStoreAdapter(createMemoryStoreBackend()),
			queue: createQueueAdapter({ add: async () => { throw new Error("Sem fila no eval do motor v4."); }, getJob: async () => null }),
			sandbox: codeSandbox ?? browser ?? noSandbox,
			vault: createVaultAdapter({ listHandles: async () => [], resolveSecret: async () => null }),
			clock: evalClock,
			random: createSystemRandom(),
			events: createEventsAdapter({ runId: params.runId, userId: EVAL_USER_ID, map: (event) => mapper.mapRunEvent(event), persist: params.onEvent }),
		},
		registry,
		policy,
		...(asBrief && { askOwner: false }),
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
