import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getMcpCatalogEntry } from "@workspace/shared";
import { callMcpTool, isUncertainOutcome } from "./call.js";
import { McpClientPool, type McpClientConfig } from "./client-pool.js";
import { firecrawlErrorHint, githubErrorHint, withMcpErrorHint } from "./hints.js";
import { shouldRetryMcpFailure } from "./retry.js";
import { buildMcpClientConfig } from "./runtime.js";

type Reply = { isError?: boolean; text: string; delayMs?: number };

/** Servidor em memória que responde `replies` em ordem (a última repete) e conta as chamadas. */
function scriptedPool(replies: Reply[]): { pool: McpClientPool; calls: () => number } {
	let calls = 0;
	const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
	server.setRequestHandler(CallToolRequestSchema, async () => {
		const reply = replies[Math.min(calls, replies.length - 1)]!;
		calls += 1;
		if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
		return { ...(reply.isError ? { isError: true } : {}), content: [{ type: "text" as const, text: reply.text }] };
	});
	const pool = new McpClientPool(() => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		void server.connect(serverTransport);
		return clientTransport;
	});
	return { pool, calls: () => calls };
}

const config: McpClientConfig = { id: "c1", version: "v1", name: "Fake", url: "http://fake.local/mcp" };
const run = (pool: McpClientPool, extra: Partial<Parameters<typeof callMcpTool>[0]> = {}) =>
	callMcpTool({ pool, config, toolName: "t", args: {}, retryDelayMs: 0, readOnly: true, ...extra });

describe("shouldRetryMcpFailure", () => {
	it("repete erro transitório", () => {
		for (const text of [
			"Request timed out",
			"service temporarily unavailable",
			"read ECONNRESET",
			"HTTP 502 Bad Gateway",
			"rate limit exceeded",
		]) {
			expect(shouldRetryMcpFailure({ text })).toBe(true);
		}
	});

	it("erro determinístico ou sem padrão transitório não repete", () => {
		expect(shouldRetryMcpFailure({ text: "All scraping engines failed" })).toBe(false);
		expect(shouldRetryMcpFailure({ text: "tool desconhecida" })).toBe(false);
		expect(shouldRetryMcpFailure({ text: "algo quebrou" })).toBe(false);
	});

	it("nunca repete login, 404, não encontrado ou validação", () => {
		expect(shouldRetryMcpFailure({ text: "HTTP 401: invalid credentials" })).toBe(false);
		expect(shouldRetryMcpFailure({ text: "invalid_token" })).toBe(false);
		expect(shouldRetryMcpFailure({ text: "404 Not Found" })).toBe(false);
		expect(shouldRetryMcpFailure({ text: "path does not point to a file" })).toBe(false);
		expect(shouldRetryMcpFailure({ text: "Validation failed: title is required" })).toBe(false);
	});
});

describe("callMcpTool: retry", () => {
	it("isError transitório: 1 retry e sucesso", async () => {
		const { pool, calls } = scriptedPool([{ isError: true, text: "upstream 503" }, { text: "ok" }]);
		const result = await run(pool);
		expect(result).toEqual({ ok: true, text: "ok", truncated: false });
		expect(calls()).toBe(2);
		await pool.closeAll();
	});

	it("falha de novo: para depois de 1 retry", async () => {
		const { pool, calls } = scriptedPool([{ isError: true, text: "upstream 503" }]);
		const result = await run(pool);
		expect(result.ok).toBe(false);
		expect(result.text).toBe("upstream 503");
		expect(calls()).toBe(2);
		await pool.closeAll();
	});

	it("isError sem padrão transitório (scraping engines, tool desconhecida) roda 1 vez", async () => {
		for (const text of ["All scraping engines failed", "tool desconhecida"]) {
			const { pool, calls } = scriptedPool([{ isError: true, text }]);
			const result = await run(pool);
			expect(result.ok).toBe(false);
			expect(calls()).toBe(1);
			await pool.closeAll();
		}
	});

	it("auth e 404 não são repetidos", async () => {
		const auth = scriptedPool([{ isError: true, text: "HTTP 401 invalid_token" }]);
		await run(auth.pool);
		expect(auth.calls()).toBe(1);
		const notFound = scriptedPool([{ isError: true, text: "404 Not Found" }]);
		await run(notFound.pool);
		expect(notFound.calls()).toBe(1);
		await auth.pool.closeAll();
		await notFound.pool.closeAll();
	});
});

describe("callMcpTool: timeout por conector", () => {
	it("usa callTimeoutMs do config (e timeoutMs explícito ganha)", async () => {
		const slow = scriptedPool([{ text: "lento", delayMs: 150 }]);
		const short = await run(slow.pool, { config: { ...config, callTimeoutMs: 40 } });
		expect(short.ok).toBe(false);
		expect(short.text.toLowerCase()).toContain("timed out");
		const long = await run(slow.pool, { config: { ...config, callTimeoutMs: 2_000 } });
		expect(long.ok).toBe(true);
		const overridden = await run(slow.pool, { config: { ...config, callTimeoutMs: 2_000 }, timeoutMs: 40 });
		expect(overridden.ok).toBe(false);
		await slow.pool.closeAll();
	});

	it("buildMcpClientConfig leva o timeout do catálogo; custom fica sem", () => {
		expect(getMcpCatalogEntry("firecrawl")?.callTimeoutMs).toBe(90_000);
		const base = {
			id: "x",
			updatedAt: "v1",
			name: "X",
			url: "https://x.test/mcp",
			authType: "api_key",
			secretsEnc: null,
		};
		const firecrawl = buildMcpClientConfig({ ...base, catalogId: "firecrawl" } as never, {});
		expect(firecrawl.callTimeoutMs).toBe(90_000);
		expect(firecrawl.catalogId).toBe("firecrawl");
		const custom = buildMcpClientConfig({ ...base, catalogId: null } as never, {});
		expect(custom.callTimeoutMs).toBeUndefined();
		expect(custom.catalogId).toBeUndefined();
	});
});

describe("dicas de erro", () => {
	it("Firecrawl: engines falharam", () => {
		const text = "Error: All scraping engines failed!";
		expect(firecrawlErrorHint({ toolName: "firecrawl_scrape", args: {}, text })).toBe(
			"Tente web_extract ou o navegador para esta URL.",
		);
		expect(firecrawlErrorHint({ toolName: "firecrawl_scrape", args: {}, text: "outro erro" })).toBeNull();
	});

	it("GitHub: caminho inexistente cita o ref", () => {
		const hint = githubErrorHint({
			toolName: "get_file_contents",
			args: { ref: "refs/heads/dev" },
			text: "path does not point to a file or directory",
		});
		expect(hint).toBe(
			"O caminho não existe no ref `refs/heads/dev`. Liste a pasta pai com o **mesmo ref** antes (a estrutura pode ser diferente entre branches), ou use `search_code`.",
		);
		expect(
			githubErrorHint({ toolName: "get_file_contents", args: {}, text: "path does not point to x" }),
		).toContain("`informado`");
	});

	it("GitHub: search_commits sem texto", () => {
		expect(
			githubErrorHint({ toolName: "search_commits", args: {}, text: "Search text is required" }),
		).toBe("search_commits exige texto de busca; para listar commits recentes use `list_commits` (com `since`/`sha`).");
		expect(githubErrorHint({ toolName: "list_commits", args: {}, text: "Search text is required" })).toBeNull();
	});

	it("withMcpErrorHint só age no conector certo", () => {
		const input = { toolName: "firecrawl_scrape", args: {}, text: "All scraping engines failed" };
		expect(withMcpErrorHint("firecrawl", input)).toBe(`${input.text}\nTente web_extract ou o navegador para esta URL.`);
		expect(withMcpErrorHint(undefined, input)).toBe(input.text);
		expect(withMcpErrorHint("github", input)).toBe(input.text);
	});

	it("callMcpTool anexa a dica ao erro final", async () => {
		const { pool } = scriptedPool([{ isError: true, text: "All scraping engines failed" }]);
		const result = await run(pool, { config: { ...config, catalogId: "firecrawl" } });
		expect(result.ok).toBe(false);
		expect(result.text).toBe("All scraping engines failed\nTente web_extract ou o navegador para esta URL.");
		await pool.closeAll();
	});
});

describe("callMcpTool: escrita não é retentada (R1)", () => {
	it("isError transitório em escrita roda 1 vez, mesmo com dica de idempotência", async () => {
		const { pool, calls } = scriptedPool([{ isError: true, text: "upstream 503" }, { text: "ok" }]);
		const result = await run(pool, { readOnly: false });
		expect(result.ok).toBe(false);
		expect(calls()).toBe(1);
		await pool.closeAll();
	});

	it("timeout em escrita não repete e avisa que o efeito é incerto", async () => {
		const { pool, calls } = scriptedPool([{ text: "lento", delayMs: 150 }]);
		const result = await run(pool, { readOnly: false, config: { ...config, callTimeoutMs: 40 } });
		expect(result.ok).toBe(false);
		expect(result.text.toLowerCase()).toContain("timed out");
		expect(result.text).toContain("may or may not have been applied");
		expect(result.text).toContain("Check the current state");
		// Dá tempo de um retry indevido aparecer: o servidor só pode ter visto 1 chamada.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(calls()).toBe(1);
		await pool.closeAll();
	});

	it("omitir readOnly conta como escrita (padrão seguro)", async () => {
		const { pool, calls } = scriptedPool([{ isError: true, text: "upstream 503" }, { text: "ok" }]);
		await callMcpTool({ pool, config, toolName: "t", args: {}, retryDelayMs: 0 });
		expect(calls()).toBe(1);
		await pool.closeAll();
	});

	it("erro determinístico de escrita não ganha o aviso de incerteza", async () => {
		const { pool } = scriptedPool([{ isError: true, text: "title is required" }]);
		const result = await run(pool, { readOnly: false });
		expect(result.text).not.toContain("may or may not");
		await pool.closeAll();
	});

	it("erro de negócio com número (500, 512) é falha simples; 5xx com prefixo e timeout são incertos", async () => {
		const outcome = async (text: string) => {
			const { pool } = scriptedPool([{ isError: true, text }]);
			const result = await run(pool, { readOnly: false });
			await pool.closeAll();
			return result;
		};
		for (const text of ["quantidade máxima 500", "produto 512 não existe"]) {
			const result = await outcome(text);
			expect(result.uncertain).toBeUndefined();
			expect(result.text).not.toContain("may or may not");
		}
		for (const text of ["HTTP 502", "status 503", "Error: 500 internal", "504 Gateway Timeout", "socket hang up"]) {
			const result = await outcome(text);
			expect(result.uncertain, text).toBe(true);
		}
	});

	it("leitura segue retentada no timeout/5xx", async () => {
		const { pool, calls } = scriptedPool([{ isError: true, text: "upstream 503" }, { text: "ok" }]);
		expect((await run(pool, { readOnly: true })).ok).toBe(true);
		expect(calls()).toBe(2);
		await pool.closeAll();
	});
});

describe("isUncertainOutcome", () => {
	it.each([
		"HTTP/1.1 503 Service Unavailable",
		"statusCode: 500",
		"Bad Gateway (502)",
		"upstream 503",
		"upstream responded 504",
		"ServerError: 500",
		"request timed out",
		"ECONNRESET",
		"socket hang up",
	])("incerto: %s", (text) => {
		expect(isUncertainOutcome(text)).toBe(true);
	});

	it.each([
		"quantidade máxima 500",
		"produto 512 não existe",
		"valor 1.500 acima do limite",
		"ECONNREFUSED 127.0.0.1:443",
		"status inválido, pedido 5000",
	])("falha comum: %s", (text) => {
		expect(isUncertainOutcome(text)).toBe(false);
	});
});
