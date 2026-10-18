import { describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { normalizeCallToolResult } from "../call.js";
import { base64UrlEncode } from "./google-api.js";
import { classifyMcpTool } from "@workspace/shared";
import { createGoogleMcpServer, type GoogleProduct } from "./google.js";

/**
 * Servidor embutido conectado a um `Client` MCP de verdade via
 * `InMemoryTransport` (mesmo padrão de `mcp.test.ts`): confere o protocolo
 * ponta a ponta, não só as funções internas.
 */
async function connectGoogleClient(
	product: GoogleProduct,
	fetchFn: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>,
	token = "tok-teste-123",
): Promise<Client> {
	const server = createGoogleMcpServer(product, { getAccessToken: async () => token, fetchFn });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	void server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
	return client;
}

function jsonResponse(status: number, body: unknown) {
	return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(status: number, body: string) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			throw new Error("não é JSON");
		},
		text: async () => body,
	};
}

describe("createGoogleMcpServer", () => {
	it("lista as tools de cada produto", async () => {
		const client = await connectGoogleClient("calendar", async () => jsonResponse(200, {}));
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["list_calendars", "list_events", "get_event", "create_event"]);
		expect(tools.find((t) => t.name === "list_events")?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find((t) => t.name === "create_event")?.annotations?.readOnlyHint).toBe(false);
		await client.close();
	});

	it("calendar list_events: Authorization com o token certo e URL/params (singleEvents, orderBy, maxResults)", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchFn = async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return jsonResponse(200, {
				items: [
					{
						id: "ev1",
						summary: "Reunião de time",
						start: { dateTime: "2026-01-01T10:00:00Z" },
						end: { dateTime: "2026-01-01T11:00:00Z" },
					},
				],
			});
		};
		const client = await connectGoogleClient("calendar", fetchFn, "tok-cal-abc");
		const result = await client.callTool({ name: "list_events", arguments: { calendarId: "primary", maxResults: 5 } });

		expect(calls).toHaveLength(1);
		const url = new URL(calls[0].url);
		expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
		expect(url.searchParams.get("singleEvents")).toBe("true");
		expect(url.searchParams.get("orderBy")).toBe("startTime");
		expect(url.searchParams.get("maxResults")).toBe("5");
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-cal-abc");
		expect(normalizeCallToolResult(result).text).toContain("Reunião de time");
		await client.close();
	});

	it("drive read_file: Google Doc pede export em text/plain", async () => {
		const fetchFn = async (url: string) => {
			if (url.includes("fields=id%2Cname%2CmimeType%2Csize") || url.includes("fields=id,name,mimeType,size")) {
				return jsonResponse(200, { id: "doc1", name: "Notas da reunião", mimeType: "application/vnd.google-apps.document" });
			}
			if (url.includes("/export")) {
				const exportUrl = new URL(url);
				expect(exportUrl.searchParams.get("mimeType")).toBe("text/plain");
				return textResponse(200, "conteúdo do documento exportado");
			}
			throw new Error(`URL inesperada: ${url}`);
		};
		const client = await connectGoogleClient("drive", fetchFn);
		const result = await client.callTool({ name: "read_file", arguments: { fileId: "doc1" } });
		const { text } = normalizeCallToolResult(result);
		expect(text).toContain("Notas da reunião");
		expect(text).toContain("conteúdo do documento exportado");
		await client.close();
	});

	it("gmail read_message: decodifica o corpo text/plain em base64url", async () => {
		const bodyText = "Olá, tudo bem? Segue o relatório em anexo.";
		const fetchFn = async () =>
			jsonResponse(200, {
				id: "m1",
				threadId: "t1",
				snippet: "Olá, tudo bem?",
				payload: {
					mimeType: "text/plain",
					body: { data: base64UrlEncode(bodyText) },
					headers: [
						{ name: "From", value: "remetente@example.com" },
						{ name: "To", value: "destinatario@example.com" },
						{ name: "Subject", value: "Relatório" },
						{ name: "Date", value: "Thu, 1 Jan 2026 10:00:00 -0300" },
					],
				},
			});
		const client = await connectGoogleClient("gmail", fetchFn);
		const result = await client.callTool({ name: "read_message", arguments: { messageId: "m1" } });
		const { text } = normalizeCallToolResult(result);
		expect(text).toContain(bodyText);
		expect(text).toContain("remetente@example.com");
		await client.close();
	});

	it("sheets append_rows: POST com valueInputOption=USER_ENTERED e as linhas no corpo", async () => {
		let seenUrl = "";
		let seenBody: unknown;
		const fetchFn = async (url: string, init?: RequestInit) => {
			seenUrl = url;
			seenBody = JSON.parse(String(init?.body));
			return jsonResponse(200, { updates: { updatedRange: "Página1!A2:B3", updatedRows: 2 } });
		};
		const client = await connectGoogleClient("sheets", fetchFn);
		const result = await client.callTool({
			name: "append_rows",
			arguments: { spreadsheetId: "sp1", range: "Página1!A:B", rows: [["a", "b"], ["c", "d"]] },
		});
		expect(seenUrl).toContain(":append?valueInputOption=USER_ENTERED");
		expect(seenBody).toEqual({ values: [["a", "b"], ["c", "d"]] });
		expect(normalizeCallToolResult(result).text).toContain("Página1!A2:B3");
		await client.close();
	});

	it("sheets lista as tools de leitura e as de escrita (readOnlyHint false)", async () => {
		const client = await connectGoogleClient("sheets", async () => jsonResponse(200, {}));
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual([
			"get_spreadsheet", "read_range", "append_rows", "create_spreadsheet", "update_range", "add_sheet",
		]);
		for (const name of ["create_spreadsheet", "update_range", "add_sheet"]) {
			expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(false);
		}
		await client.close();
	});

	it("sheets create_spreadsheet: POST com título e abas, grava o cabeçalho e devolve id e link", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchFn = async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return jsonResponse(200, init?.method === "PUT" ? { updatedCells: 2 } : { spreadsheetId: "sp-novo" });
		};
		const client = await connectGoogleClient("sheets", fetchFn);
		const result = await client.callTool({
			name: "create_spreadsheet",
			arguments: { title: "Preços do MacBook", sheets: ["Histórico", "Alertas"], header: ["Data", "Preço"] },
		});
		expect(calls[0]?.url).toBe("https://sheets.googleapis.com/v4/spreadsheets");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			properties: { title: "Preços do MacBook" },
			sheets: [{ properties: { title: "Histórico" } }, { properties: { title: "Alertas" } }],
		});
		expect(calls[1]?.init?.method).toBe("PUT");
		expect(calls[1]?.url).toBe(
			`https://sheets.googleapis.com/v4/spreadsheets/sp-novo/values/${encodeURIComponent("'Histórico'!A1")}?valueInputOption=USER_ENTERED`,
		);
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ values: [["Data", "Preço"]] });
		const { ok, text } = normalizeCallToolResult(result);
		expect(ok).toBe(true);
		expect(text).toContain("sp-novo");
		expect(text).toContain("https://docs.google.com/spreadsheets/d/sp-novo/edit");
		await client.close();
	});

	it("sheets create_spreadsheet: só o título não manda abas nem grava cabeçalho", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchFn = async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return jsonResponse(200, { spreadsheetId: "sp2" });
		};
		const client = await connectGoogleClient("sheets", fetchFn);
		await client.callTool({ name: "create_spreadsheet", arguments: { title: "Vazia" } });
		expect(calls).toHaveLength(1);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ properties: { title: "Vazia" } });
		const invalid = await client.callTool({ name: "create_spreadsheet", arguments: {} });
		expect(normalizeCallToolResult(invalid).ok).toBe(false);
		await client.close();
	});

	it("sheets update_range: PUT com USER_ENTERED e os valores no corpo", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const fetchFn = async (url: string, init?: RequestInit) => {
			seenUrl = url;
			seenInit = init;
			return jsonResponse(200, { updatedRange: "Página1!A1:B2", updatedCells: 4 });
		};
		const client = await connectGoogleClient("sheets", fetchFn);
		const result = await client.callTool({
			name: "update_range",
			arguments: { spreadsheetId: "sp1", range: "Página1!A1:B2", values: [["a", "b"], [1, "d"]] },
		});
		expect(seenInit?.method).toBe("PUT");
		expect(seenUrl).toBe(
			`https://sheets.googleapis.com/v4/spreadsheets/sp1/values/${encodeURIComponent("Página1!A1:B2")}?valueInputOption=USER_ENTERED`,
		);
		expect(JSON.parse(String(seenInit?.body))).toEqual({ values: [["a", "b"], ["1", "d"]] });
		expect(normalizeCallToolResult(result).text).toContain("Página1!A1:B2");
		await client.close();
	});

	it("sheets add_sheet: POST :batchUpdate com addSheet", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const fetchFn = async (url: string, init?: RequestInit) => {
			seenUrl = url;
			seenInit = init;
			return jsonResponse(200, { replies: [{ addSheet: { properties: { sheetId: 7, title: "Maio" } } }] });
		};
		const client = await connectGoogleClient("sheets", fetchFn);
		const result = await client.callTool({ name: "add_sheet", arguments: { spreadsheetId: "sp1", title: "Maio" } });
		expect(seenInit?.method).toBe("POST");
		expect(seenUrl).toBe("https://sheets.googleapis.com/v4/spreadsheets/sp1:batchUpdate");
		expect(JSON.parse(String(seenInit?.body))).toEqual({ requests: [{ addSheet: { properties: { title: "Maio" } } }] });
		expect(normalizeCallToolResult(result).text).toContain("Maio");
		await client.close();
	});

	it("403 de permissão de arquivo vira mensagem acionável (isError, sem UnauthorizedError)", async () => {
		const fetchFn = async () => jsonResponse(403, { error: { message: "The caller does not have permission" } });
		const client = await connectGoogleClient("sheets", fetchFn);
		const normalized = normalizeCallToolResult(await client.callTool({ name: "read_range", arguments: { spreadsheetId: "x", range: "A1" } }));
		expect(normalized.ok).toBe(false);
		expect(normalized.text).toContain("create_spreadsheet");
		expect(normalized.text).toContain("outra conta");
		await client.close();
	});

	it("404 da Agenda aponta o calendarId; 404 de planilha é genérico", async () => {
		const fetchFn = async () => jsonResponse(404, { error: { message: "Not Found" } });
		const calendar = await connectGoogleClient("calendar", fetchFn);
		const events = normalizeCallToolResult(await calendar.callTool({ name: "list_events", arguments: { calendarId: "inexistente" } }));
		expect(events.text).toContain("calendarId inválido");
		await calendar.close();
		const sheets = await connectGoogleClient("sheets", fetchFn);
		const sheet = normalizeCallToolResult(await sheets.callTool({ name: "get_spreadsheet", arguments: { spreadsheetId: "x" } }));
		expect(sheet.text).toContain("não encontrado");
		expect(sheet.text).not.toContain("calendarId");
		await sheets.close();
	});

	it("erro HTTP != 401/403 vira isError com o status e a mensagem do Google, sem derrubar a conexão", async () => {
		const fetchFn = async () => jsonResponse(500, { error: { message: "internal" } });
		const client = await connectGoogleClient("calendar", fetchFn);
		const result = await client.callTool({ name: "list_calendars", arguments: {} });
		const normalized = normalizeCallToolResult(result);
		expect(normalized.ok).toBe(false);
		expect(normalized.text).toContain("500");
		await client.close();
	});

	it("401 da API do Google atravessa o protocolo com \"401\" na mensagem (authFailed no runtime)", async () => {
		const fetchFn = async () => jsonResponse(401, { error: { message: "invalid_token" } });
		const client = await connectGoogleClient("calendar", fetchFn);
		await expect(client.callTool({ name: "list_calendars", arguments: {} })).rejects.toThrow(/401/);
		await client.close();
	});

	it("tool desconhecida vira isError, não derruba o servidor", async () => {
		const client = await connectGoogleClient("calendar", async () => jsonResponse(200, {}));
		const result = await client.callTool({ name: "tool_que_nao_existe", arguments: {} });
		expect(normalizeCallToolResult(result).ok).toBe(false);
		await client.close();
	});

	it("getAccessToken falhando (token expirado sem refresh) vira erro de protocolo com 401", async () => {
		const server = createGoogleMcpServer("gmail", {
			getAccessToken: async () => {
				throw new UnauthorizedError("token expirado sem refresh_token");
			},
			fetchFn: vi.fn(async () => jsonResponse(200, {})),
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		void server.connect(serverTransport);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		await expect(client.callTool({ name: "search_messages", arguments: { query: "is:unread" } })).rejects.toThrow();
		await client.close();
	});
});

describe("annotations das tools Google (autonomia F10)", () => {
	it("leitura = read; criar/atualizar/rascunho = write; nada é irreversível", async () => {
		const WRITES = new Set(["create_event", "create_draft", "create_spreadsheet", "update_range", "add_sheet", "append_rows"]);
		const products: GoogleProduct[] = ["calendar", "drive", "gmail", "sheets"];
		let writesSeen = 0;
		for (const product of products) {
			const client = await connectGoogleClient(product, async () => jsonResponse(200, {}));
			const { tools } = await client.listTools();
			for (const tool of tools) {
				const actionClass = classifyMcpTool({ name: tool.name, annotations: tool.annotations });
				if (WRITES.has(tool.name)) {
					writesSeen += 1;
					expect(actionClass, tool.name).toBe("write");
					expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
				} else {
					expect(actionClass, tool.name).toBe("read");
				}
			}
			await client.close();
		}
		expect(writesSeen).toBe(WRITES.size);
	});
});
