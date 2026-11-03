import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { ComputerUseEvent, EffectiveAutonomy } from "@workspace/shared";
import { buildMcpToolset } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { buildEngineV2Catalog } from "./catalog.js";
import { setPolicyShadowSink, type PolicyDivergence } from "../policy/shadow.js";
import type { BotMailboxRecord } from "@workspace/db";
import type { EmailRunContext } from "../email/tools.js";
import { runEngineV2, type EngineV2Options } from "./run.js";

/**
 * Motor v2 fora do chat direto (escopo "all" do bot): rotina, grupo e bot→bot. O que o v1 garante em cada origem
 * (sem humano para perguntar, conector só com o que a autonomia libera, tools de gestão fora da rotina) vale igual.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => ({ description: "configurado" })),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		upsertTaskListCard: vi.fn(async () => undefined),
		getConversationUntrustedAt: vi.fn(async () => null),
		searchMemoryEntries: vi.fn(async () => []),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
	};
});

const erp = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [
		{ name: "buscar_cliente", description: "Busca cliente", inputSchema: { type: "object", properties: { nome: { type: "string" } } }, annotations: { readOnlyHint: true } },
		{ name: "criar_proposta", description: "Cria proposta", inputSchema: { type: "object", properties: { cliente: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
	],
};
const READ = "mcp__erp__buscar_cliente";
const WRITE = "mcp__erp__criar_proposta";
const balanced = { level: "balanced", exceptions: [] } as never;
const autonomous = { level: "autonomous", exceptions: [] } as EffectiveAutonomy;

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } } satisfies LlmToolCall] },
	finishReason: "tool_calls",
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });

async function runOrigin(input: {
	origin: string;
	script: CompleteChatWithToolsResult[];
	/** O toolset do conector foi montado SEM `unattended` (o catálogo precisa filtrar sozinho). */
	options?: Partial<EngineV2Options>;
	extra?: Partial<Parameters<typeof runEngineV2>[0]>;
	text?: string;
	autonomy?: EffectiveAutonomy;
}) {
	const call = vi.fn(async () => ({ ok: true, text: "feito", truncated: false }));
	const autonomy: EffectiveAutonomy = input.autonomy ?? (balanced as EffectiveAutonomy);
	const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy }), call };
	const events: ComputerUseEvent[] = [];
	const queue = [...input.script];
	const requests: Array<{ system: string; toolNames: string[] }> = [];
	const result = await runEngineV2(
		{
			manager: {} as SandboxManager,
			getSessionId: async () => "x",
			sandboxEnabled: false,
			model: "m",
			apiKey: "t",
			messages: [{ role: "user", content: input.text ?? "Veja se o cliente Acme existe e me diga" }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-o",
			runId: "run-o1",
			origin: input.origin,
			mcp,
			autonomy,
			onEvent: (event) => {
				events.push(event);
			},
			streamChat: async (params) => {
				requests.push({
					system: params.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"),
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
				});
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return next;
			},
			...input.extra,
		},
		{ profile: "chat", ...input.options },
	);
	return { call, events, result, requests, results: events.filter((e): e is Extract<ComputerUseEvent, { type: "tool_result" }> => e.type === "tool_result") };
}


let divergences: PolicyDivergence[] = [];
let restore: () => void = () => undefined;
beforeEach(() => {
	vi.clearAllMocks();
	divergences = [];
	restore = setPolicyShadowSink((d) => divergences.push(d));
});
afterEach(() => restore());

describe("política v3 em sombra no v2", () => {
	it("subagente autônomo com escrita de conector: o v2 expõe e executa como antes; a sombra loga a divergência sem args", async () => {
		const { call, results, requests } = await runOrigin({
			origin: "subagent",
			autonomy: autonomous,
			script: [toolCall("w1", WRITE, { cliente: "Acme Segredo" }), say("feito")],
		});
		// decisão real inalterada: a escrita estava no catálogo e rodou
		expect(requests[0]!.toolNames).toContain(WRITE);
		expect(call).toHaveBeenCalledTimes(1);
		expect(results[0]?.ok).toBe(true);
		// a política (pai desconhecido = sem humano) esconderia a escrita
		const catalog = divergences.find((d) => d.stage === "catalog" && d.tool === WRITE);
		expect(catalog).toMatchObject({ event: "policy_shadow_divergence", origin: "subagent", current: "visible", next: "hidden" });
		const exec = divergences.find((d) => d.stage === "execute" && d.tool === WRITE);
		expect(exec).toMatchObject({ origin: "subagent", current: "allow", next: "deny" });
		// log curto: nunca leva args
		expect(JSON.stringify(divergences)).not.toContain("Acme");
		expect(Object.keys(exec!).sort()).toEqual(["current", "event", "next", "origin", "reason", "stage", "tool"]);
	});

	it("rotina: o que o v2 já esconde a política também esconde (sem divergência) e a leitura segue igual", async () => {
		const { call } = await runOrigin({ origin: "routine", autonomy: autonomous, script: [toolCall("r1", READ, { nome: "Acme" }), say("ok")] });
		expect(call).toHaveBeenCalledTimes(1);
		expect(divergences.filter((d) => d.tool === READ || d.tool === WRITE)).toEqual([]);
	});

	it("chat equilibrado: escrita pede cartão nos dois; sem divergência e o cartão continua sendo emitido", async () => {
		const { call, events } = await runOrigin({ origin: "chat", script: [toolCall("w1", WRITE, { cliente: "Acme" })] });
		expect(call).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === "confirm")).toBe(true);
		expect(divergences.filter((d) => d.tool === WRITE)).toEqual([]);
	});

	it("a mesma divergência é logada uma vez só (dedupe) e ATLAS_POLICY_SHADOW=0 desliga", async () => {
		const input = { origin: "subagent", autonomy: autonomous, script: [say("x")] } as const;
		await runOrigin({ ...input, script: [say("x")] });
		await runOrigin({ ...input, script: [say("x")] });
		expect(divergences.filter((d) => d.tool === WRITE && d.stage === "catalog")).toHaveLength(1);
		const before = divergences.length;
		process.env.ATLAS_POLICY_SHADOW = "0";
		try {
			restore();
			restore = setPolicyShadowSink((d) => divergences.push(d));
			await runOrigin({ ...input, script: [say("x")] });
			expect(divergences.length).toBe(before);
		} finally {
			delete process.env.ATLAS_POLICY_SHADOW;
		}
	});

	it("o catálogo devolve as mesmas tools com a sombra ligada ou desligada", () => {
		const build = () =>
			buildEngineV2Catalog({
				origin: "routine",
				userId: "user-1",
				sandboxEnabled: false,
				autonomy: balanced,
				mcp: { toolset: buildMcpToolset([erp], { autonomy: balanced }), call: vi.fn() } as unknown as McpRuntime,
				apiConnector: false,
				attachments: { present: false },
				allowProfileUpdate: false,
				hasImageAttachments: false,
				routerMessages: [],
				lastUserMessage: "oi",
			}).tools.map((tool) => tool.function.name);
		const on = build();
		process.env.ATLAS_POLICY_SHADOW = "0";
		try {
			expect(build()).toEqual(on);
		} finally {
			delete process.env.ATLAS_POLICY_SHADOW;
		}
	});
});
