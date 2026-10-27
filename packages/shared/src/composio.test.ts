import { describe, expect, it } from "vitest";
import { classifyMcpTool, mcpAutonomyMeta } from "./autonomy-tools.js";
import {
	composioNoAuthConnectionId,
	composioNoAuthSlugFromId,
	dropComposioMetaTools,
	dropNativeDuplicateTools,
	isComposioMetaTool,
	isComposioMetaToolkit,
	isComposioReadToolName,
	maskComposioKey,
	parseComposioToolkitsQuery,
	nativeCatalogIdForToolkit,
	parseComposioApiKey,
	parseComposioToolkitSlug,
} from "./composio.js";
import { decideAction } from "./autonomy.js";

const tool = (name: string, annotations?: Record<string, boolean>) => ({
	name,
	inputSchema: { type: "object", properties: {} },
	...(annotations ? { annotations } : {}),
});

describe("classificação de tools do Composio", () => {
	it("verbo de leitura depois do toolkit é leitura", () => {
		for (const name of ["GMAIL_FETCH_EMAILS", "GITHUB_LIST_REPOSITORY_ISSUES", "NOTION_SEARCH_PAGES", "GITHUB_GET_A_REPOSITORY"]) {
			expect(isComposioReadToolName(name)).toBe(true);
		}
	});

	it("tabela: verbo no começo ou no fim, prefixo do toolkit de um ou dois termos", () => {
		const table: Array<[string, boolean]> = [
			["GMAIL_FETCH_EMAILS", true],
			["GITHUB_LIST_REPOSITORY_ISSUES", true],
			["NOTION_SEARCH_PAGES", true],
			["GITHUB_GET_A_REPOSITORY", true],
			["GOOGLECALENDAR_EVENTS_LIST", true],
			["GOOGLE_CALENDAR_LIST_EVENTS", true],
			["GOOGLE_CALENDAR_EVENTS_LIST", true],
			["GOOGLECALENDAR_FIND_EVENT", true],
			["GOOGLECALENDAR_GET_CALENDAR", true],
			["OUTLOOK_LIST_MESSAGES", true],
			["GMAIL_SEND_EMAIL", false],
			["GMAIL_CREATE_DRAFT", false],
			["GOOGLECALENDAR_CREATE_EVENT", false],
			["GOOGLECALENDAR_QUICK_ADD", false],
			["GOOGLECALENDAR_EVENTS_DELETE", false],
			["GOOGLECALENDAR_EVENTS_UPDATE", false],
			["GOOGLE_CALENDAR_DELETE_EVENT", false],
			["GOOGLECALENDAR_LIST_AND_DELETE_EVENTS", false],
			["GMAIL_GET_AND_REPLY", false],
			["GITHUB_CREATE_ISSUE", false],
			["GOOGLECALENDAR_EVENTS", false],
			["FETCH", false],
			["weird", false],
			["", false],
		];
		for (const [name, expected] of table) expect([name, isComposioReadToolName(name)]).toEqual([name, expected]);
	});

	it("o resto é escrita (inclusive nome fora do padrão)", () => {
		for (const name of ["GMAIL_SEND_EMAIL", "GITHUB_CREATE_ISSUE", "FETCH", "weird"]) {
			expect(isComposioReadToolName(name)).toBe(false);
		}
	});

	it("sem anotação: nome decide só quando o conector é o Composio", () => {
		const meta = (catalogId: string | null) =>
			mcpAutonomyMeta({ tool: tool("GMAIL_FETCH_EMAILS"), exposedName: "mcp__composio__GMAIL_FETCH_EMAILS", slug: "composio", catalogId });
		expect(meta("composio").actionClass).toBe("read");
		expect(meta(null).actionClass).toBe("write");
	});

	it("anotação explícita vence a heurística de nome", () => {
		const base = { name: "GMAIL_FETCH_EMAILS", readByName: true };
		expect(classifyMcpTool({ ...base, annotations: { readOnlyHint: false } })).toBe("write");
		expect(classifyMcpTool({ ...base, annotations: { destructiveHint: true } })).toBe("irreversible");
		expect(classifyMcpTool({ name: "GMAIL_CREATE_DRAFT", readByName: true, annotations: { readOnlyHint: true } })).toBe("read");
	});

	it("escrita do Composio pede confirmação no Equilibrado; leitura passa direto", () => {
		const policy = { level: "balanced", exceptions: [] } as const;
		const m = (name: string) => mcpAutonomyMeta({ tool: tool(name), exposedName: `mcp__composio__${name}`, slug: "composio", catalogId: "composio" });
		expect(decideAction(policy, m("GITHUB_LIST_COMMITS"))).toBe("allow");
		expect(decideAction(policy, m("GITHUB_CREATE_ISSUE"))).not.toBe("allow");
		expect(decideAction(policy, m("GMAIL_SEND_EMAIL"))).not.toBe("allow");
	});
});

describe("duplicata com conector nativo", () => {
	it("mapeia toolkits para o catálogo nativo", () => {
		expect(nativeCatalogIdForToolkit("googlecalendar")).toBe("google_calendar");
		expect(nativeCatalogIdForToolkit("GitHub")).toBe("github");
		expect(nativeCatalogIdForToolkit("trello")).toBeNull();
	});

	it("remove só as tools de toolkits com nativo conectado", () => {
		const tools = [tool("GITHUB_LIST_COMMITS"), tool("GMAIL_FETCH_EMAILS"), tool("TRELLO_GET_BOARDS"), tool("GOOGLE_CALENDAR_LIST_EVENTS")];
		const kept = dropNativeDuplicateTools(tools, new Set(["github", "google_calendar"])).map((t) => t.name);
		expect(kept).toEqual(["GMAIL_FETCH_EMAILS", "TRELLO_GET_BOARDS"]);
		expect(dropNativeDuplicateTools(tools, new Set())).toHaveLength(4);
	});
});

describe("validação de entrada", () => {
	it("chave: tamanho e caracteres", () => {
		expect(parseComposioApiKey("  abcd1234efgh  ")).toBe("abcd1234efgh");
		expect(parseComposioApiKey("curta")).toBeNull();
		expect(parseComposioApiKey("tem espaço no meio 123")).toBeNull();
		expect(parseComposioApiKey("a".repeat(201))).toBeNull();
		expect(parseComposioApiKey(42)).toBeNull();
	});

	it("máscara mostra só 4 caracteres", () => {
		expect(maskComposioKey("secretvalue1234")).toBe("••••1234");
	});

	it("slug de toolkit", () => {
		expect(parseComposioToolkitSlug("GitHub")).toBe("github");
		expect(parseComposioToolkitSlug("../x")).toBeNull();
		expect(parseComposioToolkitSlug("")).toBeNull();
	});
});

describe("meta-toolkit e meta-tools do Composio", () => {
	it("composio é meta-toolkit; apps reais e composio_search não são", () => {
		expect(isComposioMetaToolkit("composio")).toBe(true);
		expect(isComposioMetaToolkit(" Composio ")).toBe(true);
		expect(isComposioMetaToolkit("composio_search")).toBe(false);
		expect(isComposioMetaToolkit("github")).toBe(false);
	});

	it("as seis meta-tools saem; tools de apps ficam", () => {
		const names = [
			"COMPOSIO_SEARCH_TOOLS",
			"COMPOSIO_MULTI_EXECUTE_TOOL",
			"COMPOSIO_REMOTE_BASH_TOOL",
			"COMPOSIO_REMOTE_WORKBENCH",
			"COMPOSIO_MANAGE_CONNECTIONS",
			"COMPOSIO_GET_TOOL_SCHEMAS",
		];
		for (const name of names) expect(isComposioMetaTool(name)).toBe(true);
		expect(isComposioMetaTool("composio_search_tools")).toBe(true);
		expect(dropComposioMetaTools([...names, "GMAIL_FETCH_EMAILS", "COMPOSIO_SEARCH_WEB"].map((name) => tool(name))).map((t) => t.name)).toEqual([
			"GMAIL_FETCH_EMAILS",
			"COMPOSIO_SEARCH_WEB",
		]);
	});

	it("webhooks do GitHub são do sistema: criar/editar/apagar/ping saem, listar/ler ficam", () => {
		for (const name of [
			"GITHUB_CREATE_A_REPOSITORY_WEBHOOK",
			"GITHUB_UPDATE_A_REPOSITORY_WEBHOOK",
			"GITHUB_DELETE_A_REPOSITORY_WEBHOOK",
			"GITHUB_PING_A_REPOSITORY_WEBHOOK",
			"GITHUB_CREATE_AN_ORGANIZATION_WEBHOOK",
			"github_create_a_repository_webhook",
		])
			expect(isComposioMetaTool(name)).toBe(true);
		for (const name of ["GITHUB_LIST_REPOSITORY_WEBHOOKS", "GITHUB_GET_A_REPOSITORY_WEBHOOK", "GITHUB_CREATE_AN_ISSUE"])
			expect(isComposioMetaTool(name)).toBe(false);
	});

	it("id de conexão de app sem login ida e volta; id de conta normal não vira slug", () => {
		expect(composioNoAuthConnectionId("exa")).toBe("noauth_exa");
		expect(composioNoAuthSlugFromId("noauth_exa")).toBe("exa");
		expect(composioNoAuthSlugFromId("ca_123")).toBeNull();
		expect(composioNoAuthSlugFromId("noauth_../x")).toBeNull();
	});

	it("parseComposioToolkitsQuery: padrões, limites e entradas inválidas", () => {
		expect(parseComposioToolkitsQuery({})).toEqual({ ok: true, value: { limit: 24, sort: "usage" } });
		expect(
			parseComposioToolkitsQuery({ search: "  git  ", cursor: "abc_DEF-1=", category: "Developer-Tools", limit: "30", sort: "alphabetically" }),
		).toEqual({
			ok: true,
			value: { search: "git", cursor: "abc_DEF-1=", category: "developer-tools", limit: 30, sort: "alphabetically" },
		});
		expect(parseComposioToolkitsQuery({ search: "x".repeat(200) })).toMatchObject({ ok: true, value: { search: "x".repeat(80) } });
		for (const limit of ["0", "51", "1.5", "abc", "-1"]) expect(parseComposioToolkitsQuery({ limit }).ok).toBe(false);
		expect(parseComposioToolkitsQuery({ cursor: "a b" }).ok).toBe(false);
		expect(parseComposioToolkitsQuery({ cursor: "x".repeat(301) }).ok).toBe(false);
		expect(parseComposioToolkitsQuery({ category: "../x" }).ok).toBe(false);
		expect(parseComposioToolkitsQuery({ sort: "random" }).ok).toBe(false);
	});
});
