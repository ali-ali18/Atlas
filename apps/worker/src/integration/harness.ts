/**
 * Harness dos testes de integração do agente: Postgres real, modelo roteirizado (sem rede), criação do run
 * pela rota real da API (`createRunRoutes`) e processamento pelo processador real do worker.
 * Importe `./env.js` antes deste arquivo.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { prisma, createBot } from "@workspace/db";
import { buildStoredToolMarks } from "@workspace/shared";
import type { WorkerConfig } from "../config.js";
import { processAgentRunJob, type AgentRunProcessorDeps } from "../processors/agent-run.js";

export { prisma };

// ---------------------------------------------------------------- modelo roteirizado

export type ScriptedCall = { name: string; args?: Record<string, unknown>; id?: string };
export type ScriptedStep = {
	/** Texto da resposta (com `tools`, é o texto que acompanha as chamadas). */
	content?: string;
	tools?: ScriptedCall[];
	/** Custo em dólares que o provedor informa nesta chamada. */
	costUsd?: number;
	promptTokens?: number;
	completionTokens?: number;
	/** Roda antes da resposta sair (ex.: pedir cancelamento no meio do run). */
	before?: (request: LlmRequest) => void | Promise<void>;
};
export type LlmRequest = { index: number; model: string; messages: Array<Record<string, unknown>>; toolNames: string[]; stream: boolean; body: Record<string, unknown> };
export type ScriptEntry = ScriptedStep | ((request: LlmRequest) => ScriptedStep);

export type FakeLlm = {
	/** Todas as chamadas ao modelo do run (uma por resposta roteirizada consumida). */
	requests: LlmRequest[];
	/** Chamadas de apoio (sem stream: resumo, manutenção) que a fixture respondeu com texto vazio. */
	auxiliary: number;
	restore: () => void;
};

const ENCODER = new TextEncoder();
function sse(chunks: unknown[]): Response {
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(
		new ReadableStream({ start(controller) { controller.enqueue(ENCODER.encode(body)); controller.close(); } }),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/**
 * Troca `fetch` por um modelo roteirizado: cada chamada de streaming (com ou sem tools: a entrega final do v2 vai sem) consome a próxima entrada de
 * `script` (função ou passo fixo). Roteiro esgotado = erro claro (o run cairia em falha confusa). Qualquer outra
 * URL falha: nenhum teste toca a rede.
 */
export function installFakeLlm(script: ScriptEntry[], options: { repeatLast?: boolean } = {}): FakeLlm {
	const original = globalThis.fetch;
	const llm: FakeLlm = { requests: [], auxiliary: 0, restore: () => { globalThis.fetch = original; } };
	let cursor = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!/openrouter\.ai\/api\/v1\/chat\/completions/.test(url)) throw new Error(`rede bloqueada no teste: ${url}`);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		const tools = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: string } }>) : [];
		if (body.stream !== true) {
			llm.auxiliary += 1;
			return new Response(JSON.stringify({ id: "aux", model: "test/model", choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
		}
		const request: LlmRequest = { index: llm.requests.length, model: String(body.model ?? ""), messages: (body.messages as Array<Record<string, unknown>>) ?? [], toolNames: tools.map((tool) => tool.function?.name ?? ""), stream: true, body };
		llm.requests.push(request);
		let entry = script[cursor];
		if (!entry && options.repeatLast) entry = script[script.length - 1];
		else cursor += 1;
		if (!entry) throw new Error(`roteiro do modelo esgotado na chamada #${request.index + 1}`);
		const step = typeof entry === "function" ? entry(request) : entry;
		await step.before?.(request);
		// Como o fetch de verdade: sinal abortado (cancelamento, shutdown) rejeita com o motivo do abort.
		if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
		const delta: Record<string, unknown> = {};
		if (step.content) delta.content = step.content;
		if (step.tools?.length) {
			delta.tool_calls = step.tools.map((tool, index) => ({ index, id: tool.id ?? `call_${request.index}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) } }));
		}
		const promptTokens = step.promptTokens ?? 100;
		const completionTokens = step.completionTokens ?? 20;
		return sse([
			{ id: `gen-${request.index}`, model: request.model, choices: [{ index: 0, delta }, ] },
			{ id: `gen-${request.index}`, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: step.tools?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost: step.costUsd ?? 0.0001 } },
		]);
	}) as typeof fetch;
	return llm;
}

// ---------------------------------------------------------------- usuários, bots, conversas

export type Fixture = { userId: string; botId: string; conversationId: string };

export async function createUser(label = "integ"): Promise<string> {
	const id = `${label}-${randomUUID()}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
	return id;
}

/** Usuário + bot (com a conversa própria que `createBot` cria) pelo caminho real do db. */
export async function createFixture(options: { engine?: "v1" | "v2"; policy?: Record<string, unknown>; name?: string; isPrimary?: boolean; userId?: string } = {}): Promise<Fixture> {
	const userId = options.userId ?? (await createUser());
	const bot = await createBot({ name: options.name ?? "Cookie", language: "pt-BR" } as never, userId);
	const policy = { ...(options.engine ? { engine: options.engine } : {}), ...(options.policy ?? {}) };
	await prisma.bot.update({ where: { id: bot.id }, data: { ...(Object.keys(policy).length ? { policyJson: policy } : {}), ...(options.isPrimary ? { isPrimary: true } : {}) } });
	const row = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id }, select: { conversationId: true } });
	return { userId, botId: bot.id, conversationId: row.conversationId! };
}

// ---------------------------------------------------------------- API real (Hono + createRunRoutes)

type ApiHono = { request: (path: string, init?: RequestInit) => Promise<Response> };

export type FakeQueue = { added: Array<{ name: string; runId: string; opts?: unknown }>; add: (name: string, data: { runId: string }, opts?: unknown) => Promise<{ id: string }>; getJob: () => Promise<undefined> };

/**
 * Monta a rota real `/v1/runs` da API (Hono + `createRunRoutes`) com sessão falsa do `userId` e fila em memória.
 * O módulo da API é carregado por caminho (o worker não depende do pacote `api`; só os testes o usam).
 */
export async function createApi(userId: string): Promise<{ app: ApiHono; queue: FakeQueue; signals: Array<{ runId: string; kind: string }> }> {
	const apiRoutes = resolve(import.meta.dirname, "../../../api/src/routes/runs.ts");
	const apiAuth = resolve(import.meta.dirname, "../../../api/src/middleware/auth.ts");
	const { Hono } = await import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, "../../../api/node_modules/hono/dist/index.js")).href) as { Hono: new () => { use: (...args: unknown[]) => void; route: (...args: unknown[]) => void; request: ApiHono["request"] } };
	void apiAuth;
	const { createRunRoutes } = await import(/* @vite-ignore */ pathToFileURL(apiRoutes).href) as { createRunRoutes: (config: unknown, deps: unknown) => unknown };
	const queue: FakeQueue = {
		added: [],
		add: async (name, data, opts) => { queue.added.push({ name, runId: data.runId, opts }); return { id: `job-${data.runId}` }; },
		getJob: async () => undefined,
	};
	const signals: Array<{ runId: string; kind: string }> = [];
	const now = new Date();
	const config = { port: 0, hostname: "localhost", openRouterApiKey: "test-key", openRouterModel: "test/model", redisUrl: "", databaseUrl: undefined, chatQueue: null, routineQueue: null, agentRunQueue: queue };
	const app = new Hono();
	app.use("*", async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
		c.set("session", { user: { id: userId, name: "Teste", email: `${userId}@test.local`, emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "s", token: "t", userId, expiresAt: now, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null } });
		await next();
	});
	app.route("/", createRunRoutes(config, {
		validateModel: async () => ({ model: "test/model" }),
		getAccountConfig: async () => ({ v: 1 }),
		publishRunSignal: async (runId: string, kind: string) => { signals.push({ runId, kind }); return true; },
		subscribeRunEvents: () => () => undefined,
		reactionOnly: { loadSettings: async () => ({ enabled: false, jevMode: "off" }), getState: async () => ({}), detect: async () => null, record: async () => null },
	}));
	return { app: app as ApiHono, queue, signals };
}

export async function postJson(app: ApiHono, path: string, body: unknown): Promise<{ status: number; json: any }> {
	const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return { status: response.status, json: await response.json().catch(() => null) };
}

/** Cria o run pela rota real e devolve o id. */
export async function sendChat(app: ApiHono, fixture: Fixture, text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; runId: string; json: any }> {
	const res = await postJson(app, "/v1/runs", { messages: [{ role: "user", content: text }], botId: fixture.botId, conversationId: fixture.conversationId, origin: "chat", ...extra });
	return { status: res.status, runId: res.json?.runId, json: res.json };
}

// ---------------------------------------------------------------- worker real

export const workerConfig = { redisUrl: "", openRouterApiKey: "test-key", openRouterModel: "test/model", summarizerModel: "test/summarizer", agentRunConcurrency: 1 } as unknown as WorkerConfig;

export type WorkerDeps = AgentRunProcessorDeps & { enqueued?: string[] };

/** Processa o job do run pelo `processAgentRunJob` real, com as filas trocadas por listas em memória. */
export function processRun(runId: string, deps: AgentRunProcessorDeps = {}, owner = `worker-${randomUUID().slice(0, 8)}`) {
	return processAgentRunJob({ runId }, workerConfig, owner, {
		enqueueNextRun: async () => true,
		enqueueMemoryReview: async () => undefined,
		enqueueConnectorLesson: async () => undefined,
		enqueueLessonReview: async () => undefined,
		enqueueSkillReview: async () => undefined,
		...deps,
	});
}

// ---------------------------------------------------------------- leitura do que ficou no banco

export async function snapshot(runId: string) {
	const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
	const events = await prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } });
	const steps = await prisma.agentStep.findMany({ where: { runId }, orderBy: { index: "asc" } });
	const messages = run.conversationId
		? await prisma.conversationMessage.findMany({ where: { conversationId: run.conversationId }, orderBy: { createdAt: "asc" } })
		: [];
	return { run, events, steps, messages, usage: (run.usageJson ?? {}) as Record<string, any>, budget: (run.budgetJson ?? {}) as Record<string, any> };
}

// ---------------------------------------------------------------- utilidades de cenário

/**
 * O que um `pickRunEngine` correto faria na criação: grava o motor do run. Existe porque, hoje, TODO run nasce
 * com checkpoint (`createAgentRun`) e `hasCheckpoint: Boolean(checkpoint)` faz o worker ler "retomada no v1" — o v2
 * nunca é escolhido pelo caminho real (ver `motor.integration.ts`, cenário "v2 escolhido pelo bot", marcado `todo`).
 * Os demais cenários usam isto para exercitar o motor v2 em si.
 */
export async function pinEngine(runId: string, engine: "v1" | "v2", profile: "chat" | "long_work" = "chat"): Promise<void> {
	const { recordRunEngine } = await import("@workspace/db");
	const recorded = await recordRunEngine(runId, { engine, profile });
	if (recorded !== engine) throw new Error(`não gravou o motor ${engine} (ficou ${String(recorded)})`);
}

/** Conector MCP falso conectado (ferramentas vêm do cache; nada de rede: a escrita para no cartão de confirmação). */
export async function createFakeConnector(userId: string, options: { slug?: string; markRead?: string[] } = {}): Promise<void> {
	const tools = [
		{ name: "find_customer", description: "Busca um cliente pelo nome.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, annotations: { readOnlyHint: true } },
		{ name: "create_order", description: "Cria um pedido de venda.", inputSchema: { type: "object", properties: { customer: { type: "string" }, total: { type: "number" } }, required: ["customer"] } },
	];
	// Marcação confirmada pelo dono (guarda o hash da definição, como a tela de conectores).
	const marks = Object.fromEntries((options.markRead ?? []).map((name) => [name, "read" as const]));
	await prisma.mcpConnection.create({
		data: {
			userId, slug: options.slug ?? "erp", name: "ERP de teste", url: "http://127.0.0.1:9/mcp", authType: "none", status: "connected",
			toolsCacheJson: tools,
			...(options.markRead?.length ? { toolMarksJson: buildStoredToolMarks(marks, {}, tools) as never } : {}),
		},
	});
}

/** Ordem dos eventos: `seq` crescente sem buracos e o último evento é o fim do run. */
export function eventTypes(events: Array<{ seq: number; type: string }>): string[] {
	return events.map((event) => event.type);
}

// ---------------------------------------------------------------- grupos de bots

/** Texto da última fala do usuário na chamada ao modelo (nos grupos é o prompt do turno do membro). */
export function promptOf(request: LlmRequest): string {
	for (let i = request.messages.length - 1; i >= 0; i--) {
		const message = request.messages[i]!;
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
	}
	return "";
}

/**
 * Anda o despacho do grupo como o worker faz (varredura + run por resposta) até não haver mais nada a fazer:
 * cada passo roda `processGroupTurnsAndPending` e processa, pelo processador real, os runs que ele enfileirou.
 */
export async function driveGroup(options: { jev?: import("@workspace/db").GroupDispatchDeps["jev"]; maxPasses?: number } = {}): Promise<{ passes: number; runIds: string[] }> {
	const { processGroupTurnsAndPending } = await import("../bot-groups.js");
	const runIds: string[] = [];
	let idle = 0;
	let passes = 0;
	for (; passes < (options.maxPasses ?? 40); passes++) {
		const queued: string[] = [];
		const result = await processGroupTurnsAndPending({
			enqueueRun: async (runId) => { queued.push(runId); return true; },
			envDefaultModel: "test/model",
			resolveModel: async () => "test/model",
			...(options.jev ? { jev: options.jev } : {}),
		});
		for (const runId of queued) { runIds.push(runId); await processRun(runId); }
		idle = queued.length === 0 && !result.inFlight ? idle + 1 : 0;
		if (idle >= 2) break;
	}
	return { passes, runIds };
}

/** Fecha turnos e respostas de grupo abertos (restos de execuções anteriores no mesmo banco local). */
export async function resetOpenGroupWork(): Promise<void> {
	if (!process.env.DATABASE_URL) return;
	await prisma.groupReply.updateMany({ where: { status: { in: ["pending", "running"] } }, data: { status: "skipped", finishedAt: new Date() } });
	await prisma.groupTurn.updateMany({ where: { status: { in: ["routing", "active"] } }, data: { status: "done" } });
}
