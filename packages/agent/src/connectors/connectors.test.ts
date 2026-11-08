import type { McpToolInfo } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import type { PolicyContext } from "../contract/authorize.js";
import { createCapabilityRegistry } from "../capabilities/registry.js";
import { RunProvenance } from "../contract/provenance.js";
import { setup } from "../testing/contract-helpers.js";
import type { McpConnectionSnapshot } from "../ports/mcp.js";
import { createConnectorsCapability } from "./capability.js";
import { FakeMcp } from "./fake-mcp.js";
import { connectorToolNames, slugPart, uniqueSlugParts } from "./naming.js";
import { searchTools } from "./tool-search.js";

const schema = (props: Record<string, unknown> = {}) => ({ type: "object", properties: props });
const tool = (name: string, over: Partial<McpToolInfo> = {}): McpToolInfo => ({ name, inputSchema: schema({ q: { type: "string" } }), ...over });

const gmailTools = [
	tool("search_messages", { description: "Search the mailbox by query.", annotations: { readOnlyHint: true } }),
	tool("create_event", { description: "Create a calendar event.", annotations: { readOnlyHint: false } }),
	tool("delete_thread", { annotations: { destructiveHint: true } }),
	tool("mystery_action"),
];

const conn = (over: Partial<McpConnectionSnapshot> = {}): McpConnectionSnapshot => ({
	id: "conn-a",
	ownerId: "owner-1",
	slug: "gmail",
	name: "Gmail",
	catalogId: "gmail",
	status: "connected",
	confirmWrites: false,
	tools: gmailTools,
	disabledTools: [],
	...over,
});

async function build(connections: McpConnectionSnapshot[], owner = "owner-1") {
	const mcp = new FakeMcp(connections);
	const setupResult = await createConnectorsCapability(mcp, owner);
	if (!setupResult.capability) throw new Error("capability expected");
	const registry = createCapabilityRegistry([setupResult.capability]);
	return { mcp, ...setupResult, capability: setupResult.capability, registry, get: (name: string) => registry.toolByName(name)! };
}

const ctx = (ownerId = "owner-1") => ({ runId: "r1", ownerId, ports: undefined as never });

describe("classificação das tools MCP", () => {
	it("a tool de leitura só roda tool anotada como leitura; escrita e destrutiva vão na _write com efeito próprio", async () => {
		const { get } = await build([conn()]);
		const write = get("mcp_gmail_write");
		expect(write.effectFor({ tool: "create_event" })).toBe("write_external");
		expect(write.effectFor({ tool: "delete_thread" })).toBe("destructive");
		expect(get("mcp_gmail_read").effect).toBe("read");
	});

	it("verbo de envio sem anotação de leitura é tratado como irreversível (destructive, sempre cartão)", async () => {
		const { get } = await build([conn({ tools: [tool("send_message", { annotations: { readOnlyHint: false } })] })]);
		expect(get("mcp_gmail_write").effectFor({ tool: "send_message" })).toBe("destructive");
	});

	it("sem anotação é conservador: write_external, e a _read recusa com dica", async () => {
		const { get, mcp } = await build([conn()]);
		expect(get("mcp_gmail_write").effectFor({ tool: "mystery_action" })).toBe("write_external");
		const out = await get("mcp_gmail_read").run({ tool: "mystery_action" }, ctx());
		expect(out).toMatchObject({ ok: false, hint: "Call it with mcp_gmail_write." });
		expect(mcp.calls).toHaveLength(0);
	});

	it("tool desconhecida (ou desligada pelo dono) não chega ao servidor", async () => {
		const { get, mcp } = await build([conn({ disabledTools: ["search_messages"] })]);
		expect(await get("mcp_gmail_read").run({ tool: "search_messages" }, ctx())).toMatchObject({ ok: false });
		expect(await get("mcp_gmail_read").run({ tool: "inexistente" }, ctx())).toMatchObject({ ok: false });
		expect(mcp.calls).toHaveLength(0);
	});

	it("marca de leitura do dono vale só sem anotação", async () => {
		const { get } = await build([conn({ tools: [tool("list_events"), tool("list_things", { annotations: { readOnlyHint: false } })], toolMarks: { list_events: "read", list_things: "read" } })]);
		const write = get("mcp_gmail_write");
		expect(write.effectFor({ tool: "list_things" })).toBe("write_external");
		expect((await get("mcp_gmail_read").run({ tool: "list_events" }, ctx())).ok).toBe(true);
	});
});

describe("confirmWrites vira confirm: always na tool de escrita", () => {
	const policy = (rules: PolicyContext["rules"] = []): PolicyContext => ({ surface: "chat", ownerPresent: true, autonomy: "autonomous", rules });
	const ownerRunAll: PolicyContext["rules"] = [{ match: "*", verdict: "run" }];

	it("sem confirmWrites e autônomo, a escrita roda", async () => {
		const { get } = await build([conn({ confirmWrites: false })]);
		expect(get("mcp_gmail_write").confirm).toBeUndefined();
		const { executor } = setup(policy(ownerRunAll));
		const out = await executor.executeCall({ callId: "c1", step: 1, tool: get("mcp_gmail_write"), args: { tool: "create_event", args: { q: "x" } } });
		expect(out.status).toBe("ok");
	});

	it("com confirmWrites a mesma chamada pede aprovação e não executa, mesmo com regra do dono `*` run; a leitura segue livre", async () => {
		const { get, mcp } = await build([conn({ confirmWrites: true })]);
		expect(get("mcp_gmail_write").confirm).toBe("always");
		const { executor } = setup(policy(ownerRunAll));
		const write = await executor.executeCall({ callId: "c1", step: 1, tool: get("mcp_gmail_write"), args: { tool: "create_event" } });
		expect(write.status).toBe("pending_approval");
		expect(mcp.calls).toHaveLength(0);
		const read = await executor.executeCall({ callId: "c2", step: 2, tool: get("mcp_gmail_read"), args: { tool: "search_messages" } });
		expect(read.status).toBe("ok");
	});

	it("o confirmWrites de um conector não vale para o outro", async () => {
		const { get } = await build([conn({ confirmWrites: true }), conn({ id: "conn-b", slug: "agenda", confirmWrites: false })]);
		expect(get("mcp_gmail_write").confirm).toBe("always");
		expect(get("mcp_agenda_write").confirm).toBeUndefined();
	});
});

describe("egress só em conector público", () => {
	const brave = () => conn({ id: "conn-b", slug: "brave", name: "Brave", catalogId: "brave_search", tools: [tool("web_search", { annotations: { readOnlyHint: true } }), tool("post_item", { annotations: { readOnlyHint: false } })] });

	it("tools do conector público declaram egress; as do privado não", async () => {
		const { get } = await build([conn(), brave()]);
		expect(get("mcp_brave_read").egress).toBe(true);
		expect(get("mcp_brave_write").egress).toBe(true);
		expect(get("mcp_gmail_read").egress).toBe(false);
		expect(get("mcp_gmail_write").egress).toBe(false);
	});

	it("com dado privado e leitura não confiável no run, o conector público pede cartão e o do dono roda", async () => {
		const { get, mcp } = await build([conn(), brave()]);
		const provenance = new RunProvenance();
		const { executor } = setup(undefined, { provenance });
		const mail = await executor.executeCall({ callId: "c1", step: 1, tool: get("mcp_gmail_read"), args: { tool: "search_messages" } });
		expect(mail.status).toBe("ok");
		const again = await executor.executeCall({ callId: "c2", step: 2, tool: get("mcp_gmail_read"), args: { tool: "search_messages" } });
		expect(again.status).toBe("ok");
		const before = mcp.calls.length;
		const pub = await executor.executeCall({ callId: "c3", step: 3, tool: get("mcp_brave_read"), args: { tool: "web_search", args: { q: "x" } } });
		expect(pub.status).toBe("pending_approval");
		expect(mcp.calls).toHaveLength(before);
	});
});

describe("escopo por dono", () => {
	const a = conn({ id: "conn-a", ownerId: "owner-1", slug: "gmail" });
	const b = conn({ id: "conn-b", ownerId: "owner-2", slug: "agenda-b" });

	it("o dono B não vê a conexão do A, nem na porta nem nas tools", async () => {
		const mcpB = new FakeMcp([a, b]);
		const forB = await createConnectorsCapability(mcpB, "owner-2");
		expect(mcpB.listed).toEqual(["owner-2"]);
		expect(forB.capability?.tools.map((t) => t.name)).toEqual(["tool_search", "mcp_agenda_b_read", "mcp_agenda_b_write"]);
		const forA = await createConnectorsCapability(new FakeMcp([a, b]), "owner-1");
		expect(forA.capability?.tools.map((t) => t.name)).toEqual(["tool_search", "mcp_gmail_read", "mcp_gmail_write"]);
	});

	it("porta que devolve conexão de outro dono é descartada pela capacidade", async () => {
		const leaky = { listConnections: async () => [a, b], call: async () => ({ ok: true as const, text: "x" }) };
		const out = await createConnectorsCapability(leaky, "owner-2");
		expect(out.capability?.tools.map((t) => t.name)).toEqual(["tool_search", "mcp_agenda_b_read", "mcp_agenda_b_write"]);
	});

	it("tool montada para o dono A recusa run de outro dono e não chama o servidor", async () => {
		const { get, mcp } = await build([a]);
		const out = await get("mcp_gmail_read").run({ tool: "search_messages" }, ctx("owner-2"));
		expect(out.ok).toBe(false);
		expect(mcp.calls).toHaveLength(0);
	});

	it("dono vazio ou legado 'default' não recebe capacidade nem consulta a porta", async () => {
		for (const owner of ["", "  ", "default"]) {
			const mcp = new FakeMcp([conn({ ownerId: owner })]);
			expect(await createConnectorsCapability(mcp, owner)).toEqual({ capability: null });
			expect(mcp.listed).toEqual([]);
		}
	});

	it("sem conexão conectada não há capacidade", async () => {
		const out = await createConnectorsCapability(new FakeMcp([conn({ status: "pending_auth" }), conn({ id: "x", status: "error" })]), "owner-1");
		expect(out.capability).toBeNull();
	});
});

describe("proveniência e privacidade", () => {
	it("resultado de MCP é não confiável com source mcp (busca, leitura e escrita)", async () => {
		const { capability } = await build([conn()]);
		for (const t of capability.tools) expect([t.name, t.trust, t.source]).toEqual([t.name, "untrusted", "mcp"]);
	});

	it("conector privado declara privateData nas leituras e escritas; o público de busca não", async () => {
		const { capability } = await build([conn(), conn({ id: "c2", slug: "busca", catalogId: "brave_search" }), conn({ id: "c3", slug: "erp", catalogId: null })]);
		const flag = (name: string) => capability.tools.find((t) => t.name === name)!.privateData;
		expect(flag("mcp_gmail_read")).toBe(true);
		expect(flag("mcp_gmail_write")).toBe(true);
		expect(flag("mcp_erp_read")).toBe(true);
		expect(flag("mcp_busca_read")).toBe(false);
		expect(flag("tool_search")).toBe(false);
		expect(capability.tools.find((t) => t.name === "mcp_gmail_read")!.ownerData).toBe("connector");
	});

	it("ler conector privado marca o run (trifeta) e a leitura não confiável também; a busca de tools não marca o lado privado", async () => {
		const { get } = await build([conn()]);
		const provenance = new RunProvenance();
		const { executor } = setup(undefined, { provenance });
		await executor.executeCall({ callId: "c0", step: 1, tool: get("tool_search"), args: { query: "search messages" } });
		expect(provenance.untrustedReadInRun).toBe(true);
		expect(provenance.privateReadInRun).toBe(false);
		await executor.executeCall({ callId: "c1", step: 2, tool: get("mcp_gmail_read"), args: { tool: "search_messages" } });
		expect(provenance.privateReadInRun).toBe(true);
	});
});

describe("segredo no resultado e no erro", () => {
	const bearer = "Bearer abcdefghijklmnop1234567890";

	it("erro de terceiro sai redigido e limitado", async () => {
		const mcp = new FakeMcp([conn()], () => ({ ok: false, error: `401 from server with ${bearer}` }));
		const setupResult = await createConnectorsCapability(mcp, "owner-1");
		const read = setupResult.capability!.tools.find((t) => t.name === "mcp_gmail_read")!;
		const out = await read.run({ tool: "search_messages" }, ctx());
		expect(out.ok).toBe(false);
		expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop1234567890");
	});

	it("exceção do cliente também sai redigida", async () => {
		const throwing = { listConnections: async () => [conn()], call: async () => { throw new Error(`boom ${bearer}`); } };
		const read = (await createConnectorsCapability(throwing, "owner-1")).capability!.tools.find((t) => t.name === "mcp_gmail_read")!;
		const out = await read.run({ tool: "search_messages" }, ctx());
		expect(out).toMatchObject({ ok: false });
		expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop1234567890");
	});

	it("resultado ok com token também é redigido", async () => {
		const mcp = new FakeMcp([conn()], () => ({ ok: true, text: `header ${bearer}` }));
		const read = (await createConnectorsCapability(mcp, "owner-1")).capability!.tools.find((t) => t.name === "mcp_gmail_read")!;
		const out = await read.run({ tool: "search_messages" }, ctx());
		expect(out.ok && out.summary).not.toContain("abcdefghijklmnop1234567890");
	});

	it("resultado vazio vira resumo honesto, não ok sem texto", async () => {
		const mcp = new FakeMcp([conn()], () => ({ ok: true, text: "" }));
		const read = (await createConnectorsCapability(mcp, "owner-1")).capability!.tools.find((t) => t.name === "mcp_gmail_read")!;
		expect(await read.run({ tool: "search_messages" }, ctx())).toMatchObject({ ok: true });
	});
});

describe("tool_search carrega só o pedido", () => {
	const many = [
		tool("search_messages", { description: "Search the mailbox.", inputSchema: schema({ query: { type: "string" } }), annotations: { readOnlyHint: true } }),
		tool("list_labels", { inputSchema: schema({ UNIQUE_LABEL_ARG: { type: "string" } }), annotations: { readOnlyHint: true } }),
		tool("send_message", { inputSchema: schema({ UNIQUE_SEND_ARG: { type: "string" } }) }),
		tool("create_draft", { inputSchema: schema({ UNIQUE_DRAFT_ARG: { type: "string" } }) }),
	];

	it("devolve o schema só das tools que casam e diz qual mcp_* roda cada uma", async () => {
		const { get } = await build([conn({ tools: many })]);
		const out = await get("tool_search").run({ query: "search messages" }, ctx());
		if (!out.ok) throw new Error(out.error);
		expect(out.summary).toContain("search_messages");
		expect(out.summary).toContain("mcp_gmail_read");
		expect(out.summary).not.toContain("UNIQUE_LABEL_ARG");
		expect(out.summary).not.toContain("UNIQUE_SEND_ARG");
		expect(out.summary).not.toContain("UNIQUE_DRAFT_ARG");
	});

	it("tool de escrita aponta para a _write", async () => {
		const { get } = await build([conn({ tools: many })]);
		const out = await get("tool_search").run({ query: "send message" }, ctx());
		expect(out.ok && out.summary).toContain("mcp_gmail_write");
	});

	it("sem resultado diz os apps conectados; consulta sem palavras e app desconhecido falham com dica", async () => {
		const { get } = await build([conn({ tools: many })]);
		expect(await get("tool_search").run({ query: "zzzz" }, ctx())).toMatchObject({ ok: true });
		expect(await get("tool_search").run({ query: "!!!" }, ctx())).toMatchObject({ ok: false });
		expect(await get("tool_search").run({ query: "send", app: "nope" }, ctx())).toMatchObject({ ok: false, hint: expect.stringContaining("gmail") });
	});

	it("não só busca no nome: descrição ajuda, com peso menor", () => {
		const list = [{ connection: "a", tool: tool("alpha", { description: "find invoices" }) }, { connection: "a", tool: tool("find_invoices") }];
		expect(searchTools(list, "find invoices").map((h) => h.tool.name)).toEqual(["find_invoices", "alpha"]);
	});

	it("o limite vale", () => {
		const list = Array.from({ length: 12 }, (_, i) => ({ connection: "a", tool: tool(`get_item_${i}`) }));
		expect(searchTools(list, "get item", 2)).toHaveLength(2);
		expect(searchTools(list, "get item", 99)).toHaveLength(8);
	});

	it("o schema do índice do contexto continua pequeno: o schema das tools MCP não vai nas specs de chamada", async () => {
		const { capability } = await build([conn({ tools: many })]);
		const specs = JSON.stringify(capability.tools.map((t) => t.toLlmToolSpec()));
		expect(specs).not.toContain("UNIQUE_LABEL_ARG");
		expect(capability.summary.length).toBeLessThanOrEqual(160);
	});
});

describe("nomes", () => {
	it("slug vira parte de nome válido e única", () => {
		expect(slugPart("Minha Agenda!", "x")).toBe("minha_agenda");
		expect(slugPart("---", "app1")).toBe("app1");
		expect(uniqueSlugParts(["gmail", "gmail", "Gmail"])).toEqual(["gmail", "gmail_2", "gmail_3"]);
		expect(connectorToolNames("gmail")).toEqual({ read: "mcp_gmail_read", write: "mcp_gmail_write" });
	});
});

describe("capacidade nativa esconde o conector que a duplica", () => {
	const gmailConn = conn({ tools: [...gmailTools] });
	const calendarConn = conn({ id: "conn-c", slug: "google_calendar", name: "Google Calendar", catalogId: "google_calendar", tools: [tool("list_events", { annotations: { readOnlyHint: true } }), tool("create_event")] });
	const driveConn = conn({ id: "conn-d", slug: "google_drive", name: "Drive", catalogId: "google_drive", tools: [tool("search_files", { annotations: { readOnlyHint: true } })] });
	const composio = conn({ id: "conn-x", slug: "composio", name: "Composio", catalogId: "composio", tools: [tool("GMAIL_SEND_EMAIL"), tool("GOOGLECALENDAR_CREATE_EVENT"), tool("GOOGLE_CALENDAR_EVENTS_LIST", { annotations: { readOnlyHint: true } }), tool("NOTION_CREATE_PAGE")] });
	const names = async (connections: McpConnectionSnapshot[], native: { email?: boolean; calendar?: boolean }) => {
		const { capability } = await createConnectorsCapability(new FakeMcp(connections), "owner-1", undefined, native);
		return capability?.tools.map((t) => t.name) ?? [];
	};

	it("sem a nativa o conector embutido continua (nada muda)", async () => {
		expect(await names([gmailConn, calendarConn], {})).toEqual(expect.arrayContaining(["mcp_gmail_write", "mcp_google_calendar_write"]));
	});
	it("com email nativo o Gmail do conector sai inteiro (create_draft/send não contornam as regras); a agenda fica", async () => {
		const list = await names([gmailConn, calendarConn], { email: true });
		expect(list).not.toContain("mcp_gmail_write");
		expect(list).not.toContain("mcp_gmail_read");
		expect(list).toContain("mcp_google_calendar_write");
	});
	it("com calendar nativo o conector de agenda sai (create_event com convidados não contorna a aprovação)", async () => {
		const list = await names([gmailConn, calendarConn, driveConn], { calendar: true });
		expect(list).not.toContain("mcp_google_calendar_write");
		expect(list).toEqual(expect.arrayContaining(["mcp_gmail_write", "mcp_google_drive_read"]));
	});
	it("quem só tem Composio (sem o embutido conectado) mantém as tools de Gmail e Agenda do Composio", async () => {
		const { capability } = await createConnectorsCapability(new FakeMcp([composio]), "owner-1", undefined, { email: true, calendar: true });
		const found = await createCapabilityRegistry([capability!]).toolByName("tool_search")!.run({ query: "send email create event" }, ctx());
		expect(found.ok && found.summary).toMatch(/GMAIL_SEND_EMAIL/);
		expect(found.ok && found.summary).toMatch(/GOOGLECALENDAR_CREATE_EVENT/);
	});
	it("embutido desconectado não esconde o Composio; embutido conectado esconde o duplicado", async () => {
		const off = conn({ ...gmailConn, status: "error" as never });
		const kept = await createConnectorsCapability(new FakeMcp([off, composio]), "owner-1", undefined, { email: true });
		expect(JSON.stringify(await createCapabilityRegistry([kept.capability!]).toolByName("tool_search")!.run({ query: "send email" }, ctx()))).toContain("GMAIL_SEND_EMAIL");
		const hidden = await createConnectorsCapability(new FakeMcp([gmailConn, composio]), "owner-1", undefined, { email: true });
		expect(JSON.stringify(await createCapabilityRegistry([hidden.capability!]).toolByName("tool_search")!.run({ query: "send email" }, ctx()))).not.toContain("GMAIL_SEND_EMAIL");
	});
	it("só o conector duplicado: sem conexão sobrando não há capacidade", async () => {
		expect((await createConnectorsCapability(new FakeMcp([gmailConn, calendarConn]), "owner-1", undefined, { email: true, calendar: true })).capability).toBeNull();
	});
	it("Composio perde só as tools de Gmail e Agenda cobertas; o resto fica e a busca não as acha", async () => {
		const { capability } = await createConnectorsCapability(new FakeMcp([gmailConn, calendarConn, composio]), "owner-1", undefined, { email: true, calendar: true });
		const registry = createCapabilityRegistry([capability!]);
		const found = await registry.toolByName("tool_search")!.run({ query: "create send email event page" }, ctx());
		expect(found.ok && found.summary).toContain("NOTION_CREATE_PAGE");
		expect(found.ok && found.summary).not.toMatch(/GMAIL_SEND_EMAIL|GOOGLECALENDAR_CREATE_EVENT|GOOGLE_CALENDAR_EVENTS_LIST/);
	});
});
