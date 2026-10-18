import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import type { McpConnectionRecord } from "@workspace/db";
import type { SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import { COMPUTER_USE_TOOLS, runComputerUse } from "./computer-use.js";
import { buildMcpToolset } from "./mcp/registry.js";
import {
	PROPOSE_CONNECTOR_TOOL,
	noConnectorHint,
	proposeConnector,
	type ProposeConnectorDeps,
} from "./tools/propose-connector.js";
import { COMPUTER_REF_TOOLS } from "./tools/computer-refs.js";
import { parseRuntimeCheckpoint } from "./checkpoint.js";

const connectionsByUser = vi.hoisted(() => new Map<string, unknown[]>());

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	listMcpConnections: vi.fn(async (userId: string) => connectionsByUser.get(userId) ?? []),
	getBotProfile: vi.fn(async () => null),
	searchMemoryEntries: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));
// Sem rede: o Composio e o cofre são simulados.
vi.mock("./mcp/secret-box.js", async (original) => ({
	...(await original<typeof import("./mcp/secret-box.js")>()),
	openSecrets: vi.fn(() => ({ apiKey: "fixture-key" })),
}));
vi.mock("./mcp/composio/client.js", async (original) => ({
	...(await original<typeof import("./mcp/composio/client.js")>()),
	createComposioClient: vi.fn(() => ({
		listToolkits: async (input: { search?: string }) => ({
			items: /linear/i.test(input.search ?? "")
				? [{ slug: "linear", name: "Linear", description: "Issues e projetos", logo: "https://logos.composio.dev/linear.png", noAuth: false }]
				: /exa/i.test(input.search ?? "")
					? [{ slug: "exa", name: "Exa", description: "Busca na web", logo: null, noAuth: true }]
					: [],
			nextCursor: null,
		}),
	})),
}));

function record(patch: Partial<McpConnectionRecord>): McpConnectionRecord {
	return {
		id: "conn-1",
		catalogId: null,
		slug: "x",
		name: "X",
		url: "https://x.test",
		authType: "oauth",
		status: "connected",
		tools: [],
		disabledTools: [],
		confirmWrites: false,
		lastError: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		secretsEnc: null,
		oauthStateHash: null,
		...patch,
	};
}

const composioConfigured = record({ id: "composio-a", catalogId: "composio", status: "pending_auth", secretsEnc: "ciphertext-fixture" });
const githubTool = { name: "list_issues", inputSchema: { type: "object" as const, properties: {} } };

beforeEach(() => connectionsByUser.clear());

function call(name: string, args: Record<string, unknown>, id = "c1"): CompleteChatWithToolsResult {
	return {
		model: "fixture",
		finishReason: "tool_calls",
		message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
	};
}
const done = (content: string): CompleteChatWithToolsResult => ({ model: "fixture", finishReason: "stop", message: { role: "assistant", content } });

const baseParams = (userId = "owner-a") => ({
	manager: {} as SandboxManager,
	getSessionId: vi.fn(async () => "unused"),
	sandboxEnabled: false,
	apiKey: "fixture",
	model: "fixture",
	runId: "run-a",
	userId,
	conversationId: "conversation-a",
	origin: "chat",
	contextEconomy: false,
	maxSteps: 6,
	autonomy: { level: "autonomous" as const, exceptions: [] },
	messages: [{ role: "user" as const, content: "Mostre minhas issues do app" }],
});

/** Roda até a pausa e devolve o cartão emitido e o checkpoint gravado. */
async function runUntilPause(input: ReturnType<typeof baseParams>, steps: CompleteChatWithToolsResult[], extra: Record<string, unknown> = {}) {
	const events: ComputerUseEvent[] = [];
	const toolResults: string[] = [];
	let checkpoint: AgentRunCheckpoint | undefined;
	const paused = vi.fn();
	const error = await runComputerUse({
		...input,
		...extra,
		streamChat: async () => steps.shift() ?? done("fim"),
		onEvent: (event) => {
			events.push(event);
			if (event.type === "tool_result") toolResults.push(event.summary);
		},
		onCheckpoint: async (value) => {
			checkpoint = value;
		},
		onLoginRequired: paused,
	}).catch((cause: unknown) => cause);
	return { events, checkpoint, paused, error, toolResults, login: events.find((event) => event.type === "login") };
}

describe("propose_connector: replay 'minhas issues do <app>' sem conexão", () => {
	it("a tool aparece no chat e substitui request_composio_login", () => {
		expect(COMPUTER_USE_TOOLS.some((tool) => tool.function.name === "propose_connector")).toBe(true);
		expect(COMPUTER_USE_TOOLS.some((tool) => tool.function.name === "request_composio_login")).toBe(false);
	});

	it("conector nativo não conectado: card com ícone, nome e descrição, pausa e retoma", async () => {
		const input = baseParams();
		const { login, checkpoint, paused, error, events } = await runUntilPause(input, [call("propose_connector", { app: "github" })]);
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(paused).toHaveBeenCalledOnce();
		expect(input.getSessionId).not.toHaveBeenCalled();
		expect(login).toMatchObject({
			status: "pending",
			site: "GitHub",
			connector: { kind: "native", id: "github", name: "GitHub", icon: "/connectors/github.svg" },
		});
		const connector = (login as { connector: { description: string; reconnect?: boolean } }).connector;
		expect(connector.description.length).toBeGreaterThan(5);
		expect(connector.reconnect).toBeUndefined();
		expect(JSON.stringify(events)).not.toContain("ciphertext-fixture");
		const pending = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.pendingLogin;
		expect(pending?.connector).toMatchObject({ kind: "native", id: "github" });

		// Retomada: o modelo recebe o aviso de conexão, sem VM.
		const seen: string[] = [];
		await runComputerUse({
			...baseParams(),
			restoredCheckpoint: checkpoint,
			streamChat: async (request) => {
				seen.push(JSON.stringify(request.messages));
				return done("Pronto.");
			},
			onEvent: () => undefined,
		});
		expect(seen.join("")).toContain("[connector-login-complete] The user connected GitHub");
		expect(seen.join("")).not.toContain("Your next action must be browser_snapshot");
	});

	it("app do Composio sem login: o card leva noAuth para ativar sem popup", async () => {
		connectionsByUser.set("owner-a", [composioConfigured]);
		const { login, error } = await runUntilPause(baseParams(), [call("propose_connector", { app: "Exa" })]);
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(login).toMatchObject({
			composioToolkit: "exa",
			connector: { kind: "composio", id: "exa", name: "Exa", noAuth: true },
		});
	});

	it("app do Composio: card com logo real, nome e descrição do toolkit", async () => {
		connectionsByUser.set("owner-a", [composioConfigured]);
		const { login, checkpoint, paused, error } = await runUntilPause(baseParams(), [call("propose_connector", { app: "Linear" })]);
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(paused).toHaveBeenCalledOnce();
		expect(login).toMatchObject({
			composioToolkit: "linear",
			connector: { kind: "composio", id: "linear", name: "Linear", description: "Issues e projetos", icon: "https://logos.composio.dev/linear.png" },
		});
		expect(parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)))?.pendingLogin?.connector?.icon).toBe("https://logos.composio.dev/linear.png");
		const seen: string[] = [];
		await runComputerUse({
			...baseParams(),
			restoredCheckpoint: checkpoint,
			streamChat: async (request) => {
				seen.push(JSON.stringify(request.messages));
				return done("ok");
			},
			onEvent: () => undefined,
		});
		expect(seen.join("")).toContain("Search its MCP tools");
	});

	it("sem conector nem app no Composio: sem card, orienta o login pelo navegador", async () => {
		connectionsByUser.set("owner-a", [composioConfigured]);
		const { login, toolResults, error } = await runUntilPause(baseParams(), [call("propose_connector", { app: "appdesconhecido" }), done("sigo pelo navegador")]);
		expect(error).not.toMatchObject({ name: "AgentRunPausedError" });
		expect(login).toBeUndefined();
		expect(toolResults.join("\n")).toContain("Use the browser");
	});

	it("Composio não configurado e sem nativo: card oferece configurar o Composio", async () => {
		const { login } = await runUntilPause(baseParams("owner-b"), [call("propose_connector", { app: "linear" })]);
		expect(login).toMatchObject({ composioToolkit: "linear", connector: { kind: "composio", id: "linear", icon: null } });
	});

	it("conector nativo desconectado (erro): card de reconexão", async () => {
		connectionsByUser.set("owner-a", [record({ id: "gh", catalogId: "github", slug: "github", name: "GitHub", status: "error" })]);
		const { login } = await runUntilPause(baseParams(), [call("propose_connector", { app: "GitHub" })]);
		expect(login).toMatchObject({ connector: { kind: "native", id: "github", reconnect: true } });
	});

	it("401 do MCP no meio do run vira card de reconexão e pausa", async () => {
		const toolset = buildMcpToolset(
			[{ id: "gh", name: "GitHub", slug: "github", catalogId: "github", tools: [githubTool], disabledTools: [] }],
			{ autonomy: { level: "autonomous", exceptions: [] } },
		);
		const [toolName] = [...toolset.available.keys()];
		const mcpCall = vi.fn(async () => ({ ok: false, text: "connector disconnected", truncated: false, authFailed: true }));
		const { login, error, toolResults } = await runUntilPause(baseParams(), [call(toolName!, {})], { mcp: { toolset, call: mcpCall } });
		expect(error).toMatchObject({ name: "AgentRunPausedError" });
		expect(login).toMatchObject({ connector: { kind: "native", id: "github", name: "GitHub", reconnect: true } });
		expect(toolResults.join("\n")).toContain("reconnect card for GitHub");
	});

	it("401 num conector personalizado devolve erro com a dica de propose_connector", async () => {
		const toolset = buildMcpToolset(
			[{ id: "c1", name: "Interno", slug: "interno", catalogId: null, tools: [githubTool], disabledTools: [] }],
			{ autonomy: { level: "autonomous", exceptions: [] } },
		);
		const [toolName] = [...toolset.available.keys()];
		const mcpCall = vi.fn(async () => ({ ok: false, text: "connector disconnected", truncated: false, authFailed: true }));
		const { login, toolResults } = await runUntilPause(baseParams(), [call(toolName!, {}), done("ok")], { mcp: { toolset, call: mcpCall } });
		expect(login).toBeUndefined();
		expect(toolResults.join("\n")).toContain('Call propose_connector with app "Interno"');
	});

	it("mcp_tool_search sem tool para o app devolve a dica de propose_connector", async () => {
		const toolset = buildMcpToolset(
			[{ id: "n", name: "Notion", slug: "notion", catalogId: "notion", tools: [githubTool], disabledTools: [] }],
			{ maxTools: 0, autonomy: { level: "autonomous", exceptions: [] } },
		);
		const { toolResults } = await runUntilPause(baseParams(), [call("mcp_tool_search", { query: "issues", connector: "acme" }), done("ok")], {
			mcp: { toolset, call: vi.fn() },
		});
		expect(toolResults.join("\n")).toContain("No connector for acme; call propose_connector.");
	});
});

describe("propose_connector: escopo do dono", () => {
	const deps = (owned: Record<string, McpConnectionRecord[]>): ProposeConnectorDeps & { listed: string[]; opened: string[] } => {
		const listed: string[] = [];
		const opened: string[] = [];
		return {
			listed,
			opened,
			listConnections: async (userId) => {
				listed.push(userId);
				return owned[userId] ?? [];
			},
			searchToolkits: async () => [],
			openApiKey: (secretsEnc) => {
				opened.push(secretsEnc);
				return "k";
			},
		};
	};
	const github = record({ catalogId: "github", tools: [githubTool] });
	const ctxFor = (userId: string) => ({ userId, origin: "chat", runId: "r", loginAsked: new Set<string>() });

	it("B não enxerga o conector nem o Composio de A: recebe o card, não 'já conectado'", async () => {
		const owned = { "owner-a": [github, composioConfigured] };
		const a = deps(owned);
		expect((await proposeConnector({ app: "github" }, ctxFor("owner-a"), a)).loginEvent).toBeUndefined();
		const b = deps(owned);
		const result = await proposeConnector({ app: "github" }, ctxFor("owner-b"), b);
		expect(b.listed).toEqual(["owner-b"]);
		expect(result.loginEvent?.connector).toMatchObject({ kind: "native", id: "github" });
		const composioB = await proposeConnector({ app: "linear" }, ctxFor("owner-b"), b);
		expect(b.opened).toEqual([]);
		expect(composioB.loginEvent?.connector).toMatchObject({ kind: "composio", icon: null });
		expect(JSON.stringify([result, composioB])).not.toContain("ciphertext-fixture");
	});

	it("rotina, subagente e usuário default não pedem card; app inválido falha", async () => {
		for (const context of [
			{ userId: "owner-a", origin: "routine" },
			{ userId: "owner-a", origin: "subagent" },
			{ userId: "default", origin: "chat" },
		]) {
			await expect(proposeConnector({ app: "github" }, { ...context, loginAsked: new Set() }, deps({}))).rejects.toThrow("somente no chat");
		}
		await expect(proposeConnector({ app: "" }, ctxFor("owner-a"), deps({}))).rejects.toThrow("inválido");
		await expect(proposeConnector({ app: "x".repeat(61) }, ctxFor("owner-a"), deps({}))).rejects.toThrow("inválido");
	});

	it("card repetido no mesmo run não cria laço; conectado e desligado não mostram card", async () => {
		const ctx = ctxFor("owner-a");
		const owned = deps({});
		expect((await proposeConnector({ app: "github" }, ctx, owned)).loginEvent).toBeDefined();
		await expect(proposeConnector({ app: "github" }, ctx, owned)).rejects.toThrow("already shown");
		const connected = await proposeConnector({ app: "github" }, ctxFor("owner-a"), deps({ "owner-a": [github] }));
		expect(connected.loginEvent).toBeUndefined();
		expect(connected.summary).toContain("mcp_tool_search");
		const off = await proposeConnector({ app: "github" }, ctxFor("owner-a"), deps({ "owner-a": [record({ catalogId: "github", status: "disabled" })] }));
		expect(off.loginEvent).toBeUndefined();
		expect(off.summary).toContain("turned off");
	});

	it("GitHub já conectado nunca gera card: sem tools em cache e com linha legada desconectada", async () => {
		const noTools = record({ id: "gh", catalogId: "github", slug: "github", name: "GitHub", status: "connected", tools: [] });
		const a = await proposeConnector({ app: "GitHub" }, ctxFor("owner-a"), deps({ "owner-a": [noTools] }));
		expect(a.loginEvent).toBeUndefined();
		expect(a.summary).toContain("already connected");
		// Linha legada (pending_auth) criada antes da conectada: a conectada vence.
		const legacy = record({ id: "gh-old", catalogId: "github", slug: "github", name: "GitHub", status: "pending_auth" });
		const b = await proposeConnector({ app: "github" }, ctxFor("owner-a"), deps({ "owner-a": [legacy, noTools] }));
		expect(b.loginEvent).toBeUndefined();
		expect(b.summary).toContain("already connected");
	});

	it("app já conectado no Composio encaminha à busca MCP", async () => {
		const connected = record({ ...composioConfigured, status: "connected", tools: [{ name: "LINEAR_LIST_ISSUES", inputSchema: { type: "object", properties: {} } }] });
		const result = await proposeConnector({ app: "linear" }, ctxFor("owner-a"), deps({ "owner-a": [connected] }));
		expect(result.loginEvent).toBeUndefined();
		expect(result.summary).toContain("mcp_tool_search");
	});
});

describe("textos que vão ao modelo", () => {
	it("browser_snapshot manda o login pelo card, nunca por texto", () => {
		const snapshot = COMPUTER_REF_TOOLS.find((tool) => tool.function.name === "browser_snapshot");
		expect(snapshot?.function.description).toContain(
			"If the page needs a sign-in, the runtime shows a login card and pauses; never ask for credentials in text.",
		);
	});

	it("propose_connector usa <app> e não um exemplo de nicho", () => {
		const description = PROPOSE_CONNECTOR_TOOL.function.description ?? "";
		expect(description).toContain("<app>");
		expect(description.toLowerCase()).not.toContain("linear");
		expect(PROPOSE_CONNECTOR_TOOL.function.parameters).toMatchObject({ required: ["app"] });
	});

	it("a dica de busca vazia é a frase combinada", () => {
		expect(noConnectorHint("acme")).toBe("No connector for acme; call propose_connector.");
	});
});
