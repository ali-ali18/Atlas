import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callMcpTool, compactJsonText, MCP_RESULT_MAX_CHARS } from "./call.js";
import { McpClientPool, type McpClientConfig } from "./client-pool.js";
import { clippedResultRefLine, extractResultRef } from "../context/result-store.js";
import { readStoredResult } from "../tools/artifact-read.js";

/** Título de contas a receber no formato verboso do Bling v3 (campos documentados; vários vêm vazios). */
const titulo = (i: number) => ({
	id: 16_000_000_000 + i,
	situacao: 1,
	vencimento: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
	valor: 1000 + i * 3.17,
	idTransacao: "",
	linkQRCodePix: "",
	linkBoleto: "",
	dataEmissao: "2026-08-01",
	contato: { id: 17_000_000_000 + i },
	formaPagamento: { id: 0 },
	portador: { id: 0 },
	categoriaReceitaDespesa: { id: 0 },
	historico: "",
	numeroDocumento: "",
	competencia: null,
	vendedor: { id: null },
	origem: { id: 0, tipoOrigem: "", numero: "", dataEmissao: "", url: "", situacao: null },
	ocorrencia: { tipo: 1, diaVencimento: null, duracao: null, periodicidade: null },
});
const lista = (n: number) => JSON.stringify({ data: Array.from({ length: n }, (_, i) => titulo(i)) }, null, 2);

function poolReplying(text: string): McpClientPool {
	const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
	server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text" as const, text }] }));
	return new McpClientPool(() => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		void server.connect(serverTransport);
		return clientTransport;
	});
}
const config: McpClientConfig = { id: "c1", version: "v1", name: "Fake", url: "http://fake.local/mcp" };

describe("compactJsonText", () => {
	it("minifica e remove null, vazio, [] e {}; mantém 0 e false", () => {
		expect(compactJsonText('{\n "a": null, "b": "", "c": [], "d": {}, "e": {"f": null}, "g": 0, "h": false, "i": [1, null]\n}')).toBe('{"g":0,"h":false,"i":[1,null]}');
	});
	it("texto que não é JSON volta intacto", () => {
		expect(compactJsonText("não é json")).toBe("não é json");
		expect(compactJsonText("{quebrado")).toBe("{quebrado");
	});
	it("mede quantos títulos do Bling cabem no teto antes e depois", () => {
		const fits = (render: (n: number) => string) => {
			let n = 1;
			while (render(n + 1).length <= MCP_RESULT_MAX_CHARS) n += 1;
			return n;
		};
		const before = fits(lista);
		const after = fits((n) => compactJsonText(lista(n)));
		console.log(`titulos que cabem em ${MCP_RESULT_MAX_CHARS} chars: antes=${before} depois=${after}`);
		expect(after).toBeGreaterThan(before * 2);
	});
});

describe("callMcpTool: resultado cortado guarda o inteiro", () => {
	it("compacta antes de cortar e devolve o texto inteiro quando ainda não cabe", async () => {
		const raw = lista(300);
		const result = await callMcpTool({ pool: poolReplying(raw), config, toolName: "listAccountReceivables", args: {}, readOnly: true });
		expect(result.truncated).toBe(true);
		expect(result.fullText).toBe(compactJsonText(raw));
		expect(result.fullText!.length).toBeGreaterThan(MCP_RESULT_MAX_CHARS);
		expect(result.text).not.toContain("\n  ");
	});

	it("resultado que cabe depois de compactar não é cortado", async () => {
		const result = await callMcpTool({ pool: poolReplying(lista(60)), config, toolName: "x", args: {}, readOnly: true });
		expect(result.truncated).toBe(false);
		expect(result.fullText).toBeUndefined();
	});

	it("o restante é legível por artifact_read a partir do offset do aviso", async () => {
		const result = await callMcpTool({ pool: poolReplying(lista(300)), config, toolName: "x", args: {}, readOnly: true });
		const full = result.fullText!;
		const line = clippedResultRefLine("abc123", full.length, MCP_RESULT_MAX_CHARS);
		expect(line).toContain("artifact_read");
		expect(line).toContain('id "abc123"');
		expect(extractResultRef(line)).toMatchObject({ id: "abc123", chars: full.length });
		let offset = MCP_RESULT_MAX_CHARS;
		let rebuilt = full.slice(0, MCP_RESULT_MAX_CHARS);
		const load = async () => ({ kind: "tool_result", runId: "r1", bytes: new TextEncoder().encode(full) });
		while (offset < full.length) {
			const page = await readStoredResult({ id: "abc123", offset }, { userId: "u1", runId: "r1", load });
			const body = page.slice(page.indexOf("\n") + 1);
			rebuilt += body;
			offset += body.length;
		}
		expect(rebuilt).toBe(full);
		expect(JSON.parse(rebuilt).data).toHaveLength(300);
	});
});

describe("callMcpTool: teto configurável", () => {
	it("maxChars maior deixa passar inline o que o padrão cortaria", async () => {
		const raw = lista(120);
		const small = await callMcpTool({ pool: poolReplying(raw), config, toolName: "x", args: {}, readOnly: true });
		const large = await callMcpTool({ pool: poolReplying(raw), config, toolName: "x", args: {}, readOnly: true, maxChars: 100_000 });
		expect(small.truncated).toBe(true);
		expect(large.truncated).toBe(false);
		expect(JSON.parse(large.text).data).toHaveLength(120);
	});
});

describe("aviso de corte autossuficiente", () => {
	it("sem o grupo data carregado, o aviso já manda ler tudo antes de agregar e a linha de referência nomeia artifact_read", async () => {
		const result = await callMcpTool({ pool: poolReplying(lista(300)), config, toolName: "x", args: {}, readOnly: true });
		expect(result.text).toContain("Do not conclude about items not shown");
		expect(result.text).toContain("Never give totals, rankings or conclusions until you have read all of it");
		const line = clippedResultRefLine("id1", 50_000, MCP_RESULT_MAX_CHARS);
		expect(line).toContain("artifact_read");
		expect(line).toContain("offset 20000");
		expect(line).toContain("keep reading until you have all of it before giving totals");
	});
});
