/**
 * Motor v4 no worker, com portas falsas (sem banco, rede nem modelo).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/engine-v4.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapabilityRegistry, createSseMapper, type Helpers, type Llm, type LlmChatRequest, type LlmStreamEvent, type RunEvent } from "@workspace/agent";
import type { ProviderStreamChat } from "@workspace/llm";
import type { ComputerUseEvent } from "@workspace/shared";
import { buildV4RoleChains, cheapModelFromEnv, createMinimalEventMapper, createV4Llm, dropProcessorOwnedEvents, meterLlm, ownerStepsLimit, runEngineV4, stoppedEffectsNote, storeBackendFromDb, unavailableQueue, unavailableSandbox, V4_CHEAP_MODEL_DEFAULT, vaultBackendFromService, type V4Db } from "./engine-v4.js";

const served = { provider: "fake", model: "m-1" };
const done = (costUsd?: number): LlmStreamEvent => ({ type: "done", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, ...(costUsd !== undefined ? { costUsd } : {}) }, served });

function scripted(turns: LlmStreamEvent[][]): Llm & { requests: LlmChatRequest[] } {
	const requests: LlmChatRequest[] = [];
	return {
		requests,
		async contextWindow() {
			return 100_000;
		},
		async *chat(request) {
			requests.push(request);
			const turn = turns.shift();
			if (!turn) throw new Error("sem turno");
			for (const event of turn) yield event;
		},
	};
}

function fakeDb() {
	const calls: Array<{ fn: string; userId: string; lease?: unknown }> = [];
	const checkpoints = new Map<string, { runId: string; userId: string; step: number; state: string; payload: unknown }>();
	const db = {
		saveCheckpoint: async (userId: string, cp: { runId: string; userId: string; step: number; state: string; payload: unknown }, lease?: unknown) => {
			calls.push({ fn: "saveCheckpoint", userId, lease });
			checkpoints.set(`${userId}:${cp.runId}`, cp);
		},
		loadCheckpoint: async (userId: string, runId: string) => checkpoints.get(`${userId}:${runId}`) ?? null,
		appendJournal: async (e: { userId: string }) => void calls.push({ fn: "appendJournal", userId: e.userId }),
		findJournal: async () => null,
		listJournal: async () => [],
		appendReceipt: async (r: { userId: string }) => void calls.push({ fn: "appendReceipt", userId: r.userId }),
		listReceipts: async () => [],
		saveNote: async (n: { userId: string }) => void calls.push({ fn: "saveNote", userId: n.userId }),
		getNote: async () => null,
		listNotes: async () => [],
		removeNote: async () => false,
		getConversation: async () => ({ offers: [], declinedOffers: [] }),
		saveConversation: async (userId: string) => void calls.push({ fn: "saveConversation", userId }),
	} as unknown as V4Db;
	return { db, calls, checkpoints };
}

const baseInput = (llm: Llm, events: ComputerUseEvent[], db: V4Db) => ({
	runId: "run-1",
	userId: "user-a",
	objective: "Bom dia",
	llm,
	lease: { owner: "w1", token: "t1" },
	persistEvent: (e: ComputerUseEvent) => void events.push(e),
	limits: {},
	ownerPresent: true,
	db,
	registry: createCapabilityRegistry([]),
});

test("run simples: resposta do modelo vira texto, eventos do contrato SSE, uso e checkpoint com o lease", async () => {
	const events: ComputerUseEvent[] = [];
	const { db, calls, checkpoints } = fakeDb();
	const llm = scripted([[{ type: "text_delta", text: "Olá!" }, done(0.01)]]);
	const out = await runEngineV4(baseInput(llm, events, db));
	assert.equal(out.text, "Olá!");
	assert.equal(out.parked, false);
	assert.equal(out.hitWall, false);
	assert.deepEqual(out.stop, { reason: "answered" });
	assert.equal(out.model, "fake/m-1");
	assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.01 });
	assert.deepEqual(events.filter((e) => e.type === "assistant_delta").map((e) => (e as { delta: string }).delta), ["Olá!"]);
	assert.ok(calls.filter((c) => c.fn === "saveCheckpoint").every((c) => c.userId === "user-a" && JSON.stringify(c.lease) === JSON.stringify({ owner: "w1", token: "t1" })));
	assert.equal(checkpoints.get("user-a:run-1")?.state, "DONE");
	// o pedido do dono chegou ao modelo
	assert.match(JSON.stringify(llm.requests[0]?.messages), /Bom dia/);
});

test("lease perdido: o erro lease_lost do db sobe para o processador tratar", async () => {
	const { db } = fakeDb();
	db.saveCheckpoint = async () => {
		throw new Error("lease_lost");
	};
	await assert.rejects(runEngineV4(baseInput(scripted([[{ type: "text_delta", text: "x" }, done()]]), [], db)), /lease_lost/);
});

test("falha do modelo vira erro (nunca sucesso falso) e 'Parar' propaga o abort", async () => {
	const { db } = fakeDb();
	const failing: Llm = {
		async contextWindow() {
			return 1000;
		},
		// eslint-disable-next-line require-yield
		async *chat() {
			throw new Error("provedor caiu");
		},
	};
	await assert.rejects(runEngineV4(baseInput(failing, [], db)), /v4 engine failed/);
	const controller = new AbortController();
	controller.abort(new Error("parar"));
	await assert.rejects(runEngineV4({ ...baseInput(scripted([[{ type: "text_delta", text: "x" }, done()]]), [], db), signal: controller.signal }));
});

test("limite de gasto do dono vira stop budget_cost e passo de segurança vira hitWall", async () => {
	const { db } = fakeDb();
	const events: ComputerUseEvent[] = [];
	const out = await runEngineV4({ ...baseInput(scripted([[{ type: "text_delta", text: "a" }, { type: "tool_call", call: { id: "c1", name: "note_read", args: { id: "x" } } }, done(5)], [{ type: "text_delta", text: "resumo" }, done(0.1)]]), events, db), limits: { ownerMaxUsd: 1 } });
	assert.deepEqual(out.stop, { reason: "budget_cost" });
	assert.equal(out.hitWall, false);
	const steps = await runEngineV4({ ...baseInput(scripted([[{ type: "tool_call", call: { id: "c1", name: "note_read", args: { id: "x" } } }, done()], [{ type: "text_delta", text: "fim" }, done()]]), [], db), runId: "run-2", limits: { ownerMaxSteps: 1 } });
	assert.deepEqual(steps.stop, { reason: "budget_steps" });
	assert.equal(steps.hitWall, true);
});

test("pergunta ao dono (ask_owner) encerra o turno com stop awaiting_confirmation", async () => {
	const { db } = fakeDb();
	const out = await runEngineV4(baseInput(scripted([[{ type: "tool_call", call: { id: "c1", name: "ask_owner", args: { question: "Qual?" } } }, done()]]), [], db));
	assert.equal(out.stop.reason, "awaiting_confirmation");
});

test("o mapa mínimo de eventos converte texto, chamada e resultado e ignora o resto", () => {
	const map = createMinimalEventMapper("r");
	assert.deepEqual(map({ type: "step", runId: "r", userId: "u", data: { step: 2, final: false } }), []);
	assert.deepEqual(map({ type: "text_delta", runId: "r", userId: "u", data: { text: "oi" } }), [{ type: "assistant_delta", id: "r:2", delta: "oi" }]);
	assert.deepEqual(map({ type: "tool_call", runId: "r", userId: "u", data: { callId: "c", name: "n", args: { a: 1 } } }), [{ type: "tool_call", id: "c", name: "n", args: '{"a":1}', step: 2 }]);
	assert.deepEqual(map({ type: "tool_result", runId: "r", userId: "u", data: { callId: "c", name: "n", status: "error", content: "x" } }), [{ type: "tool_result", id: "c", name: "n", ok: false, summary: "x" }]);
	assert.deepEqual(map({ type: "card", runId: "r", userId: "u", data: {} }), []);
});

test("meterLlm soma o uso e marca custo desconhecido; vault expõe só segredos simples e o dono", async () => {
	const meter = meterLlm(scripted([[done(0.5)], [done()]]));
	for (const _ of [1, 2]) for await (const _event of meter.llm.chat({ role: "main", messages: [] })) void _event;
	assert.deepEqual(meter.usage(), { promptTokens: 20, completionTokens: 10, totalTokens: 30, costUsd: 0.5, costUnknownCalls: 1 });

	const calls: string[] = [];
	const backend = vaultBackendFromService({
		listMeta: async (userId) => (userId === "a" ? [{ kind: "secret", name: "api", label: "" }, { kind: "login", name: "site", label: "Site" }] : []),
		resolveRef: async (userId, ref) => {
			calls.push(`${userId}:${ref.name}`);
			return userId === "a" && ref.name === "api" ? { value: "valor" } : null;
		},
	});
	assert.deepEqual(await backend.listHandles("a"), [{ id: "api", label: "api" }]);
	assert.deepEqual(await backend.listHandles("b"), []);
	assert.equal(await backend.resolveSecret("a", "api"), "valor");
	assert.equal(await backend.resolveSecret("b", "api"), null);
});

test("store do worker: setStatus não grava no banco e o recibo/nota passam o dono", async () => {
	const { db, calls } = fakeDb();
	const store = storeBackendFromDb(db, null);
	await store.setStatus("a", "r", "done");
	await store.saveNote({ id: "n", userId: "a", title: "t", body: "b", pinned: false });
	assert.deepEqual(calls.map((c) => [c.fn, c.userId]), [["saveNote", "a"]]);
});

test("sandbox e fila indisponíveis devolvem ao modelo um texto em inglês, sem nome interno (auditoria F1, A2)", async () => {
	const sandbox = await unavailableSandbox.run("u", {} as never);
	assert.equal(sandbox.ok, false);
	const queued = await unavailableQueue.add("n", { userId: "u", payload: {} }).then(() => "", (e: Error) => e.message);
	const texts = [(sandbox as { error: string }).error, queued];
	for (const text of texts) {
		assert.match(text, /^(The computer|Scheduling)/);
		assert.doesNotMatch(text, /v4|worker|motor|VM e|fila/i);
	}
});

/** O que o processador faz ao fechar o run: UM evento terminal (o `done` da conclusão atômica ou o `error`/`cancelled` do catch). */
const TERMINAL = ["done", "error", "cancelled"] as const;
const terminals = (events: ComputerUseEvent[]) => events.filter((e) => (TERMINAL as readonly string[]).includes(e.type)).map((e) => e.type);

async function runWith(mapKind: "raw" | "filtered", llm: Llm, limits: { ownerMaxUsd?: number; ownerMaxSteps?: number } = {}, signal?: AbortSignal) {
	const events: ComputerUseEvent[] = [];
	const mapper = createSseMapper({ runId: "run-1", model: "fake/m-1" });
	const map = (e: RunEvent) => mapper.mapRunEvent(e);
	const outcome = await runEngineV4({ ...baseInput(llm, events, fakeDb().db), limits, mapEvent: mapKind === "raw" ? map : dropProcessorOwnedEvents(map), ...(signal && { signal }) }).then(
		() => "ok",
		() => "threw",
	);
	return { events, outcome };
}

test("fim do run: o mapa do kernel não repete o done/error/cancelled nem o teto de passos que o processador emite (auditoria F1, B1)", async () => {
	const answer = () => scripted([[{ type: "text_delta", text: "Olá!" }, done(0.01)]]);
	const failing = (): Llm => ({ contextWindow: async () => 1000, async *chat() { throw new Error("provedor caiu"); } });
	const toolStep = () => scripted([[{ type: "tool_call", call: { id: "c1", name: "note_read", args: { id: "x" } } }, done()], [{ type: "text_delta", text: "fim" }, done()]]);

	// resposta normal: o kernel emitiria um `done` próprio; o processador emite o dele (1 no total)
	assert.deepEqual(terminals((await runWith("raw", answer())).events), ["done"]);
	const normal = await runWith("filtered", answer());
	assert.deepEqual(terminals(normal.events), [], "o mapa filtrado deixa o fechamento ao processador");
	assert.ok(normal.events.some((e) => e.type === "assistant_delta"), "o conteúdo do run segue passando");
	assert.deepEqual([...terminals(normal.events), "done"], ["done"], "com o `done` do processador há exatamente um");

	// falha do modelo: sem `error` do kernel (o processador emite o seu ao receber a exceção)
	assert.equal((await runWith("raw", failing())).outcome, "threw");
	assert.ok(terminals((await runWith("raw", failing())).events).includes("error"), "caracterização: sem o filtro o erro sairia duas vezes");
	assert.deepEqual(terminals((await runWith("filtered", failing())).events), []);

	// parar: sem `cancelled` do kernel
	const stop = new AbortController();
	stop.abort(new Error("parar"));
	assert.deepEqual(terminals((await runWith("filtered", answer(), {}, stop.signal)).events), []);

	// teto de passos: a nota é do processador (hitWall); o mapa não a repete
	const steps = await runWith("raw", toolStep(), { ownerMaxSteps: 1 });
	assert.ok(steps.events.some((e) => e.type === "status" && e.status === "budget_exhausted"), "caracterização");
	assert.deepEqual((await runWith("filtered", toolStep(), { ownerMaxSteps: 1 })).events.filter((e) => e.type === "status" && e.status === "budget_exhausted"), []);

	// teto de GASTO: o processador não emite nota, então ela continua vindo do mapa
	const cost = await runWith("filtered", scripted([[{ type: "tool_call", call: { id: "c1", name: "note_read", args: { id: "x" } } }, done(5)], [{ type: "text_delta", text: "resumo" }, done(0.1)]]), { ownerMaxUsd: 1 });
	assert.equal(cost.events.filter((e) => e.type === "status" && e.status === "budget_exhausted").length, 1);
	assert.deepEqual(terminals(cost.events), []);
});

test("teto de passos do dono: só repassa ao kernel quando veio de configuração (auditoria F1, B4)", () => {
	assert.equal(ownerStepsLimit({ steps: 12, stepsSource: "bot" }), 12);
	assert.equal(ownerStepsLimit({ steps: 12, stepsSource: "account" }), 12);
	assert.equal(ownerStepsLimit({ steps: 200 }), undefined, "o de segurança é do kernel");
});

test("cadeias por papel: helper/sleep/classifier começam no modelo barato e só caem no principal; os demais usam o principal (auditoria F1, C5a)", () => {
	const chains = buildV4RoleChains({ model: "deepseek/deepseek-v4.1-flash" });
	const main = { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" };
	const cheap = { provider: "openrouter", model: V4_CHEAP_MODEL_DEFAULT };
	for (const role of ["helper", "sleep", "classifier"] as const) assert.deepEqual(chains[role], [cheap, main], role);
	for (const role of ["main", "code", "vision"] as const) assert.deepEqual(chains[role], [main], role);
	// configurável: o modelo barato do deploy e o modelo por papel mandam; ref inválida cai no padrão do papel
	assert.deepEqual(buildV4RoleChains({ model: "m/x", cheapModel: "m/barato" }).helper[0], { provider: "openrouter", model: "m/barato" });
	assert.deepEqual(buildV4RoleChains({ model: "m/x", roleModels: { helper: "opencode-go/kimi", code: "m/codigo" } }).helper[0], { provider: "opencode-go", model: "kimi" });
	assert.deepEqual(buildV4RoleChains({ model: "m/x", roleModels: { code: "m/codigo" } }).code, [{ provider: "openrouter", model: "m/codigo" }, { provider: "openrouter", model: "m/x" }]);
	assert.deepEqual(buildV4RoleChains({ model: "m/x", roleModels: { helper: "opencode-go/" } }).helper[0], cheap);
	// se o barato é o próprio principal, a cadeia não repete a entrada
	assert.deepEqual(buildV4RoleChains({ model: "m/x", cheapModel: "m/x" }).helper, [{ provider: "openrouter", model: "m/x" }]);
	// a variável do deploy troca o padrão, mas nunca aceita a assinatura do dono (chatgpt/*)
	assert.equal(cheapModelFromEnv({}), V4_CHEAP_MODEL_DEFAULT);
	assert.equal(cheapModelFromEnv({ ATLAS_V4_CHEAP_MODEL: " m/barato " }), "m/barato");
	assert.equal(cheapModelFromEnv({ ATLAS_V4_CHEAP_MODEL: "chatgpt/gpt-x" }), V4_CHEAP_MODEL_DEFAULT);
});

test("Llm do v4: o papel helper chama o modelo barato, o main chama o do run (auditoria F1, C5a)", async () => {
	const called: string[] = [];
	const streamChat = (async (params: { model: string }, handlers?: { onDelta?: (t: string) => void }) => {
		called.push(params.model);
		handlers?.onDelta?.("ok");
		return { message: { role: "assistant", content: "ok" }, model: params.model, finishReason: "stop" };
	}) as unknown as ProviderStreamChat;
	const llm = createV4Llm({ model: "m/principal", streamChat, openRouterKey: "k" });
	for (const role of ["helper", "main", "classifier", "sleep"] as const) for await (const _ of llm.chat({ role, messages: [{ role: "user", content: "x" }] })) void _;
	assert.deepEqual(called, [V4_CHEAP_MODEL_DEFAULT, "m/principal", V4_CHEAP_MODEL_DEFAULT, V4_CHEAP_MODEL_DEFAULT]);
});

test("Llm do v4: janela de contexto é a da entrada do papel e lembra a última conhecida quando a consulta falha (auditoria F1, C3)", async () => {
	const streamChat = (async () => ({ message: { role: "assistant", content: "" } })) as unknown as ProviderStreamChat;
	let unknown = false;
	const asked: string[] = [];
	const llm = createV4Llm({
		model: "m/principal",
		streamChat,
		openRouterKey: "k",
		contextWindow: async (model) => {
			asked.push(model);
			return unknown ? null : model === "m/principal" ? 200_000 : 64_000;
		},
	});
	assert.equal(await llm.contextWindow("main"), 200_000);
	assert.equal(await llm.contextWindow("helper"), 64_000);
	unknown = true;
	assert.equal(await llm.contextWindow("main"), 200_000, "consulta sem resposta: mantém a última, não cai para 128k");
	assert.deepEqual(asked.slice(0, 2), ["m/principal", V4_CHEAP_MODEL_DEFAULT]);
});

test("Llm do v4: o aviso de indisponibilidade segue o idioma do bot (auditoria F1, A1)", async () => {
	const streamChat = (async () => {
		throw Object.assign(new Error("HTTP 503"), { status: 503 });
	}) as unknown as ProviderStreamChat;
	const llm = createV4Llm({ model: "m/principal", streamChat, openRouterKey: "k", language: "en-US" });
	const error = await (async () => {
		for await (const _ of llm.chat({ role: "main", messages: [{ role: "user", content: "x" }] })) void _;
	})().catch((e: Error) => e);
	assert.match((error as Error).message, /^The configured models are unavailable right now/);
});

test("nota de parada: vazia sem efeitos, no idioma do bot, e corta a lista longa (auditoria F1, T2)", () => {
	assert.equal(stoppedEffectsNote([]), "");
	assert.equal(stoppedEffectsNote([{ summary: "  " }]), "");
	assert.equal(stoppedEffectsNote([{ summary: "Arquivo y.md criado" }]), "Parei como você pediu. O que já foi feito continua valendo: Arquivo y.md criado.");
	assert.match(stoppedEffectsNote([{ summary: "a" }, { summary: "b" }], "es-ES"), /^Me detuve como pediste\. .*: a; b\.$/);
	const many = Array.from({ length: 11 }, (_, i) => ({ summary: `r${i}` }));
	assert.match(stoppedEffectsNote(many, "en-US"), /r7; \+3\.$/);
});

// F2.6: sem `registry`, o worker monta o preset `full` com as portas reais do run (aqui, adaptadores falsos).
function fakeAdapters(searched: string[]): NonNullable<Parameters<typeof runEngineV4>[0]["adapters"]> {
	const never = () => assert.fail("adaptador não esperado neste teste");
	return {
		web: { extract: async (url: string) => ({ url, markdown: "# Página", truncated: false }), searxng: async (query: string) => (searched.push(query), [{ url: "https://example.test/r", title: "R", snippet: "resultado" }]) },
		deliverables: { persistArtifact: never, nextVersion: never, countRunFiles: never, loadArtifact: never, createPage: never, render: never, preview: never, persistCard: never } as never,
		memory: { snapshot: never, add: never, getById: never, replaceById: never, removeById: never } as never,
		notebook: { create: never, get: never, search: never, update: never, remove: never, listPinned: never } as never,
		settings: { getBot: never, update: never } as never,
		mcp: { listConnected: async () => [], loadRuntime: async () => null },
	};
}

test("preset full pelas portas reais: capacidades montadas, nada indisponível e a busca passa pelo adaptador do worker", async () => {
	const events: ComputerUseEvent[] = [];
	const logs: string[] = [];
	const searched: string[] = [];
	const { db } = fakeDb();
	const llm = scripted([[{ type: "tool_call", call: { id: "c1", name: "web_search", args: { query: "atlas" } } }, done()], [{ type: "text_delta", text: "Achei." }, done()]]);
	const { registry: _omit, ...input } = baseInput(llm, events, db);
	const out = await runEngineV4({ ...input, botId: "bot-1", adapters: fakeAdapters(searched), log: (m) => void logs.push(m) });
	assert.equal(out.text, "Achei.");
	assert.deepEqual(searched, ["atlas"]);
	assert.deepEqual(logs, [], "com bot, nenhuma capacidade do preset fica sem porta");
	const first = JSON.stringify(llm.requests[0]?.messages);
	assert.match(first, /Work contract/);
	for (const id of ["memory", "tasks", "settings", "deliverables"]) assert.match(first, new RegExp(`- ${id}:`), `${id} no índice de capacidades`);
});

test("preset full sem bot no run: configurações indisponíveis vão ao log técnico e o run segue", async () => {
	const logs: string[] = [];
	const { db } = fakeDb();
	const { registry: _omit, ...input } = baseInput(scripted([[{ type: "text_delta", text: "Oi" }, done()]]), [], db);
	const out = await runEngineV4({ ...input, adapters: fakeAdapters([]), log: (m) => void logs.push(m) });
	assert.equal(out.text, "Oi");
	assert.equal(logs.length, 1);
	assert.match(logs[0] as string, /capacidades sem porta: settings/);
});

// F3.1: ajudantes por run. O worker monta `Helpers` com as portas da mãe (busca pelo adaptador do worker), o papel `helper`
// e o teto do dono compartilhado. A capacidade `research` (frente R) os recebe em `PresetDeps.helpers`.
test("ajudantes do run: leem pela busca do worker, pedem o papel helper, voltam com as fontes lidas e o gasto entra no teto", async () => {
	const searched: string[] = [];
	const { db } = fakeDb();
	const llm = scripted([
		[{ type: "text_delta", text: "Oi" }, done(0.01)],
		// ajudante: lê uma página e responde
		[{ type: "tool_call", call: { id: "h1", name: "web_extract", args: { url: "https://example.test/p" } } }, done(0.01)],
		[{ type: "text_delta", text: "Achados do ajudante" }, done(0.01)],
	]);
	let helpers: Helpers | undefined;
	const { registry: _omit, ...input } = baseInput(llm, [], db);
	await runEngineV4({ ...input, botId: "bot-1", adapters: fakeAdapters(searched), limits: { ownerMaxUsd: 5 }, onHelpers: (h) => (helpers = h) });
	assert.ok(helpers, "o worker monta os ajudantes do run");
	const [result] = await helpers.runAll([{ objective: "Leia a página", capabilities: ["web"] }]);
	assert.equal(result?.status, "done");
	assert.equal(result?.text, "Achados do ajudante");
	assert.deepEqual(result?.sources, [{ url: "https://example.test/p" }]);
	assert.equal(result?.untrustedRead, true);
	assert.ok((result?.spentUsd ?? 0) > 0);
	assert.deepEqual(llm.requests.map((r) => r.role), ["main", "helper", "helper"]);
});

test("ajudante pedindo capacidade que a mãe não tem (o preset sem bot não tem settings) falha sozinho", async () => {
	const { db } = fakeDb();
	const llm = scripted([[{ type: "text_delta", text: "Oi" }, done()]]);
	let helpers: Helpers | undefined;
	const { registry: _omit, ...input } = baseInput(llm, [], db);
	await runEngineV4({ ...input, adapters: fakeAdapters([]), log: () => undefined, onHelpers: (h) => (helpers = h) });
	const [result] = await helpers!.runAll([{ objective: "x", capabilities: ["settings"] }]);
	assert.equal(result?.status, "failed");
	assert.match(result?.error ?? "", /does not have the capability "settings"/);
	assert.equal(llm.requests.length, 1, "o modelo não foi chamado pelo ajudante");
});

test("regras do dono (policyJson.rules) entram na política do run: a tool negada volta como indisponível e a busca não roda", async () => {
	const events: ComputerUseEvent[] = [];
	const searched: string[] = [];
	const { db } = fakeDb();
	const llm = scripted([[{ type: "tool_call", call: { id: "c1", name: "web_search", args: { query: "atlas" } } }, done()], [{ type: "text_delta", text: "Sem busca." }, done()]]);
	const { registry: _omit, ...input } = baseInput(llm, events, db);
	await runEngineV4({ ...input, botId: "bot-1", adapters: fakeAdapters(searched), rules: [{ match: "web_*", verdict: "deny" }] });
	assert.deepEqual(searched, [], "a regra deny impede a busca");
	const second = JSON.stringify(llm.requests[1]?.messages);
	assert.match(second, /not available|unavailable|not_available/i);
});

test("títulos fixados do caderno chegam ao modelo no [context], sem o corpo", async () => {
	const events: ComputerUseEvent[] = [];
	const { db } = fakeDb();
	const llm = scripted([[{ type: "text_delta", text: "Oi." }, done()]]);
	const { registry: _omit, ...input } = baseInput(llm, events, db);
	await runEngineV4({ ...input, botId: "bot-1", adapters: fakeAdapters([]), contextSections: ["Pinned notebook notes (titles only; read one with note_get, find others with note_search):\n- [n1] Plano da semana"] });
	const context = (llm.requests[0]?.messages ?? []).find((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[context]"));
	assert.match(String(context?.content), /\[n1\] Plano da semana/);
});
