import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	base64UrlDecode,
	base64UrlEncode,
	capGoogleText,
	errorResult,
	googleJson,
	googleText,
	GoogleApiError,
	mapGoogleApiError,
	textResult,
	type GoogleApiContext,
	type GoogleFetchFn,
} from "./google-api.js";

/**
 * Servidores MCP "embutidos" do Google: os servidores oficiais
 * (`...mcp.googleapis.com`) exigem o Developer Preview Program e recusam
 * conta pessoal @gmail.com. Aqui chamamos a REST API normal do Google
 * (Calendar/Drive/Gmail/Sheets v3-v4) com o access token do usuário — mesmo
 * protocolo MCP (`Server` de baixo nível), sem HTTP real entre client/server
 * (ver `client-pool.ts`, `InMemoryTransport`).
 */

export type GoogleProduct = "calendar" | "drive" | "gmail" | "sheets";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>, ctx: GoogleApiContext) => Promise<ToolResult>;

type ToolDef = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
	/** Apaga ou sobrescreve sem volta (irreversível para a autonomia). */
	destructive?: boolean;
	/** Age sobre terceiros (enviar e-mail, convidar) (irreversível para a autonomia). */
	openWorld?: boolean;
	handler: ToolHandler;
};

/**
 * Annotations MCP das tools embutidas (a autonomia classifica por elas):
 * leitura = readOnlyHint; escrita reversível = criar/atualizar/rascunho, sem
 * destructiveHint e sem efeito para terceiros; `destructive` marca apagar e
 * `openWorld` marca enviar (nenhuma tool atual faz isso: ao adicionar uma,
 * declare aqui em vez de depender do nome).
 */
export function googleToolAnnotations(tool: Pick<ToolDef, "readOnly" | "destructive" | "openWorld">) {
	return {
		readOnlyHint: tool.readOnly,
		destructiveHint: tool.destructive === true,
		openWorldHint: tool.openWorld === true,
	};
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`parâmetro obrigatório: ${field}`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Google Agenda (Calendar API v3)
// ---------------------------------------------------------------------------

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

type CalendarEventTime = { date?: string; dateTime?: string; timeZone?: string };
type CalendarEvent = {
	id: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: CalendarEventTime;
	end?: CalendarEventTime;
	attendees?: { email: string; responseStatus?: string }[];
};

function eventTimeText(time: CalendarEventTime | undefined): string {
	return time?.dateTime ?? time?.date ?? "";
}

/** `"2026-01-01"` → evento de dia inteiro; qualquer outra coisa vira `dateTime` (ISO 8601). */
function toEventDateTime(value: string): CalendarEventTime {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };
}

function formatEventLine(ev: CalendarEvent): string {
	const loc = ev.location ? ` @ ${ev.location}` : "";
	return `${ev.id}\t${eventTimeText(ev.start)} → ${eventTimeText(ev.end)}\t${ev.summary ?? "(sem título)"}${loc}`;
}

function formatEventDetail(ev: CalendarEvent): string {
	const lines = [
		`id: ${ev.id}`,
		`título: ${ev.summary ?? "(sem título)"}`,
		`início: ${eventTimeText(ev.start)}`,
		`fim: ${eventTimeText(ev.end)}`,
	];
	if (ev.location) lines.push(`local: ${ev.location}`);
	if (ev.description) lines.push(`descrição: ${ev.description}`);
	if (ev.attendees?.length) {
		lines.push(`participantes: ${ev.attendees.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`).join(", ")}`);
	}
	return lines.join("\n");
}

const CALENDAR_TOOLS: ToolDef[] = [
	{
		name: "list_calendars",
		description: "Lista as agendas do Google Agenda do usuário (id, nome e se é a principal).",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: async (_args, ctx) => {
			const data = await googleJson<{ items?: { id: string; summary?: string; primary?: boolean; accessRole?: string }[] }>(
				ctx,
				`${CALENDAR_API}/users/me/calendarList?maxResults=250`,
			);
			const items = data.items ?? [];
			if (items.length === 0) return textResult("(nenhuma agenda encontrada)");
			return textResult(
				items.map((cal) => `${cal.id}\t${cal.summary ?? ""}${cal.primary ? " (principal)" : ""}\t${cal.accessRole ?? ""}`).join("\n"),
			);
		},
	},
	{
		name: "list_events",
		description: "Lista eventos de uma agenda num intervalo de tempo (padrão: agora até 7 dias à frente).",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "string", description: 'ID da agenda (padrão: "primary")' },
				timeMin: { type: "string", description: "Início do intervalo, ISO 8601 (padrão: agora)" },
				timeMax: { type: "string", description: "Fim do intervalo, ISO 8601 (padrão: agora + 7 dias)" },
				q: { type: "string", description: "Busca livre em título, descrição e local" },
				maxResults: { type: "number", description: "Máximo de eventos (até 50, padrão 20)" },
			},
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const calendarId = optionalString(args.calendarId) ?? "primary";
			const now = Date.now();
			const timeMin = optionalString(args.timeMin) ?? new Date(now).toISOString();
			const timeMax = optionalString(args.timeMax) ?? new Date(now + 7 * 86_400_000).toISOString();
			const maxResults = clampInt(args.maxResults, 20, 1, 50);
			const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
			url.searchParams.set("timeMin", timeMin);
			url.searchParams.set("timeMax", timeMax);
			url.searchParams.set("singleEvents", "true");
			url.searchParams.set("orderBy", "startTime");
			url.searchParams.set("maxResults", String(maxResults));
			const q = optionalString(args.q);
			if (q) url.searchParams.set("q", q);
			const data = await googleJson<{ items?: CalendarEvent[] }>(ctx, url.toString());
			const items = data.items ?? [];
			if (items.length === 0) return textResult("(nenhum evento no período)");
			return textResult(capGoogleText(items.map(formatEventLine).join("\n")));
		},
	},
	{
		name: "get_event",
		description: "Detalhes de um evento específico (horário, local, descrição, participantes).",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "string", description: 'ID da agenda (padrão: "primary")' },
				eventId: { type: "string", description: "ID do evento" },
			},
			required: ["eventId"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const calendarId = optionalString(args.calendarId) ?? "primary";
			const eventId = requireString(args.eventId, "eventId");
			const data = await googleJson<CalendarEvent>(
				ctx,
				`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			);
			return textResult(formatEventDetail(data));
		},
	},
	{
		name: "create_event",
		description: "Cria um evento novo numa agenda.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "string", description: 'ID da agenda (padrão: "primary")' },
				summary: { type: "string", description: "Título do evento" },
				start: { type: "string", description: "Início: ISO 8601 (com hora) ou AAAA-MM-DD (dia inteiro)" },
				end: { type: "string", description: "Fim: ISO 8601 (com hora) ou AAAA-MM-DD (dia inteiro)" },
				description: { type: "string", description: "Descrição/notas do evento" },
				location: { type: "string", description: "Local do evento" },
				attendees: { type: "array", items: { type: "string" }, description: "E-mails dos participantes" },
			},
			required: ["summary", "start", "end"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const calendarId = optionalString(args.calendarId) ?? "primary";
			const summary = requireString(args.summary, "summary");
			const start = requireString(args.start, "start");
			const end = requireString(args.end, "end");
			const body: Record<string, unknown> = {
				summary,
				start: toEventDateTime(start),
				end: toEventDateTime(end),
			};
			const description = optionalString(args.description);
			if (description) body.description = description;
			const location = optionalString(args.location);
			if (location) body.location = location;
			if (Array.isArray(args.attendees)) {
				const attendees = args.attendees.filter((email): email is string => typeof email === "string" && !!email.trim());
				if (attendees.length > 0) body.attendees = attendees.map((email) => ({ email }));
			}
			const data = await googleJson<CalendarEvent>(ctx, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return textResult(`Evento criado: ${data.id}\n${formatEventDetail(data)}`);
		},
	},
];

// ---------------------------------------------------------------------------
// Google Drive (Drive API v3)
// ---------------------------------------------------------------------------

const DRIVE_API = "https://www.googleapis.com/drive/v3";

type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; size?: string };

/** Mimetypes nativos do Google Workspace que precisam de export (não têm bytes próprios). */
const GOOGLE_EXPORT_MIME: Record<string, string> = {
	"application/vnd.google-apps.document": "text/plain",
	"application/vnd.google-apps.spreadsheet": "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
};

function escapeDriveQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function formatFileList(files: DriveFile[]): string {
	if (files.length === 0) return "(nenhum arquivo encontrado)";
	return files.map((f) => `${f.id}\t${f.name}\t${f.mimeType}\t${f.modifiedTime ?? ""}`).join("\n");
}

const DRIVE_TOOLS: ToolDef[] = [
	{
		name: "search_files",
		description: "Busca arquivos no Drive por texto (conteúdo ou nome), com filtro opcional de tipo.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Texto buscado no conteúdo ou no nome do arquivo" },
				mimeType: { type: "string", description: "Filtra por tipo MIME exato (ex.: application/vnd.google-apps.document)" },
				pageSize: { type: "number", description: "Máximo de resultados (até 50, padrão 20)" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const query = requireString(args.query, "query");
			const esc = escapeDriveQueryValue(query);
			let q = `(fullText contains '${esc}' or name contains '${esc}') and trashed = false`;
			const mimeType = optionalString(args.mimeType);
			if (mimeType) q += ` and mimeType = '${escapeDriveQueryValue(mimeType)}'`;
			const url = new URL(`${DRIVE_API}/files`);
			url.searchParams.set("q", q);
			url.searchParams.set("pageSize", String(clampInt(args.pageSize, 20, 1, 50)));
			url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size)");
			const data = await googleJson<{ files?: DriveFile[] }>(ctx, url.toString());
			return textResult(formatFileList(data.files ?? []));
		},
	},
	{
		name: "list_recent_files",
		description: "Lista os arquivos mais recentemente modificados no Drive.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { pageSize: { type: "number", description: "Máximo de resultados (até 50, padrão 20)" } },
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const url = new URL(`${DRIVE_API}/files`);
			url.searchParams.set("q", "trashed = false");
			url.searchParams.set("orderBy", "modifiedTime desc");
			url.searchParams.set("pageSize", String(clampInt(args.pageSize, 20, 1, 50)));
			url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size)");
			const data = await googleJson<{ files?: DriveFile[] }>(ctx, url.toString());
			return textResult(formatFileList(data.files ?? []));
		},
	},
	{
		name: "read_file",
		description: "Lê o conteúdo de um arquivo do Drive como texto (Docs/Sheets/Slides são exportados; binários só devolvem metadados).",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { fileId: { type: "string", description: "ID do arquivo no Drive" } },
			required: ["fileId"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const fileId = requireString(args.fileId, "fileId");
			const meta = await googleJson<{ id: string; name: string; mimeType: string; size?: string }>(
				ctx,
				`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
			);
			const exportMime = GOOGLE_EXPORT_MIME[meta.mimeType];
			if (exportMime) {
				const text = await googleText(
					ctx,
					`${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`,
				);
				return textResult(`${meta.name} (${meta.mimeType})\n\n${capGoogleText(text)}`);
			}
			if (meta.mimeType.startsWith("text/") || meta.mimeType === "application/json") {
				const text = await googleText(ctx, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
				return textResult(`${meta.name} (${meta.mimeType})\n\n${capGoogleText(text)}`);
			}
			return textResult(
				`${meta.name} — arquivo binário (${meta.mimeType}${meta.size ? `, ${meta.size} bytes` : ""}): conteúdo não pode ser lido como texto, só os metadados acima.`,
			);
		},
	},
];

// ---------------------------------------------------------------------------
// Gmail (Gmail API v1)
// ---------------------------------------------------------------------------

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

type GmailHeader = { name: string; value: string };
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id: string; threadId: string; snippet?: string; payload?: GmailPart & { headers?: GmailHeader[] } };

function headerMap(headers: GmailHeader[] | undefined): Map<string, string> {
	const map = new Map<string, string>();
	for (const header of headers ?? []) map.set(header.name.toLowerCase(), header.value);
	return map;
}

function findGmailPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
	if (!part) return undefined;
	if (part.mimeType === mimeType && part.body?.data) return part;
	for (const child of part.parts ?? []) {
		const found = findGmailPart(child, mimeType);
		if (found) return found;
	}
	return undefined;
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractGmailBody(payload: GmailPart | undefined): string {
	const plain = findGmailPart(payload, "text/plain");
	if (plain?.body?.data) return base64UrlDecode(plain.body.data);
	const html = findGmailPart(payload, "text/html");
	if (html?.body?.data) return stripHtml(base64UrlDecode(html.body.data));
	if (payload?.body?.data) return base64UrlDecode(payload.body.data);
	return "(sem corpo de texto)";
}

/** RFC 2047: cabeçalho com acentos precisa ir codificado (senão quebra o parser de e-mail). */
function encodeMimeHeader(value: string): string {
	// eslint-disable-next-line no-control-regex -- intencional: detecta qualquer caractere fora de ASCII.
	if (/^[\x00-\x7F]*$/.test(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const GMAIL_TOOLS: ToolDef[] = [
	{
		name: "search_messages",
		description: "Busca mensagens no Gmail (sintaxe de busca do Gmail, ex.: \"from:fulano is:unread\").",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Consulta no formato de busca do Gmail" },
				maxResults: { type: "number", description: "Máximo de mensagens (até 25, padrão 10)" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const query = requireString(args.query, "query");
			const maxResults = clampInt(args.maxResults, 10, 1, 25);
			const listUrl = new URL(`${GMAIL_API}/messages`);
			listUrl.searchParams.set("q", query);
			listUrl.searchParams.set("maxResults", String(maxResults));
			const list = await googleJson<{ messages?: { id: string; threadId: string }[] }>(ctx, listUrl.toString());
			const refs = list.messages ?? [];
			if (refs.length === 0) return textResult("(nenhuma mensagem encontrada)");
			const messages = await Promise.all(
				refs.map((ref) => {
					const msgUrl = new URL(`${GMAIL_API}/messages/${ref.id}`);
					msgUrl.searchParams.set("format", "metadata");
					msgUrl.searchParams.append("metadataHeaders", "From");
					msgUrl.searchParams.append("metadataHeaders", "Subject");
					msgUrl.searchParams.append("metadataHeaders", "Date");
					return googleJson<GmailMessage>(ctx, msgUrl.toString());
				}),
			);
			const lines = messages.map((msg) => {
				const headers = headerMap(msg.payload?.headers);
				return [
					`id: ${msg.id}`,
					`threadId: ${msg.threadId}`,
					`de: ${headers.get("from") ?? ""}`,
					`assunto: ${headers.get("subject") ?? ""}`,
					`data: ${headers.get("date") ?? ""}`,
					`resumo: ${msg.snippet ?? ""}`,
				].join("\n");
			});
			return textResult(capGoogleText(lines.join("\n\n")));
		},
	},
	{
		name: "read_message",
		description: "Lê uma mensagem completa do Gmail (cabeçalhos + corpo em texto).",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { messageId: { type: "string", description: "ID da mensagem" } },
			required: ["messageId"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const messageId = requireString(args.messageId, "messageId");
			const msg = await googleJson<GmailMessage>(ctx, `${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`);
			const headers = headerMap(msg.payload?.headers);
			const body = extractGmailBody(msg.payload);
			const lines = [
				`De: ${headers.get("from") ?? ""}`,
				`Para: ${headers.get("to") ?? ""}`,
				`Assunto: ${headers.get("subject") ?? ""}`,
				`Data: ${headers.get("date") ?? ""}`,
				"",
				body,
			];
			return textResult(capGoogleText(lines.join("\n")));
		},
	},
	{
		name: "create_draft",
		description: "Cria um rascunho de e-mail no Gmail (não envia).",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Destinatário(s), separados por vírgula" },
				subject: { type: "string", description: "Assunto" },
				body: { type: "string", description: "Corpo em texto simples" },
				cc: { type: "string", description: "Cópia (CC), separados por vírgula" },
			},
			required: ["to", "subject", "body"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const to = requireString(args.to, "to");
			const subject = requireString(args.subject, "subject");
			const body = requireString(args.body, "body");
			const cc = optionalString(args.cc);
			const rawLines = [
				`To: ${to}`,
				cc ? `Cc: ${cc}` : undefined,
				`Subject: ${encodeMimeHeader(subject)}`,
				'Content-Type: text/plain; charset="UTF-8"',
				"MIME-Version: 1.0",
				"",
				body,
			].filter((line): line is string => line !== undefined);
			const raw = base64UrlEncode(rawLines.join("\r\n"));
			const data = await googleJson<{ id: string }>(ctx, `${GMAIL_API}/drafts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: { raw } }),
			});
			return textResult(`Rascunho criado: ${data.id}`);
		},
	},
];

// ---------------------------------------------------------------------------
// Google Planilhas (Sheets API v4)
// ---------------------------------------------------------------------------

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

function optionalStringList(value: unknown, field: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`${field} deve ser uma lista de textos`);
	return value.map((item) => requireString(item, field));
}

/** Nome de aba em notação A1: entre aspas simples, com `'` duplicado. */
function quoteSheetName(name: string): string {
	return `'${name.replace(/'/g, "''")}'`;
}

const GOOGLE_SHEETS_TOOLS: ToolDef[] = [
	{
		name: "get_spreadsheet",
		description: "Título da planilha e lista de abas (nome e tamanho de cada uma).",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { spreadsheetId: { type: "string", description: "ID da planilha" } },
			required: ["spreadsheetId"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const spreadsheetId = requireString(args.spreadsheetId, "spreadsheetId");
			const data = await googleJson<{
				properties?: { title?: string };
				sheets?: { properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
			}>(ctx, `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties`);
			const lines = [`título: ${data.properties?.title ?? ""}`, "abas:"];
			for (const sheet of data.sheets ?? []) {
				const props = sheet.properties;
				lines.push(`- ${props?.title ?? ""} (${props?.gridProperties?.rowCount ?? "?"}x${props?.gridProperties?.columnCount ?? "?"})`);
			}
			return textResult(lines.join("\n"));
		},
	},
	{
		name: "read_range",
		description: "Lê um intervalo de células como texto (linhas separadas por quebra de linha, colunas por tabulação).",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				spreadsheetId: { type: "string", description: "ID da planilha" },
				range: { type: "string", description: 'Intervalo no formato A1 (ex.: "Página1!A1:C10")' },
			},
			required: ["spreadsheetId", "range"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const spreadsheetId = requireString(args.spreadsheetId, "spreadsheetId");
			const range = requireString(args.range, "range");
			const data = await googleJson<{ values?: unknown[][] }>(
				ctx,
				`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
			);
			const rows = data.values ?? [];
			const text = rows.map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");
			return textResult(capGoogleText(text || "(intervalo vazio)"));
		},
	},
	{
		name: "append_rows",
		description: "Adiciona linhas ao final de um intervalo/tabela existente.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				spreadsheetId: { type: "string", description: "ID da planilha" },
				range: { type: "string", description: 'Intervalo/tabela onde anexar (ex.: "Página1!A:C")' },
				rows: {
					type: "array",
					items: { type: "array", items: { type: "string" } },
					description: "Linhas a adicionar, cada uma como lista de valores de célula",
				},
			},
			required: ["spreadsheetId", "range", "rows"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const spreadsheetId = requireString(args.spreadsheetId, "spreadsheetId");
			const range = requireString(args.range, "range");
			if (!Array.isArray(args.rows) || args.rows.length === 0) {
				throw new Error("rows deve ser uma lista não vazia de linhas");
			}
			const rows = args.rows.map((row) => {
				if (!Array.isArray(row)) throw new Error("cada linha de rows deve ser uma lista de valores");
				return row.map((cell) => String(cell ?? ""));
			});
			const data = await googleJson<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
				ctx,
				`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) },
			);
			return textResult(`Linhas adicionadas em ${data.updates?.updatedRange ?? range} (${data.updates?.updatedRows ?? rows.length} linha(s)).`);
		},
	},
	{
		name: "create_spreadsheet",
		description:
			"Cria uma planilha nova na conta Google conectada e devolve o spreadsheetId e o link. Use para criar planilhas (histórico, acompanhamento, listas) em vez de abrir o navegador; não use para editar uma planilha existente (use update_range, append_rows ou add_sheet).",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Título da planilha" },
				sheets: {
					type: "array",
					items: { type: "string" },
					description: "Nomes das abas a criar (opcional; padrão: a aba padrão do Google)",
				},
				header: {
					type: "array",
					items: { type: "string" },
					description: "Cabeçalho gravado na linha 1 da primeira aba (opcional)",
				},
			},
			required: ["title"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const title = requireString(args.title, "title");
			const sheetNames = optionalStringList(args.sheets, "sheets");
			const header = optionalStringList(args.header, "header");
			const body: Record<string, unknown> = { properties: { title } };
			if (sheetNames.length > 0) body.sheets = sheetNames.map((name) => ({ properties: { title: name } }));
			const created = await googleJson<{ spreadsheetId: string; sheets?: { properties?: { title?: string } }[] }>(
				ctx,
				SHEETS_API,
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
			);
			const url = `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`;
			if (header.length > 0) {
				const firstSheet = sheetNames[0] ?? created.sheets?.[0]?.properties?.title;
				const range = firstSheet ? `${quoteSheetName(firstSheet)}!A1` : "A1";
				await googleJson(
					ctx,
					`${SHEETS_API}/${encodeURIComponent(created.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
					{ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: [header] }) },
				);
			}
			return textResult(`Planilha criada: ${title}\nspreadsheetId: ${created.spreadsheetId}\nlink: ${url}`);
		},
	},
	{
		name: "update_range",
		description:
			"Grava valores num intervalo de uma planilha, sobrescrevendo o que estiver lá. Use para corrigir ou preencher células; não use para acrescentar linhas ao fim (use append_rows).",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				spreadsheetId: { type: "string", description: "ID da planilha" },
				range: { type: "string", description: 'Intervalo no formato A1 (ex.: "Página1!A1:C2")' },
				values: {
					type: "array",
					items: { type: "array", items: { type: "string" } },
					description: "Linhas a gravar, cada uma como lista de valores de célula",
				},
			},
			required: ["spreadsheetId", "range", "values"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const spreadsheetId = requireString(args.spreadsheetId, "spreadsheetId");
			const range = requireString(args.range, "range");
			if (!Array.isArray(args.values) || args.values.length === 0) {
				throw new Error("values deve ser uma lista não vazia de linhas");
			}
			const values = args.values.map((row) => {
				if (!Array.isArray(row)) throw new Error("cada linha de values deve ser uma lista de valores");
				return row.map((cell) => String(cell ?? ""));
			});
			const data = await googleJson<{ updatedRange?: string; updatedCells?: number }>(
				ctx,
				`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
				{ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) },
			);
			return textResult(`Intervalo atualizado: ${data.updatedRange ?? range} (${data.updatedCells ?? "?"} célula(s)).`);
		},
	},
	{
		name: "add_sheet",
		description:
			"Adiciona uma aba nova a uma planilha existente. Use quando precisar separar dados em outra aba; não use para criar uma planilha (use create_spreadsheet).",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				spreadsheetId: { type: "string", description: "ID da planilha" },
				title: { type: "string", description: "Nome da nova aba" },
			},
			required: ["spreadsheetId", "title"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const spreadsheetId = requireString(args.spreadsheetId, "spreadsheetId");
			const title = requireString(args.title, "title");
			const data = await googleJson<{ replies?: { addSheet?: { properties?: { sheetId?: number; title?: string } } }[] }>(
				ctx,
				`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
				},
			);
			const props = data.replies?.[0]?.addSheet?.properties;
			return textResult(`Aba criada: ${props?.title ?? title}${props?.sheetId !== undefined ? ` (sheetId ${props.sheetId})` : ""}.`);
		},
	},
];

const TOOLS_BY_PRODUCT: Record<GoogleProduct, ToolDef[]> = {
	calendar: CALENDAR_TOOLS,
	drive: DRIVE_TOOLS,
	gmail: GMAIL_TOOLS,
	sheets: GOOGLE_SHEETS_TOOLS,
};

/**
 * Servidor MCP de baixo nível para um produto Google. Conectado ao cliente
 * via `InMemoryTransport` (ver `client-pool.ts`) — nunca ouve rede.
 */
export function createGoogleMcpServer(
	product: GoogleProduct,
	options: { getAccessToken: () => Promise<string>; fetchFn?: GoogleFetchFn },
): Server {
	const ctx: GoogleApiContext = {
		getAccessToken: options.getAccessToken,
		fetchFn: options.fetchFn ?? (globalThis.fetch as unknown as GoogleFetchFn),
	};
	const tools = TOOLS_BY_PRODUCT[product];
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const server = new Server({ name: `atlas-google-${product}`, version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: googleToolAnnotations(tool),
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) return errorResult(`tool desconhecida: ${request.params.name}`);
		try {
			return await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>, ctx);
		} catch (error) {
			// 401 sobe como UnauthorizedError (o pool/API marcam a conexão "pending_auth").
			if (error instanceof UnauthorizedError) throw error;
			const message =
				error instanceof GoogleApiError
					? mapGoogleApiError(error.status, error.message, product)
					: error instanceof Error
						? error.message
						: String(error);
			return errorResult(`Erro ao chamar a API do Google: ${message}`);
		}
	});
	return server;
}
