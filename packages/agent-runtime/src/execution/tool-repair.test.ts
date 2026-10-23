import { describe, expect, it } from "vitest";
import { editDistance, repairToolArguments, repairToolName, unresolvedToolHint, type ToolNameCandidate } from "./tool-repair.js";

const read = (name: string): ToolNameCandidate => ({ name, readOnly: true });
const write = (name: string): ToolNameCandidate => ({ name, readOnly: false });

const TOOLS: ToolNameCandidate[] = [
	read("navigate"),
	read("browser_snapshot"),
	read("browser_read"),
	read("browser_find"),
	write("browser_act"),
	read("screenshot"),
	read("web_search"),
	read("web_extract"),
	read("mcp_tool_search"),
	write("create_routine"),
	write("delete_routine"),
	read("list_routines"),
	read("mcp__bling__listProducts"),
	read("mcp__bling__getProduct"),
	write("mcp__bling__createProduct"),
	write("mcp__bling__patchProduct"),
];

describe("repairToolName", () => {
	it("nome exato não é tocado; nome tratado pelo executor também não", () => {
		expect(repairToolName("navigate", TOOLS)).toEqual({ kind: "exact", name: "navigate" });
		expect(repairToolName("browser_click", TOOLS, new Set(["browser_click"]))).toEqual({ kind: "exact", name: "browser_click" });
	});

	it("caixa, hífen, camelCase e prefixo de wrapper", () => {
		expect(repairToolName("Navigate", TOOLS)).toMatchObject({ kind: "repaired", name: "navigate", via: "normalized" });
		expect(repairToolName("browser-snapshot", TOOLS)).toMatchObject({ kind: "repaired", name: "browser_snapshot" });
		expect(repairToolName("BrowserSnapshot", TOOLS)).toMatchObject({ kind: "repaired", name: "browser_snapshot" });
		expect(repairToolName("functions.web_search", TOOLS)).toMatchObject({ kind: "repaired", name: "web_search" });
		expect(repairToolName('navigate" parameter="url"', TOOLS)).toMatchObject({ kind: "repaired", name: "navigate" });
	});

	it("namespace de conector: separador errado, sem `mcp`, sem conector (só leitura)", () => {
		expect(repairToolName("mcp_bling_listProducts", TOOLS)).toMatchObject({ kind: "repaired", name: "mcp__bling__listProducts" });
		expect(repairToolName("bling__listProducts", TOOLS)).toMatchObject({ kind: "repaired", name: "mcp__bling__listProducts", via: "prefix" });
		expect(repairToolName("listProducts", TOOLS)).toMatchObject({ kind: "repaired", name: "mcp__bling__listProducts", via: "prefix" });
		expect(repairToolName("mcp__atlas__navigate", TOOLS)).toMatchObject({ kind: "repaired", name: "navigate", via: "prefix" });
	});

	it("escrita: caixa/separador/conector sim; sem o conector ou por aproximação, nunca", () => {
		expect(repairToolName("MCP__BLING__CREATEPRODUCT", TOOLS)).toMatchObject({ kind: "repaired", name: "mcp__bling__createProduct" });
		expect(repairToolName("bling_createProduct", TOOLS)).toMatchObject({ kind: "repaired", name: "mcp__bling__createProduct" });
		expect(repairToolName("createProduct", TOOLS).kind).toBe("unknown");
		expect(repairToolName("create_routin", TOOLS).kind).toBe("unknown");
		expect(repairToolName("delete_rotine", TOOLS).kind).toBe("unknown");
		expect(repairToolName("browser_actt", TOOLS).kind).toBe("unknown");
	});

	it("apelidos conhecidos só para leitura existente no run", () => {
		expect(repairToolName("browser_navigate", TOOLS)).toMatchObject({ kind: "repaired", name: "navigate", via: "alias" });
		expect(repairToolName("fetch_url", TOOLS)).toMatchObject({ kind: "repaired", name: "web_extract", via: "alias" });
		expect(repairToolName("browser_navigate", [write("navigate")]).kind).toBe("unknown");
		expect(repairToolName("fetch_url", [read("navigate")]).kind).toBe("unknown");
	});

	it("erro de digitação pequeno com alvo único de leitura", () => {
		expect(repairToolName("web_serach", TOOLS)).toMatchObject({ kind: "repaired", name: "web_search", via: "fuzzy" });
		expect(repairToolName("navigat", TOOLS)).toMatchObject({ kind: "repaired", name: "navigate", via: "fuzzy" });
		expect(repairToolName("mcp__bling__listProduct", TOOLS)).toMatchObject({ kind: "repaired", name: "mcp__bling__listProducts", via: "fuzzy" });
	});

	it("empate ou longe demais: não escolhe e devolve até 3 nomes próximos", () => {
		const tie = repairToolName("browser_rea", [read("browser_read"), read("browser_reap")]);
		expect(tie).toMatchObject({ kind: "ambiguous", candidates: ["browser_read", "browser_reap"] });
		expect(unresolvedToolHint(tie)).toContain("matches more than one tool");
		const far = repairToolName("send_whatsapp", TOOLS);
		expect(far.kind).toBe("unknown");
		if (far.kind === "unknown") expect(far.suggestions).toHaveLength(3);
		expect(unresolvedToolHint(far)).toMatch(/^Closest tools: /);
		// nome curto demais não corrige por aproximação
		expect(repairToolName("ab", [read("ac")]).kind).toBe("unknown");
	});

	it("o mesmo nome normalizado em duas tools é ambíguo", () => {
		const repair = repairToolName("list-items", [read("list_items"), read("listItems")]);
		expect(repair.kind).toBe("ambiguous");
	});

	it("sem candidatos não quebra", () => {
		expect(repairToolName("navigate", [])).toEqual({ kind: "unknown", from: "navigate", suggestions: [] });
	});
});

describe("editDistance", () => {
	it("transposição conta 1 e o teto corta cedo", () => {
		expect(editDistance("serach", "search")).toBe(1);
		expect(editDistance("abc", "abc")).toBe(0);
		expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
	});
});

describe("repairToolArguments", () => {
	it("JSON válido passa sem reparo; vazio vira objeto vazio", () => {
		expect(repairToolArguments('{"url":"https://a.com"}')).toEqual({ ok: true, value: { url: "https://a.com" }, repaired: false });
		expect(repairToolArguments("")).toEqual({ ok: true, value: {}, repaired: false });
	});

	it("vírgula sobrando, aspas simples, chave sem aspas, comentário e cerca de markdown", () => {
		expect(repairToolArguments('{"url": "https://a.com",}')).toEqual({ ok: true, value: { url: "https://a.com" }, repaired: true });
		expect(repairToolArguments("{'url': 'https://a.com', 'n': [1, 2,]}")).toEqual({ ok: true, value: { url: "https://a.com", n: [1, 2] }, repaired: true });
		expect(repairToolArguments('{url: "https://a.com", limit: 5, ok: true, x: null}')).toEqual({ ok: true, value: { url: "https://a.com", limit: 5, ok: true, x: null }, repaired: true });
		expect(repairToolArguments('{"a": 1 // nota\n}')).toEqual({ ok: true, value: { a: 1 }, repaired: true });
		expect(repairToolArguments('```json\n{"a": 1}\n```')).toEqual({ ok: true, value: { a: 1 }, repaired: true });
		expect(repairToolArguments("{'texto': 'it\\'s ok'}")).toEqual({ ok: true, value: { texto: "it's ok" }, repaired: true });
	});

	it("objeto JSON embrulhado numa string", () => {
		expect(repairToolArguments(JSON.stringify('{"url":"https://a.com"}'))).toEqual({ ok: true, value: { url: "https://a.com" }, repaired: true });
	});

	it("JSON cortado ou lixo continua erro, com a mensagem do parse estrito", () => {
		const cut = repairToolArguments('{"url": "https://a.com", "text": "abc');
		expect(cut.ok).toBe(false);
		if (!cut.ok) expect(cut.error).toMatch(/JSON|Unterminated|position/i);
		expect(repairToolArguments('{"a": 1').ok).toBe(false);
		expect(repairToolArguments("navigate to google").ok).toBe(false);
		expect(repairToolArguments('{"a": 1} extra').ok).toBe(false);
	});
});
