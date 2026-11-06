// Capacidade `connectors` (F2.5): ponte MCP do dono. Montada POR RUN com o dono do run, porque as conexões, a
// classificação de cada tool e o `confirmWrites` dependem dele.
//
//  - Escopo: só conexões do dono, conectadas; conexão com outro `ownerId` é descartada mesmo que a porta a devolva.
//  - Contexto: o modelo recebe `tool_search` e, por conexão, duas tools genéricas (`mcp_<slug>_read`/`_write`) com
//    schema mínimo. O schema detalhado de cada tool MCP só chega no resultado do `tool_search`.
//  - Efeito: classificado do schema/anotações (`classifyMcpEffect`); sem anotação é `write_external`. A tool `_read`
//    só roda tool classificada como leitura; a `_write` tem o efeito da tool chamada (`effectForArgs`).
//  - `confirmWrites` vira `confirm: "always"` na própria tool `mcp_<slug>_write`: o `decide` nunca deixa regra `run`
//    do dono afrouxar o `confirm` declarado (regra de política antes das do dono perdia para `*` → `run`).
//  - `egress`: só em conector PÚBLICO (busca etc.): os args vão a terceiro, então com dado privado + leitura não
//    confiável no run a chamada pede cartão. Conector privado do dono (Gmail, Drive) não declara: é o serviço dele.
//  - Resultado e erro de MCP são `trust: "untrusted"`, `source: "mcp"`, com segredo redigido.
//    Conector privado (padrão) declara `privateData: true`.
import { classifyMcpEffect, isPrivateConnector, sanitizeErrorMessage, type McpEffectClass } from "@workspace/shared";
import { z } from "zod";
import { type Capability, defineCapability, SUMMARY_MAX_LENGTH } from "../capabilities/define-capability.js";
import { sanitizeText } from "../contract/sanitize.js";
import type { Mcp, McpConnectionSnapshot } from "../ports/mcp.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { connectorToolNames, uniqueSlugParts } from "./naming.js";
import { searchTools, queryWords, TOOL_SEARCH_DEFAULT_LIMIT, TOOL_SEARCH_MAX_LIMIT, type SearchableTool } from "./tool-search.js";

export const TOOL_SEARCH_TOOL = "tool_search";
const MAX_ARGS_CHARS = 100_000;
const DESCRIPTION_CHARS = 400;

type PreparedTool = { info: McpConnectionSnapshot["tools"][number]; effect: McpEffectClass };
type PreparedConnection = {
	snapshot: McpConnectionSnapshot;
	part: string;
	names: ReturnType<typeof connectorToolNames>;
	privateData: boolean;
	tools: Map<string, PreparedTool>;
};

export type ConnectorsSetup = {
	/** `null` quando o dono não tem conexão utilizável: não registre nada. */
	capability: Capability | null;
};

function isOwner(ownerId: string): boolean {
	return ownerId.trim().length > 0 && ownerId !== "default";
}

function prepare(snapshot: McpConnectionSnapshot, part: string): PreparedConnection {
	const disabled = new Set(snapshot.disabledTools);
	const tools = new Map<string, PreparedTool>();
	for (const info of snapshot.tools) {
		if (disabled.has(info.name) || tools.has(info.name)) continue;
		// A marcação do dono só vale sem anotação do servidor (a função pura decide); aqui só repassamos.
		tools.set(info.name, { info, effect: classifyMcpEffect(info, { ownerMark: snapshot.toolMarks?.[info.name] }) });
	}
	return { snapshot, part, names: connectorToolNames(part), privateData: isPrivateConnector(snapshot.catalogId), tools };
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function capabilitySummary(prepared: readonly PreparedConnection[]): string {
	const shown = prepared.slice(0, 6).map((c) => c.part);
	const more = prepared.length > shown.length ? ` +${prepared.length - shown.length}` : "";
	return clip(`Owner's connected apps (${shown.join(", ")}${more}): find a tool with tool_search, then call it.`, SUMMARY_MAX_LENGTH);
}

export async function createConnectorsCapability(mcp: Mcp, ownerId: string, signal?: AbortSignal): Promise<ConnectorsSetup> {
	if (!isOwner(ownerId)) return { capability: null };
	const listed = await mcp.listConnections(ownerId, signal);
	const usable = listed.filter((c) => c.ownerId === ownerId && c.status === "connected");
	if (usable.length === 0) return { capability: null };
	const parts = uniqueSlugParts(usable.map((c) => c.slug));
	const prepared = usable.map((c, i) => prepare(c, parts[i] as string));
	const byPart = new Map(prepared.map((c) => [c.part, c]));

	const searchable: SearchableTool[] = prepared.flatMap((c) => [...c.tools.values()].map((t) => ({ connection: c.part, tool: t.info })));

	const search = defineTool({
		name: TOOL_SEARCH_TOOL,
		description:
			"Find tools of the owner's connected apps (email, calendar, drive, ERP…) by what you want to do, e.g. \"search messages\". Returns the exact tool name, its arguments and which mcp_* tool runs it. Use it before the first call to an app. Do not use for web search or for the owner's files in the workspace.",
		inputSchema: z.object({
			query: z.string().min(1).max(200).describe("What you want to do, in a few words."),
			app: z.string().max(60).optional().describe("Limit to one connected app (its name in the mcp_<app>_read tool)."),
			limit: z.number().int().min(1).max(TOOL_SEARCH_MAX_LIMIT).optional(),
		}),
		effect: "read",
		// Descrições e schemas vêm do servidor do conector (terceiro): dado, nunca instrução.
		trust: "untrusted",
		source: "mcp",
		execute({ query, app, limit }) {
			const scope = app === undefined ? searchable : searchable.filter((s) => s.connection === app);
			if (app !== undefined && !byPart.has(app)) {
				return { ok: false, error: `Unknown app "${app}".`, hint: `Connected apps: ${[...byPart.keys()].join(", ")}.` };
			}
			if (queryWords(query).length === 0) return { ok: false, error: "The query has no searchable words.", hint: 'Describe the action in a few plain words, e.g. "list events".' };
			const hits = searchTools(scope, query, limit ?? TOOL_SEARCH_DEFAULT_LIMIT);
			if (hits.length === 0) {
				return { ok: true, summary: `No tool matches "${clip(query, 80)}". Connected apps: ${[...byPart.keys()].join(", ")}. Try other words or name the app.` };
			}
			const blocks = hits.map(({ connection, tool }) => {
				const conn = byPart.get(connection) as PreparedConnection;
				const effect = (conn.tools.get(tool.name) as PreparedTool).effect;
				const via = effect === "read" ? conn.names.read : conn.names.write;
				const description = tool.description ? `\n${clip(tool.description, DESCRIPTION_CHARS)}` : "";
				return `${tool.name} (app ${connection}, run it with ${via}, ${effect === "read" ? "read" : "changes data"})${description}\nArguments schema: ${JSON.stringify(tool.inputSchema)}`;
			});
			return { ok: true, summary: sanitizeText(blocks.join("\n\n")) };
		},
	});

	const callTools: Tool[] = [];
	for (const conn of prepared) {
		const { part, names, snapshot, privateData } = conn;
		const argsSchema = z.object({
			tool: z.string().min(1).max(200).describe("Exact tool name from tool_search."),
			args: z.record(z.string(), z.unknown()).optional().describe("Arguments as given by the schema from tool_search."),
		});
		const run = async (kind: "read" | "write", tool: string, args: Record<string, unknown> | undefined, ctx: { ownerId: string; signal?: AbortSignal }) => {
			if (ctx.ownerId !== snapshot.ownerId) return { ok: false as const, error: "This app belongs to another owner." };
			const found = conn.tools.get(tool);
			if (!found) return { ok: false as const, error: `Unknown tool "${tool}" in app ${part}.`, hint: "Use tool_search to find the exact tool name." };
			if (kind === "read" && found.effect !== "read") return { ok: false as const, error: `"${tool}" changes data, so it cannot run with ${names.read}.`, hint: `Call it with ${names.write}.` };
			if (kind === "write" && found.effect === "read") return { ok: false as const, error: `"${tool}" only reads.`, hint: `Call it with ${names.read}.` };
			const payload = args ?? {};
			if (JSON.stringify(payload).length > MAX_ARGS_CHARS) return { ok: false as const, error: "Arguments are too large.", hint: "Send less data per call." };
			let result: Awaited<ReturnType<Mcp["call"]>>;
			try {
				result = await mcp.call(ctx.ownerId, snapshot.id, tool, payload, ctx.signal);
			} catch (error) {
				result = { ok: false, error: sanitizeErrorMessage(error) };
			}
			if (!result.ok) return { ok: false as const, error: sanitizeErrorMessage(result.error), hint: "Check the arguments against tool_search, or tell the owner the app failed." };
			const out = sanitizeText(result.text);
			return { ok: true as const, summary: out.length > 0 ? out : `${tool} ran; the app returned no text.`, ...(kind === "write" && { receipt: { what: tool, where: part } }) };
		};
		callTools.push(
			defineTool({
				name: names.read,
				description: `Run a read-only tool of the owner's app "${part}". Find the tool and its arguments with tool_search first. Do not use for tools that change data (use ${names.write}).`,
				inputSchema: argsSchema,
				effect: "read",
				trust: "untrusted",
				source: "mcp",
				privateData,
				...(!privateData && { egress: true }),
				...(privateData && { ownerData: "connector" as const }),
				execute: ({ tool, args }, ctx) => run("read", tool, args, ctx),
			}),
			defineTool({
				name: names.write,
				description: `Run a tool of the owner's app "${part}" that creates, changes, sends or deletes data. Find the tool and its arguments with tool_search first. The owner may be asked to confirm. Do not use for reading (use ${names.read}).`,
				inputSchema: argsSchema,
				effect: "write_external",
				effectForArgs: ({ tool }) => {
					const found = conn.tools.get(tool);
					return found && found.effect !== "read" ? found.effect : "write_external";
				},
				riskFacts: ({ tool }) => ({ target: `${part}: ${tool}`, ...(conn.tools.get(tool)?.effect === "destructive" && { irreversible: true }) }),
				trust: "untrusted",
				source: "mcp",
				privateData,
				...(!privateData && { egress: true }),
				...(snapshot.confirmWrites && { confirm: "always" as const }),
				execute: ({ tool, args }, ctx) => run("write", tool, args, ctx),
			}),
		);
	}

	const capability = defineCapability({
		id: "connectors",
		title: "Connected apps",
		summary: capabilitySummary(prepared),
		tools: [search, ...callTools],
	});
	return { capability };
}
