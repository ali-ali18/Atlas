import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReflectionBotInput, ReflectionChange, ReflectionEvent, ReflectionInput, ReflectionMemory } from "@workspace/shared";
import { runReflection, type MemoryRow, type ReflectionPorts, type ReflectionRunDeps } from "./reflection.js";

const NOW = new Date("2026-10-15T09:30:00Z");
const USER = "u1";
const ORQ = "bot-orq";
const GROK = "bot-grok";
const OTHER = "bot-fin";

const memory = (id: string, content: string, over: Partial<ReflectionMemory> = {}): ReflectionMemory => ({
	id,
	target: "memory",
	content,
	category: null,
	importance: null,
	validUntil: null,
	source: null,
	createdAt: new Date("2026-09-01T00:00:00Z"),
	updatedAt: new Date("2026-09-01T00:00:00Z"),
	...over,
});

function bot(id: string, name: string, over: Partial<ReflectionBotInput> = {}): ReflectionBotInput {
	return { id, name, snippet: name, description: null, isOrchestrator: id === ORQ, memories: [], summary: null, recent: [], newMessages: 0, events: [], ...over };
}

const webhook = (at: string): ReflectionEvent => ({ botId: GROK, botName: "Grok Bot", kind: "webhook", label: "webhook.received", detail: "dokploy-restart: servidor reiniciado", at: new Date(at) });

function inputWith(bots: ReflectionBotInput[], userMemories: ReflectionMemory[] = []): ReflectionInput {
	return { now: NOW, timeZone: "America/Sao_Paulo", since: new Date("2026-10-14T09:30:00Z"), userMemories, bots };
}

type Store = Map<string, MemoryRow>;

function fakePorts(store: Store, extra: Partial<ReflectionPorts> = {}) {
	const log = { adds: [] as Array<{ botId: string; content: string; category?: string }>, deletes: [] as string[], updates: [] as Array<{ id: string; content: string; category?: string }>, cards: [] as Array<{ botId: string }>, rechecks: [] as string[] };
	let n = 0;
	const ports: ReflectionPorts = {
		getOwnedMemory: async (_user, id) => store.get(id) ?? null,
		updateOwnedMemory: async (_user, id, patch) => {
			const row = store.get(id);
			if (!row) return false;
			store.set(id, { ...row, content: patch.content, category: patch.category ?? row.category });
			log.updates.push({ id, content: patch.content, category: patch.category });
			return true;
		},
		deleteOwnedMemory: async (_user, id) => {
			log.deletes.push(id);
			return store.delete(id);
		},
		addMemory: async (input) => {
			n += 1;
			const id = `new${n}`;
			store.set(id, { id, botId: input.botId, target: "memory", content: input.content, category: input.category ?? null, importance: input.importance ?? null });
			log.adds.push({ botId: input.botId, content: input.content, category: input.category });
			return { ok: true, entry: { id } };
		},
		appendCard: async (input) => {
			log.cards.push({ botId: input.botId });
			return { ok: true, fields: ["description"] };
		},
		runRecheck: async ({ objective }) => {
			log.rechecks.push(objective);
			return null;
		},
		...extra,
	};
	return { ports, log };
}

function seed(bots: ReflectionBotInput[], userMemories: ReflectionMemory[]): Store {
	const store: Store = new Map();
	for (const b of bots) for (const m of b.memories) store.set(m.id, { id: m.id, botId: b.id, target: "memory", content: m.content, category: m.category, importance: m.importance });
	for (const m of userMemories) store.set(m.id, { id: m.id, botId: null, target: "user", content: m.content, category: m.category, importance: m.importance });
	return store;
}

type ToolCall = { name: string; args: Record<string, unknown> };

/** Modelo roteirizado: cada passo devolve as chamadas de ferramenta indicadas. */
function scripted(steps: ToolCall[][], seen: { messages: unknown[] } = { messages: [] }) {
	let i = 0;
	const complete = (async (params: { messages: unknown[] }) => {
		if (i === 0) seen.messages = params.messages;
		const calls = steps[i] ?? [];
		i += 1;
		return {
			model: "m",
			usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
			message: { role: "assistant", content: null, tool_calls: calls.map((c, k) => ({ id: `c${i}-${k}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
		};
	}) as unknown as NonNullable<ReflectionRunDeps["complete"]>;
	return { complete, calls: () => i };
}

function harness(input: ReflectionInput, opts: { hasActivity?: boolean; force?: boolean; steps?: ToolCall[][]; ports?: Partial<ReflectionPorts>; conversationId?: string | null } = {}) {
	const store = seed(input.bots, input.userMemories);
	const { ports, log } = fakePorts(store, opts.ports);
	const script = scripted(opts.steps ?? [[{ name: "finish", args: { summary: "", important: false } }]]);
	const out = { finished: null as null | { status: string; summary?: string; important?: boolean; changes?: ReflectionChange[]; detail?: string; stats?: Record<string, unknown> }, posts: [] as string[], notifies: [] as string[] };
	const deps: ReflectionRunDeps = {
		ports,
		complete: script.complete,
		model: "maint",
		apiKey: "k",
		language: "pt-BR",
		hasActivity: opts.hasActivity ?? true,
		force: opts.force ?? false,
		finish: async (patch) => {
			out.finished = patch;
		},
		postMessage: async (_conversation, text) => {
			out.posts.push(text);
		},
		notify: async (_user, _conversation, text) => {
			out.notifies.push(text);
		},
		log: () => undefined,
	};
	const run = () =>
		runReflection({ userId: USER, rowId: "r1", primary: { id: ORQ, name: "Chefe", conversationId: opts.conversationId === undefined ? "conv-orq" : opts.conversationId }, input, now: NOW }, deps);
	return { run, store, log, out, script };
}

const twoBots = () => [bot(ORQ, "Chefe", { memories: [memory("o1", "Usa Dokploy")] }), bot(GROK, "Grok Bot", { memories: [memory("g1", "n8n roda em srv1"), memory("g2", "O n8n roda no srv1")], newMessages: 3 })];

// Refs: user memories primeiro (M1..), depois por bot na ordem. Aqui: M1=o1, M2=g1, M3=g2.

test("não roda sem atividade nova nem pendência: registro skipped, modelo e verificação intocados", async () => {
	const h = harness(inputWith(twoBots()), { hasActivity: false });
	const result = await h.run();
	assert.equal(result.status, "skipped");
	assert.equal(h.out.finished?.detail, "sem atividade nova");
	assert.equal(h.script.calls(), 0);
	assert.equal(h.log.rechecks.length, 0);
	assert.deepEqual(h.out.posts, []);
	assert.deepEqual(h.out.notifies, []);
});

test("manual roda mesmo sem atividade nova", async () => {
	const h = harness(inputWith(twoBots()), { hasActivity: false, force: true });
	const result = await h.run();
	assert.equal(result.status, "done");
	assert.equal(h.script.calls(), 1);
});

test("une duplicadas do mesmo bot, remove obsoleta e registra o texto anterior", async () => {
	const bots = twoBots();
	bots[1]!.memories.push(memory("g3", "Reunião de 01/09 às 10h", { validUntil: new Date("2026-09-02T00:00:00Z") }));
	const h = harness(inputWith(bots), {
		steps: [
			[{ name: "merge_memories", args: { refs: ["M2", "M3"], content: "n8n roda no srv1" } }],
			[{ name: "remove_memory", args: { ref: "M4", reason: "venceu em setembro" } }],
			[{ name: "finish", args: { summary: "Limpei duplicadas.", important: false } }],
		],
	});
	const result = await h.run();
	assert.equal(h.store.get("g1")?.content, "n8n roda no srv1");
	assert.equal(h.store.has("g2"), false);
	assert.equal(h.store.has("g3"), false);
	assert.deepEqual(h.log.deletes.sort(), ["g2", "g3"]);
	const merge = result.changes.find((c) => c.op === "merge");
	assert.deepEqual(merge && merge.op === "merge" ? merge.before : null, ["n8n roda em srv1", "O n8n roda no srv1"]);
	assert.equal(result.changes.find((c) => c.op === "remove")?.op, "remove");
	assert.equal(h.out.posts.length, 1);
	assert.match(h.out.posts[0]!, /Limpeza: 1 memória unida, 1 removida/);
	assert.equal(h.out.notifies.length, 0, "limpeza sem urgência não notifica");
});

test("não une memórias de bots diferentes nem de camadas diferentes", async () => {
	const bots = [...twoBots(), bot(OTHER, "Financeiro", { memories: [memory("f1", "Paga boleto dia 5")] })];
	const users = [memory("u1", "Prefere respostas curtas", { target: "user" })];
	const h = harness(inputWith(bots, users), {
		steps: [
			// Refs: M1=u1 (user), M2=o1, M3=g1, M4=g2, M5=f1.
			[{ name: "merge_memories", args: { refs: ["M3", "M5"], content: "mistura" } }, { name: "merge_memories", args: { refs: ["M1", "M3"], content: "mistura 2" } }],
			[{ name: "finish", args: { summary: "", important: false } }],
		],
	});
	await h.run();
	assert.equal(h.log.deletes.length, 0);
	assert.equal(h.log.updates.length, 0);
	assert.equal(h.store.get("g1")?.content, "n8n roda em srv1");
});

test("junta duplicadas do perfil user", async () => {
	const users = [memory("u1", "Chama-se Ana", { target: "user" }), memory("u2", "O nome dela é Ana", { target: "user" })];
	const h = harness(inputWith(twoBots(), users), {
		steps: [[{ name: "merge_memories", args: { refs: ["M1", "M2"], content: "Chama-se Ana" } }], [{ name: "finish", args: { summary: "", important: false } }]],
	});
	const result = await h.run();
	assert.deepEqual(h.log.deletes, ["u2"]);
	assert.equal(result.changes[0]?.op, "merge");
});

test("isolamento: fatos cruzados vão só para a memória do orquestrador, mesmo se o modelo tentar outro destino", async () => {
	const h = harness(inputWith(twoBots()), {
		steps: [
			[
				{ name: "save_fact", args: { content: "Sync do Bling no n8n falhando com invalid_token desde 8/10", origin: "Grok Bot", botId: OTHER, target: "user", bot: GROK } },
				{ name: "save_fact", args: { content: "Servidor reiniciado 15/10 08:43", origin: "webhook do Dokploy", botId: GROK } },
			],
			[{ name: "finish", args: { summary: "Sync do Bling no n8n está falhando.", important: true } }],
		],
	});
	await h.run();
	assert.equal(h.log.adds.length, 2);
	assert.ok(h.log.adds.every((add) => add.botId === ORQ), "todo add é do orquestrador");
	assert.match(h.log.adds[0]!.content, /origem: Grok Bot/);
	assert.ok(![...h.store.values()].some((row) => row.botId === OTHER && row.content.includes("Bling")));
	assert.ok(![...h.store.values()].some((row) => row.target === "user" && row.content.includes("Bling")));
	assert.equal(h.store.get("g1")?.content, "n8n roda em srv1", "memórias dos outros bots intactas");
});

test("pendência detectada em conversa antiga vira memória do orquestrador com categoria, origem e status", async () => {
	const bots = [bot(ORQ, "Chefe"), bot(GROK, "Grok Bot", { summary: "Há semanas o usuário pediu ajuda com o sync do Bling no n8n; não houve confirmação.", newMessages: 0 })];
	const h = harness(inputWith(bots), {
		steps: [
			[{ name: "save_pending", args: { content: "Pediu ajuda com o sync do Bling no n8n; não confirmado resolvido", origin_bot: "B2", importance: 0.8 } }],
			[{ name: "save_pending", args: { content: "Sync do Bling no n8n não foi confirmado como resolvido", origin_bot: "B2" } }],
			[{ name: "finish", args: { summary: "Há uma pendência do n8n.", important: false } }],
		],
	});
	const result = await h.run();
	assert.equal(h.log.adds.length, 1, "a repetida não duplica");
	assert.equal(h.log.adds[0]!.category, "pendencia");
	assert.equal(h.log.adds[0]!.botId, ORQ);
	assert.match(h.log.adds[0]!.content, /^\[ABERTA\] Pediu ajuda com o sync do Bling.*\(origem: Grok Bot, 15\/10\)$/);
	assert.equal(result.changes.filter((c) => c.op === "pending-save").length, 1);
});

const openPending = (id: string, text: string, importance: number, updated = "2026-10-01T00:00:00Z") =>
	memory(id, `[ABERTA] ${text} (origem: Grok Bot, 02/09)`, { category: "pendencia", importance, updatedAt: new Date(updated) });

const recheckAnswer = (results: unknown[]) => async () => ({ status: "completed", text: `Pronto.\n${JSON.stringify({ results })}` });

test("reverificação: só até 3 pendências, por importância; problema relata, notifica e mantém aberta", async () => {
	const pendings = [openPending("p1", "sync Bling parado", 0.9), openPending("p2", "domínio vencendo", 0.8), openPending("p3", "backup do banco", 0.7), openPending("p4", "impressora", 0.2)];
	const bots = [bot(ORQ, "Chefe", { memories: pendings }), bot(GROK, "Grok Bot")];
	const h = harness(inputWith(bots), {
		hasActivity: false,
		ports: {
			runRecheck: async function (this: unknown, args) {
				h.log.rechecks.push(args.objective);
				return recheckAnswer([{ ref: "P1", status: "problem", finding: "workflow falhando com invalid_token desde 8/10" }, { ref: "P2", status: "unknown", finding: "" }])();
			},
		},
	});
	const result = await h.run();
	assert.equal(h.script.calls(), 0, "sem atividade nova só verifica pendências");
	assert.equal(h.log.rechecks.length, 1);
	const objective = h.log.rechecks[0]!;
	assert.match(objective, /P1: \[ABERTA\] sync Bling parado/);
	assert.match(objective, /P3: \[ABERTA\] backup do banco/);
	assert.doesNotMatch(objective, /impressora/);
	assert.equal(h.store.get("p1")?.category, "pendencia", "continua aberta");
	assert.match(h.store.get("p1")!.content, /verificada 15\/10: problema/);
	assert.equal(h.out.posts.length, 1);
	assert.match(h.out.posts[0]!, /Ainda com problema: sync Bling parado .* invalid_token/);
	assert.equal(h.out.notifies.length, 1, "problema encontrado notifica");
	assert.equal(result.changes.filter((c) => c.op === "pending-checked").length, 2);
});

test("pendência resolvida é marcada, aparece uma vez no relatório e some das próximas verificações", async () => {
	const bots = [bot(ORQ, "Chefe", { memories: [openPending("p1", "sync Bling parado", 0.9)] }), bot(GROK, "Grok Bot")];
	const h = harness(inputWith(bots), {
		hasActivity: false,
		ports: { runRecheck: recheckAnswer([{ ref: "P1", status: "resolved", finding: "workflow voltou a rodar" }]) },
	});
	await h.run();
	const row = h.store.get("p1")!;
	assert.equal(row.category, "pendencia-resolvida");
	assert.match(row.content, /^\[RESOLVIDA 15\/10\] sync Bling parado/);
	assert.match(h.out.posts[0]!, /Resolvida: sync Bling parado/);
	assert.equal(h.out.notifies.length, 0, "resolvida não é alerta");

	// Dia seguinte: a resolvida não é mais candidata e, sem atividade, a reflexão nem roda.
	const next = harness(inputWith([bot(ORQ, "Chefe", { memories: [memory("p1", row.content, { category: row.category })] }), bot(GROK, "Grok Bot")]), { hasActivity: false });
	const second = await next.run();
	assert.equal(second.status, "skipped");
	assert.equal(next.log.rechecks.length, 0);
	assert.deepEqual(next.out.posts, []);
});

test("verificação que falha ou estoura o prazo não altera nada nem alarma", async () => {
	const bots = [bot(ORQ, "Chefe", { memories: [openPending("p1", "sync Bling parado", 0.9)] }), bot(GROK, "Grok Bot")];
	const h = harness(inputWith(bots), { hasActivity: false, ports: { runRecheck: async () => null } });
	const result = await h.run();
	assert.equal(result.status, "done");
	assert.equal(h.store.get("p1")?.category, "pendencia");
	assert.deepEqual(h.out.posts, []);
	assert.deepEqual(h.out.notifies, []);
});

test("webhooks repetidos chegam ao modelo como um fato com contagem; rotina ok vira ruído", async () => {
	const bots = [
		bot(ORQ, "Chefe"),
		bot(GROK, "Grok Bot", {
			events: [
				webhook("2026-10-15T11:43:00Z"),
				webhook("2026-10-15T12:43:00Z"),
				{ botId: GROK, botName: "Grok Bot", kind: "routine", label: "Resumo diário", detail: "ok", ok: true, at: new Date("2026-10-15T07:00:00Z") },
			],
			newMessages: 2,
		}),
	];
	const seen = { messages: [] as unknown[] };
	const store = seed(bots, []);
	const { ports, log } = fakePorts(store);
	const script = scripted(
		[
			[{ name: "save_fact", args: { content: "Servidor reiniciado em 15/10 08:43 (dokploy-restart), 2 avisos", origin: "webhook do Dokploy" } }],
			[{ name: "finish", args: { summary: "O servidor reiniciou hoje às 08:43.", important: false } }],
		],
		seen,
	);
	const posts: string[] = [];
	const result = await runReflection(
		{ userId: USER, rowId: "r1", primary: { id: ORQ, name: "Chefe", conversationId: "c" }, input: inputWith(bots), now: NOW },
		{ ports, complete: script.complete, model: "m", apiKey: "k", language: "pt-BR", hasActivity: true, force: false, finish: async () => undefined, postMessage: async (_c, t) => void posts.push(t), log: () => undefined },
	);
	const userMessage = (seen.messages[1] as { content: string }).content;
	assert.equal((userMessage.match(/webhook\.received/g) ?? []).length, 1, "um grupo só");
	assert.match(userMessage, /Webhook: webhook\.received.*\(2x/);
	assert.match(userMessage, /1 execuções de rotina\/lembrete sem problema: ignore/);
	assert.doesNotMatch(userMessage, /Resumo diário/);
	assert.equal(log.adds.length, 1);
	assert.equal(log.adds[0]!.botId, ORQ);
	assert.equal(result.posted, true);
	assert.equal(posts.length, 1);
});

test("cartão de perfil só para bots do usuário, com teto, e nada é aplicado sozinho", async () => {
	const bots = [bot(ORQ, "Chefe"), bot(GROK, "Grok Bot")];
	const steps: ToolCall[][] = [
		[
			{ name: "suggest_bot_profile", args: { bot_ref: "B2", description: "Especialista em n8n e Bling.", reason: "o bot é usado para isso" } },
			{ name: "suggest_bot_profile", args: { bot_ref: "B9", description: "x", reason: "bot inexistente" } },
			{ name: "suggest_bot_profile", args: { bot_ref: "B2", snippet: "n8n", reason: "2" } },
			{ name: "suggest_bot_profile", args: { bot_ref: "B1", snippet: "geral", reason: "3" } },
			{ name: "suggest_bot_profile", args: { bot_ref: "B2", name: "n8n Bot", reason: "4 passa do teto" } },
		],
		[{ name: "finish", args: { summary: "Sugeri melhorar o perfil do Grok Bot.", important: false } }],
	];
	const h = harness(inputWith(bots), { steps });
	const result = await h.run();
	assert.equal(h.log.cards.length, 3);
	assert.equal(result.changes.filter((c) => c.op === "profile-card").length, 3);
	assert.equal(h.log.updates.length, 0);
	assert.match(h.out.posts[0]!, /3 sugestões aguardando você/);
});

test("sem conversa do orquestrador não há cartão nem mensagem, mas o registro é gravado", async () => {
	const h = harness(inputWith(twoBots()), {
		conversationId: null,
		steps: [[{ name: "suggest_bot_profile", args: { bot_ref: "B2", snippet: "x", reason: "y" } }], [{ name: "finish", args: { summary: "Achei algo.", important: true } }]],
	});
	const result = await h.run();
	assert.equal(h.log.cards.length, 0);
	assert.equal(result.posted, false);
	assert.equal(result.notified, false);
	assert.equal(h.out.finished?.status, "done");
});

test("push só quando importante; nada relevante grava só o registro", async () => {
	const quiet = harness(inputWith(twoBots()), { steps: [[{ name: "finish", args: { summary: "", important: false } }]] });
	const q = await quiet.run();
	assert.equal(q.posted, false);
	assert.deepEqual(quiet.out.posts, []);
	assert.deepEqual(quiet.out.notifies, []);
	assert.equal(quiet.out.finished?.status, "done", "o registro existe");

	const calm = harness(inputWith(twoBots()), { steps: [[{ name: "finish", args: { summary: "Tudo em ordem, nada novo de relevante.", important: false } }]] });
	const c = await calm.run();
	assert.equal(c.posted, false, "resumo sem achado nem limpeza não vira mensagem");

	const alert = harness(inputWith(twoBots()), { steps: [[{ name: "finish", args: { summary: "O sync do Bling no n8n está falhando.", important: true } }]] });
	const a = await alert.run();
	assert.equal(a.posted, true);
	assert.equal(a.notified, true);
	assert.equal(alert.out.notifies.length, 1);
	assert.match(alert.out.notifies[0]!, /sync do Bling/);
});

test("limites de custo: para no teto de passos e de tokens", async () => {
	const calls: ToolCall[][] = Array.from({ length: 20 }, () => [{ name: "remove_memory", args: { ref: "M99", reason: "x" } }]);
	const h = harness(inputWith(twoBots()), { steps: calls });
	await h.run();
	assert.ok(h.script.calls() <= 8, `chamadas do modelo: ${h.script.calls()}`);
	assert.equal(h.out.finished?.status, "done");
});

function failingAfter(first: ToolCall[], error: Error) {
	let i = 0;
	return (async () => {
		i += 1;
		if (i > 1) throw error;
		return {
			model: "m",
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			message: { role: "assistant", content: null, tool_calls: first.map((c, k) => ({ id: `c${k}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
		};
	}) as unknown as NonNullable<ReflectionRunDeps["complete"]>;
}

test("falha do modelo vira registro failed com motivo curto, mantém as alterações e loga sem segredo", async () => {
	const lines: string[] = [];
	const error = Object.assign(new Error("No endpoints found that support tool use. Bearer sk-or-v1-abcdef123456"), { name: "OpenRouterError", status: 404 });
	const store = seed(twoBots(), []);
	const { ports } = fakePorts(store);
	let finished: { status: string; detail?: string; changes?: ReflectionChange[]; stats?: Record<string, unknown> } | null = null;
	const result = await runReflection(
		{ userId: USER, rowId: "r1", primary: { id: ORQ, name: "Chefe", conversationId: "conv-orq" }, input: inputWith(twoBots()), now: NOW },
		{
			ports,
			complete: failingAfter([{ name: "save_fact", args: { content: "Servidor reiniciou", origin: "Dokploy" } }], error),
			model: "maint",
			apiKey: "k",
			language: "pt-BR",
			hasActivity: true,
			force: false,
			finish: async (patch) => {
				finished = patch;
			},
			postMessage: async () => undefined,
			log: (line) => lines.push(line),
		},
	);
	assert.equal(result.status, "failed");
	assert.equal(finished!.status, "failed");
	assert.equal(finished!.detail, "modelo de manutenção sem suporte a ferramentas");
	assert.equal(finished!.changes?.length, 1, "o que já foi gravado fica no registro");
	assert.equal(finished!.stats?.code, "model_no_tools");
	assert.equal(finished!.stats?.stage, "model");
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /^\[reflection\] user=u1 falhou: model_no_tools stage=model /);
	assert.ok(!lines[0]!.includes("sk-or-v1-abcdef123456"), "sem segredo no log");
});
