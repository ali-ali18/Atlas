import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeTable, installFakes } from "@workspace/db/testing";
import { formatBriefSourcesBlock } from "@workspace/shared";
import { listBriefSources } from "./daily-brief-sources.js";

/**
 * Fontes do brief "Seu dia": só as conexões do dono (Prisma em memória, o filtro por `userId` é o do código real),
 * categorizadas, com SÓ as tools de leitura.
 */

const USER_A = "user-a";
const USER_B = "user-b";
const NOW = new Date("2026-10-26T10:00:00Z");

const tool = (name: string, readOnlyHint?: boolean) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }) });

function mcpRow(overrides: Record<string, unknown>) {
	return {
		id: `c-${Math.random().toString(36).slice(2, 8)}`,
		userId: USER_A,
		catalogId: null,
		slug: "x",
		name: "X",
		url: "https://example.test/mcp",
		authType: "oauth",
		status: "connected",
		toolsCacheJson: [],
		disabledTools: [],
		confirmWrites: false,
		lastError: null,
		accountLabel: null,
		secretsEnc: null,
		oauthStateHash: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function apiRow(overrides: Record<string, unknown>) {
	return {
		id: `a-${Math.random().toString(36).slice(2, 8)}`,
		userId: USER_A,
		slug: "bling",
		name: "Bling",
		baseUrl: "https://api.bling.test",
		specUrl: "https://api.bling.test/spec.json",
		authKind: "oauth2",
		authJson: {},
		status: "connected",
		lastError: null,
		groupsJson: [],
		allowedTags: [],
		operationCount: 3,
		rateLimitRps: 3,
		accountLabel: null,
		secretsEnc: null,
		oauthStateHash: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

let mcp: FakeTable;
let api: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	mcp = new FakeTable();
	api = new FakeTable();
	installed = installFakes({ mcpConnection: mcp, apiConnection: api });
});
afterEach(() => installed.restore());

describe("listBriefSources", () => {
	it("lista conectores nativos por categoria, só com tools de leitura", async () => {
		mcp.rows.push(
			mcpRow({ catalogId: "gmail", slug: "gmail", name: "Gmail", toolsCacheJson: [tool("search_messages", true), tool("send_message", false), tool("create_draft")] }),
			mcpRow({ catalogId: "google_calendar", slug: "google_calendar", name: "Google Agenda", toolsCacheJson: [tool("list_events", true), tool("create_event", false)] }),
			mcpRow({ catalogId: "google_drive", slug: "google_drive", name: "Google Drive", toolsCacheJson: [tool("list_files", true)] }),
		);
		const sources = await listBriefSources(USER_A);
		expect(sources.map((s) => `${s.category}:${s.name}`)).toEqual(["email:Gmail", "calendar:Google Agenda"]);
		expect(sources[0]!.readTools).toEqual(["mcp__gmail__search_messages"]);
		expect(sources[1]!.readTools).toEqual(["mcp__google_calendar__list_events"]);
		expect(JSON.stringify(sources)).not.toMatch(/send_message|create_draft|create_event|Drive/);
	});

	it("o conector do usuário B nunca aparece para o usuário A (e vice-versa)", async () => {
		mcp.rows.push(
			mcpRow({ userId: USER_A, catalogId: "gmail", slug: "gmail", name: "Gmail A", toolsCacheJson: [tool("search_messages", true)] }),
			mcpRow({ userId: USER_B, catalogId: "slack", slug: "slack", name: "Slack do B", toolsCacheJson: [tool("list_channels", true)] }),
			mcpRow({ userId: USER_B, catalogId: "notion", slug: "notion", name: "Notion do B", status: "pending_auth", lastError: "login expirou: reconecte no Marketplace" }),
		);
		api.rows.push(apiRow({ userId: USER_B, name: "Bling do B" }));
		const forA = await listBriefSources(USER_A);
		expect(forA.map((s) => s.name)).toEqual(["Gmail A"]);
		const block = formatBriefSourcesBlock(forA);
		expect(block).not.toMatch(/Slack do B|Notion do B|Bling do B/);
		const forB = await listBriefSources(USER_B);
		expect(forB.map((s) => s.name).sort()).toEqual(["Bling do B", "Notion do B", "Slack do B"]);
		expect(formatBriefSourcesBlock(forB)).not.toContain("Gmail A");
	});

	it("sem usuário (ou 'default') não lista nada", async () => {
		mcp.rows.push(mcpRow({ userId: "default", catalogId: "gmail", slug: "gmail", name: "Gmail", toolsCacheJson: [tool("search_messages", true)] }));
		expect(await listBriefSources("")).toEqual([]);
		expect(await listBriefSources("default")).toEqual([]);
	});

	it("Composio: uma fonte por toolkit, cada uma na sua categoria, só leitura e sem meta-tools", async () => {
		mcp.rows.push(
			mcpRow({
				catalogId: "composio",
				slug: "composio",
				name: "Composio",
				toolsCacheJson: [
					tool("OUTLOOK_LIST_MESSAGES"),
					tool("OUTLOOK_SEND_EMAIL"),
					tool("LINEAR_LIST_ISSUES"),
					tool("LINEAR_CREATE_ISSUE"),
					tool("SHOPIFY_GET_ORDERS"),
					tool("COMPOSIO_REMOTE_BASH_TOOL"),
				],
			}),
		);
		const sources = await listBriefSources(USER_A);
		expect(sources.map((s) => `${s.category}:${s.name}`)).toEqual(["email:Outlook", "tasks:Linear", "business:Shopify"]);
		expect(sources[0]!.readTools).toEqual(["mcp__composio__OUTLOOK_LIST_MESSAGES"]);
		expect(JSON.stringify(sources)).not.toMatch(/SEND_EMAIL|CREATE_ISSUE|REMOTE_BASH/);
	});

	it("Composio: o app que já existe nativo conectado não aparece duas vezes", async () => {
		mcp.rows.push(
			mcpRow({ catalogId: "gmail", slug: "gmail", name: "Gmail", toolsCacheJson: [tool("search_messages", true)] }),
			mcpRow({ catalogId: "composio", slug: "composio", name: "Composio", toolsCacheJson: [tool("GMAIL_FETCH_EMAILS"), tool("LINEAR_LIST_ISSUES")] }),
		);
		const sources = await listBriefSources(USER_A);
		expect(sources.map((s) => s.name)).toEqual(["Gmail", "Linear"]);
	});

	it("conector de API vira 'negócio'; só leitura (api_search/api_call)", async () => {
		api.rows.push(apiRow({ name: "Bling" }), apiRow({ name: "Parado", status: "disabled" }));
		const sources = await listBriefSources(USER_A);
		expect(sources).toEqual([{ kind: "api", name: "Bling", category: "business", readTools: ["api_search", "api_call"] }]);
	});

	it("login expirado vira needsReconnect (linha 'Reconecte'), e ferramenta desligada não entra", async () => {
		mcp.rows.push(
			mcpRow({ catalogId: "google_calendar", slug: "google_calendar", name: "Google Agenda", status: "pending_auth", lastError: "login expirou: reconecte no Marketplace" }),
			mcpRow({ catalogId: "slack", slug: "slack", name: "Slack", status: "pending_auth", lastError: null }),
			mcpRow({ catalogId: "gmail", slug: "gmail", name: "Gmail", disabledTools: ["search_messages"], toolsCacheJson: [tool("search_messages", true), tool("read_message", true)] }),
		);
		const sources = await listBriefSources(USER_A);
		const gmail = sources.find((s) => s.name === "Gmail");
		expect(gmail?.readTools).toEqual(["mcp__gmail__read_message"]);
		expect(sources.find((s) => s.name === "Google Agenda")).toMatchObject({ needsReconnect: true, category: "calendar", readTools: [] });
		expect(sources.find((s) => s.name === "Slack")).toBeUndefined();
	});
});
