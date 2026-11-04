import { describe, expect, it } from "vitest";
import type { ChatTool } from "@workspace/llm";
import { COMPUTER_USE_TOOLS } from "../tools/catalog.js";
import { swapBrowserTools } from "../tools/browser-v3/index.js";
import { PROPOSE_BOT_TOOL } from "../tools/bot-proposal.js";
import { CREATE_FILE_TOOL } from "../tools/create-file.js";
import { PAGE_TOOLS } from "../tools/pages.js";
import { UPDATE_TASK_LIST_TOOL_V2 } from "../tools/task-list.js";
import { argProblems, firstSentence, rankTools, toolSearchText, type CatalogEntry } from "./bridge.js";
import { BASE_CORE, CORE_SCHEMA_MAX_CHARS, MANIFEST_MAX_CHARS, USAGE_CORE_MAX, VM_CORE, buildManifest, buildV3Catalog, selectCore } from "./catalog.js";

// Como o PREPARE monta: as tools de navegador de hoje viram as 4 do PR6.
const natives: ChatTool[] = swapBrowserTools([...COMPUTER_USE_TOOLS, PROPOSE_BOT_TOOL, CREATE_FILE_TOOL, UPDATE_TASK_LIST_TOOL_V2, ...PAGE_TOOLS]);
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ChatTool => ({
	type: "function",
	function: { name, description, parameters: { type: "object", properties, ...(required.length ? { required } : {}) } },
});
const connector = (slug: string, connectorName: string, name: string, description: string): CatalogEntry => ({
	name: `mcp__${slug}__${name}`,
	tool: tool(`mcp__${slug}__${name}`, `[${connectorName}] ${description}`),
	source: "connector",
	connector: connectorName,
	summary: firstSentence(description),
});
/** 50 conectores com 6 tools cada (nomes que colidem com as nativas: create_bot, create_page, send_message...). */
const fiftyConnectors = (): CatalogEntry[] =>
	Array.from({ length: 50 }, (_, index) => {
		const slug = `svc${index}`;
		const name = `Serviço ${index}`;
		return [
			connector(slug, name, "create_bot", "Create a new bot user in this workspace."),
			connector(slug, name, "create_page", "Create a page in the workspace."),
			connector(slug, name, "list_items", "List items with filters and pagination."),
			connector(slug, name, "get_item", "Get one item by id."),
			connector(slug, name, "send_message", "Send a message to a channel."),
			connector(slug, name, "search", "Search the workspace."),
		];
	}).flat();

const all = () => buildV3Catalog({ natives, connectors: fiftyConnectors(), visible: () => true, vm: true });

describe("motor v3: núcleo", () => {
	it("base + navegador inteiro com VM (D8); sem VM, só a base", () => {
		const withVm = all();
		expect(withVm.core).toEqual([...BASE_CORE, ...VM_CORE]);
		const noVm = buildV3Catalog({ natives, connectors: [], visible: () => true, vm: false });
		expect(noVm.core).toEqual([...BASE_CORE]);
		// A ponte vai no fim do array, depois do núcleo.
		expect(withVm.tools.map((item) => item.function.name).slice(-2)).toEqual(["tool_search", "tool_call"]);
	});

	it("conversa nova: até 5 adiadas mais usadas pelo bot (mín. 3 chamadas), nativa antes de conector no empate", () => {
		const catalog = all();
		const usage = { create_file: 9, current_time: 3, mcp__svc1__list_items: 3, propose_bot: 2, app_info: 3, page_read: 4, page_list: 5, web_search: 50 };
		const core = selectCore({ entries: catalog.entries, vm: false, usage });
		const extras = core.slice(BASE_CORE.length);
		expect(extras).toEqual(["create_file", "page_list", "page_read", "app_info", "current_time"]);
		expect(extras).toHaveLength(USAGE_CORE_MAX);
		expect(extras).not.toContain("propose_bot");
	});

	it("extras por uso só entram enquanto o schema do núcleo cabe no teto", () => {
		const catalog = all();
		const core = selectCore({ entries: catalog.entries, vm: true, usage: { propose_routine: 99, create_file: 50 } });
		const chars = core.reduce((total, name) => total + JSON.stringify(catalog.entries.get(name)!.tool).length, 0);
		expect(chars).toBeLessThanOrEqual(CORE_SCHEMA_MAX_CHARS);
		expect(core).not.toContain("propose_routine"); // ~17 mil caracteres: não cabe
	});

	it("congelado por conversa: o núcleo do run anterior volta igual e o uso não muda nada", () => {
		const first = buildV3Catalog({ natives, connectors: fiftyConnectors(), visible: () => true, vm: true, usage: { create_file: 9 } });
		const next = buildV3Catalog({ natives, connectors: fiftyConnectors(), visible: () => true, vm: true, frozen: first.core, usage: { page_create: 99 } });
		expect(next.core).toEqual(first.core);
		expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
	});

	it("o que a política esconde some do núcleo e do manifesto", () => {
		const catalog = buildV3Catalog({ natives, connectors: fiftyConnectors(), visible: (name) => name !== "memory" && name !== "page_share", vm: false });
		expect(catalog.core).not.toContain("memory");
		expect(catalog.entries.has("page_share")).toBe(false);
		expect(catalog.manifest).not.toMatch(/\bpage_share\b/);
		expect(catalog.manifest).toMatch(/\bpage_create\b/);
	});
});

describe("motor v3: manifesto", () => {
	it("toda tool fora do núcleo aparece pelo nome, nativas primeiro e com uma linha", () => {
		const catalog = buildV3Catalog({ natives, connectors: fiftyConnectors().slice(0, 12), visible: () => true, vm: false });
		for (const name of catalog.deferred) expect(catalog.manifest, name).toContain(name);
		expect(catalog.manifest.indexOf("Built-in:")).toBeLessThan(catalog.manifest.indexOf("Connectors"));
		expect(catalog.manifest).toMatch(/propose_bot \(Propose creating a NEW agent \(bot\) for the user/);
	});

	it("50 conectores: degrada (só nomes, depois conector + 5 nomes) sem passar do teto e sem sumir conector", () => {
		const catalog = all();
		expect(catalog.manifest.length).toBeLessThanOrEqual(MANIFEST_MAX_CHARS);
		for (let index = 0; index < 50; index += 1) expect(catalog.manifest).toContain(`Serviço ${index} (prefix mcp__svc${index}__): create_bot, create_page, list_items, get_item, send_message, search`);
		for (const name of catalog.deferred.filter((item) => !item.startsWith("mcp__"))) expect(catalog.manifest, name).toContain(name);
		const degraded = buildManifest([...catalog.entries.values()].filter((entry) => entry.source === "connector"), {}, 1_000);
		expect(degraded).toMatch(/Serviço 0 \(6 tools, prefix mcp__svc0__\): create_bot, create_page, get_item, list_items, search$/m);
		expect(degraded).toMatch(/find the others with tool_search/);
	});
});

describe("motor v3: tool_search (lexical, sem LLM)", () => {
	it("acha propose_bot à frente de create_bot de 50 conectores (en e pt)", () => {
		const entries = [...all().entries.values()];
		for (const query of ["create a new bot", "criar um novo agente", "novo bot", "propose_bot"]) {
			expect(rankTools(query, entries)[0]?.name, query).toBe("propose_bot");
		}
	});

	it("empate: nativa antes de conector (preferência do sistema como desempate), depois uso do bot", () => {
		const native: CatalogEntry = { name: "notes_list", tool: tool("notes_list", "List notes."), source: "native", summary: "List notes" };
		const external = connector("acme", "Acme", "notes_list", "List notes.");
		expect(rankTools("notes list", [external, native]).map((entry) => entry.name)).toEqual(["notes_list", "mcp__acme__notes_list"]);
		const a = connector("a", "A", "orders_list", "List orders.");
		const b = connector("b", "B", "orders_list", "List orders.");
		expect(rankTools("orders", [a, b], { mcp__b__orders_list: 4 })[0]!.name).toBe("mcp__b__orders_list");
	});

	it("resultado traz a assinatura e a origem; sem nada, diz o que fazer", () => {
		const text = toolSearchText("criar bot", rankTools("criar bot", [...all().entries.values()], {}, 2));
		expect(text).toMatch(/^Tools for "criar bot"/);
		expect(text).toMatch(/propose_bot\(name: string, description: string, snippet\?: string/);
		expect(text).toMatch(/\[built-in\]/);
		expect(toolSearchText("tiktok", [])).toMatch(/No tool matches "tiktok".*not possible/);
	});
});

describe("motor v3: args do tool_call pelo schema", () => {
	const schema = tool("demo", "Demo.", { name: { type: "string" }, count: { type: "integer" }, mode: { type: "string", enum: ["a", "b"] }, tags: { type: "array" } }, ["name"]);
	it("obrigatório, tipo e enum do 1º nível", () => {
		expect(argProblems(schema, { name: "x", count: 2, mode: "a", tags: [] })).toEqual([]);
		expect(argProblems(schema, {})).toEqual(["missing required name"]);
		expect(argProblems(schema, { name: 3, count: 1.5, mode: "z", tags: "x" })).toEqual(["name must be string", "count must be integer", 'mode must be one of "a", "b"', "tags must be array"]);
	});

	it("primeira frase curta, sem o prefixo [Conector]", () => {
		expect(firstSentence("[Bling] Lista pedidos de venda. Use filtros.")).toBe("Lista pedidos de venda");
		expect(firstSentence("x".repeat(80)).length).toBeLessThanOrEqual(60);
	});
});
