import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import { parseLoginConnector } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsResult } from "@workspace/llm";
import { runComputerUse } from "./computer-use.js";
import { connectorResumeMessage } from "./tools/propose-connector.js";
import { parseOpenApiDocument } from "@workspace/shared";
import { SPEC_URL, blingLikeSpec } from "./api-connector/fixtures.js";
import type { ApiConnectorRuntime } from "./api-connector/runtime.js";

const connected = vi.hoisted(() => ({ rows: [] as unknown[] }));
const discoverMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	listConnectedApiConnections: vi.fn(async () => connected.rows),
	listMcpConnections: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	searchMemoryEntries: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));
vi.mock("./api-connector/discover.js", async (original) => ({
	...(await original<typeof import("./api-connector/discover.js")>()),
	discoverOpenApiSpec: discoverMock,
}));

const parsed = parseOpenApiDocument(blingLikeSpec, { specUrl: SPEC_URL });
if (!parsed.ok) throw new Error(parsed.error);

beforeEach(() => {
	connected.rows = [];
	discoverMock.mockReset();
	discoverMock.mockResolvedValue({ spec: parsed.spec, specUrl: SPEC_URL, crossHost: false });
});

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): CompleteChatWithToolsResult {
	return {
		model: "fixture",
		finishReason: "tool_calls",
		message: { role: "assistant", content: null, tool_calls: [{ id: `c${(callSeq += 1)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	};
}
const done = (content: string): CompleteChatWithToolsResult => ({ model: "fixture", finishReason: "stop", message: { role: "assistant", content } });

const runtime = (over: Partial<ApiConnectorRuntime> = {}): ApiConnectorRuntime => ({
	connections: [{ id: "conn-1", name: "Bling", slug: "bling", domain: "api.bling.test" }],
	search: vi.fn(async () => "getProdutos GET /produtos - Lista"),
	call: vi.fn(async () => "GET /produtos -> 200\n{}"),
	...over,
});

async function run(input: { text: string; origin?: string; steps: CompleteChatWithToolsResult[]; apiConnector?: ApiConnectorRuntime | null; contextEconomy?: boolean; toolFilter?: (name: string) => boolean }) {
	const events: ComputerUseEvent[] = [];
	const offered: string[][] = [];
	const results: string[] = [];
	let checkpoint: AgentRunCheckpoint | undefined;
	const steps = [...input.steps];
	const error = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: vi.fn(async () => "unused"),
		sandboxEnabled: false,
		apiKey: "fixture",
		model: "fixture",
		runId: "run-a",
		userId: "owner-a",
		conversationId: "conversation-a",
		origin: input.origin ?? "chat",
		contextEconomy: input.contextEconomy ?? false,
		maxSteps: 6,
		autonomy: { level: "autonomous" as const, exceptions: [] },
		messages: [{ role: "user" as const, content: input.text }],
		apiConnector: input.apiConnector,
		toolFilter: input.toolFilter,
		streamChat: async (params: { tools?: ChatTool[] }) => {
			offered.push((params.tools ?? []).map((tool) => tool.function.name));
			return steps.shift() ?? done("fim");
		},
		onEvent: (event: ComputerUseEvent) => {
			events.push(event);
			if (event.type === "tool_result") results.push(event.summary);
		},
		onCheckpoint: async (value: AgentRunCheckpoint) => {
			checkpoint = value;
		},
		onLoginRequired: vi.fn(),
	}).catch((cause: unknown) => cause);
	return { events, offered, results, checkpoint, error, login: events.find((event) => event.type === "login") };
}

describe("propose_api_connection", () => {
	it("chat: aparece, lê a spec e emite o card sem criar nada nem expor segredo", async () => {
		const out = await run({
			text: "conecta nessa API: https://developer.bling.test/openapi.json",
			steps: [call("propose_api_connection", { url: "https://developer.bling.test/openapi.json" })],
		});
		expect(out.offered[0]).toContain("propose_api_connection");
		expect(out.offered[0]).not.toContain("api_call");
		expect(out.error).toMatchObject({ name: "AgentRunPausedError" });
		expect(discoverMock).toHaveBeenCalledWith("https://developer.bling.test/openapi.json");
		const connector = parseLoginConnector((out.login as { connector: unknown }).connector);
		expect(connector).toMatchObject({ kind: "api", name: "Bling API" });
		expect(connector?.api).toMatchObject({ domain: "api.bling.test", authKind: "oauth2", operationCount: 6, readCount: 4 });
		expect(connector?.api?.groups.map((group) => group.tag)).toEqual(["Contatos", "Pedidos - Vendas", "Produtos"]);
		expect(connector?.api?.redirectUrl).toMatch(/\/v1\/mcp\/oauth\/callback$/);
		// O card pausa o run; nenhum campo de segredo existe no evento.
		expect(JSON.stringify(out.events)).not.toMatch(/client_?secret|clientSecret|access_token|refresh_token/i);
	});

	it("recusa URL que não está na fala do próprio usuário (veio de web/tool)", async () => {
		const out = await run({
			text: "conecta a API do Bling pra mim",
			steps: [call("propose_api_connection", { url: "https://evil.test/openapi.json" }), done("preciso do link")],
		});
		expect(out.login).toBeUndefined();
		expect(discoverMock).not.toHaveBeenCalled();
		expect(out.results.join("\n")).toMatch(/must come from the user's own message/);
	});

	it("rotina e subagente não recebem a tool de proposta", async () => {
		const routine = await run({ text: "https://developer.bling.test/openapi.json", origin: "routine", steps: [done("ok")], apiConnector: runtime() });
		expect(routine.offered[0]).not.toContain("propose_api_connection");
		const filtered = await run({ text: "oi", steps: [done("ok")], toolFilter: (name) => name !== "propose_api_connection" });
		expect(filtered.offered[0]).not.toContain("propose_api_connection");
	});

	it("não repete o card nem oferece quando a API já está conectada", async () => {
		connected.rows = [{ id: "conn-1", name: "Bling API", baseUrl: parsed.spec.baseUrl, status: "connected" }];
		const out = await run({
			text: "conecta https://developer.bling.test/openapi.json",
			steps: [call("propose_api_connection", { url: "https://developer.bling.test/openapi.json" }), done("já conectada")],
		});
		expect(out.login).toBeUndefined();
		expect(out.results.join("\n")).toContain("already connected");
	});
});

describe("api_search e api_call no run", () => {
	it("aparecem só com API conectada, em chat e em rotina", async () => {
		const none = await run({ text: "oi", steps: [done("ok")] });
		expect(none.offered[0]).not.toContain("api_call");
		for (const origin of ["chat", "routine"]) {
			const withApi = await run({ text: "oi", origin, steps: [done("ok")], apiConnector: runtime() });
			expect(withApi.offered[0]).toEqual(expect.arrayContaining(["api_search", "api_call"]));
		}
	});

	it("executa pelo runtime injetado e devolve o resultado ao modelo", async () => {
		const api = runtime();
		const out = await run({
			text: "quais produtos tenho no Bling?",
			steps: [call("api_search", { query: "produtos" }), call("api_call", { operationId: "getProdutos", params: { pagina: 1 } }), done("tem produtos")],
			apiConnector: api,
		});
		expect(api.search).toHaveBeenCalledWith({ query: "produtos" });
		expect(api.call).toHaveBeenCalledWith({ operationId: "getProdutos", params: { pagina: 1 } }, expect.anything());
		expect(out.results.some((text) => text.includes("GET /produtos -> 200"))).toBe(true);
	});

	it("falha do runtime vira erro honesto, não sucesso", async () => {
		const api = runtime({ call: vi.fn(async () => { throw new Error("postX is a POST operation. Only read operations (GET/HEAD) are available for now"); }) });
		const out = await run({ text: "cria um pedido no Bling", steps: [call("api_call", { operationId: "postX" }), done("não consegui")], apiConnector: api });
		expect(out.events.some((event) => event.type === "tool_result" && /Only read operations/.test(event.summary) && event.ok === false)).toBe(true);
	});

	it("economia de contexto: as tools da API ficam adiadas e entram quando o pedido cita a API", async () => {
		const quiet = await run({ text: "oi, tudo bem?", steps: [done("ok")], apiConnector: runtime(), contextEconomy: true });
		expect(quiet.offered[0]).not.toContain("api_call");
		expect(quiet.offered[0]).not.toContain("propose_api_connection");
		const named = await run({ text: "me mostra os pedidos do Bling", steps: [done("ok")], apiConnector: runtime(), contextEconomy: true });
		expect(named.offered[0]).toEqual(expect.arrayContaining(["api_search", "api_call"]));
		const linked = await run({ text: "conecta nessa api https://developer.bling.test/openapi.json", steps: [done("ok")], contextEconomy: true });
		expect(linked.offered[0]).toContain("propose_api_connection");
	});
});

describe("retomada", () => {
	it("a mensagem de retomada manda usar api_search e oferece a skill sem criar sozinho", () => {
		const connector = parseLoginConnector({ kind: "api", id: "bling", name: "Bling", api: { specUrl: SPEC_URL, name: "Bling", domain: "api.bling.test", baseUrl: "https://api.bling.test/Api/v3", authKind: "oauth2", operationCount: 1, readCount: 1, groups: [] } })!;
		const message = connectorResumeMessage({ connector });
		expect(message).toContain("api_search");
		expect(message).toContain("propose_skill");
		expect(message).toContain("only if the user agrees");
	});
});
