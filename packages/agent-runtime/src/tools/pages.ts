import type { ChatTool } from "@workspace/llm";
import {
	PAGE_MAX_CHARTS,
	PAGE_MAX_DEPTH,
	PAGE_MAX_NODES,
	PAGE_PRESET_PALETTES,
	applyPagePatch,
	parsePagePatchOps,
	parsePageSources,
	parsePageSpec,
	summarizePageSpec,
	type ComputerUseEvent,
	type PageNode,
	type PageSource,
	type PageSpec,
	type ResearchNote,
} from "@workspace/shared";
import { createPage, getPageForUser, listBotPagesForUser, updatePage, type PageListItem, type PageRecord, type UpdatePageResult } from "@workspace/db";

/**
 * Páginas vivas: relatório/painel que o bot monta e o chat desenha inline (cartão que abre em tela cheia).
 * A página é atualizada NO LUGAR (`page_update`, revisão++), nunca como mensagem nova. Os números vêm de
 * tools/`run_code`; o spec é validado por `parsePageSpec` (packages/shared) e o erro volta ao modelo.
 */

export const PAGE_CREATE_TOOL_NAME = "page_create";
export const PAGE_UPDATE_TOOL_NAME = "page_update";
export const PAGE_READ_TOOL_NAME = "page_read";
export const PAGE_LIST_TOOL_NAME = "page_list";
export const PAGE_TOOL_NAMES: readonly string[] = [PAGE_CREATE_TOOL_NAME, PAGE_UPDATE_TOOL_NAME, PAGE_READ_TOOL_NAME, PAGE_LIST_TOOL_NAME];

/**
 * Gramática compacta dos componentes (texto do modelo). Os detalhes e as props válidas de cada um vêm nos
 * erros do `parsePageSpec` (packages/shared), para não inflar o prefixo do prompt.
 */
const NODE_GRAMMAR =
	"A page is a TREE of ready-made components that you compose freely: `root` is one node {type, id?, props?, children?}; ids are generated when missing and stay stable for page_update. " +
	"Layout: section{title?,description?} · grid{cols:1-4,gap?} (1 col on phones; `span` on a child = columns it takes) · stack{direction?,gap?} · card{title?,variant?,tone?} · tabs{tabs:[{id,label}]} with one {type:\"tab\",props:{tab:id}} child per tab · divider. " +
	"Data: stat{label,value,unit?,format?,delta?:{value,kind?:percent|absolute,direction:up|down|flat,label?},size?,tone?} · chart{spec} (same spec as the chart tool: line|area|bar|pie|composed|radar|funnel|gauge, reference for a goal, forecast; bar accepts orientation:\"horizontal\" for horizontal bars, unknown fields are rejected) · " +
	"bar_list{items:[{label,value,display?}],unit?} · table{columns:[{key,label,align?,format?,unit?}],rows,variant?} · progress{label,value,max} for a goal · badge{text,tone} · callout{title?,text,tone:info|success|warning|critical} · " +
	"timeline{items:[{date,title,text?,tone?}]} · kanban{columns:[{title,items:[{title,subtitle?,badge?}]}]} · list{items:[{title,subtitle?,value?,tone?}]} · text{markdown} · heading{text,level?}. " +
	"tone = neutral|positive|warning|critical|accent. Colors come only from the palette and tones: never write hex colors on components. " +
	`Limits: ${PAGE_MAX_NODES} nodes, depth ${PAGE_MAX_DEPTH}, ${PAGE_MAX_CHARTS} charts. Compose to fit the content (KPIs in a grid first, then charts, tables, lists) and keep it readable on a phone; invalid props come back as an error that names the valid ones.`;

const PALETTE_PARAM = {
	description: `Page palette (accent and charts): ${PAGE_PRESET_PALETTES.join(" | ")} or {colors:["#rrggbb"...]} (1-6). The ids are for this tool only: tell the user the display name (pt-BR: Primária, Monocromática, Oceano, Pôr do sol, Bosque, Vívida) described by look, never the id. Pick one that fits the content (money/growth: grove; alerts/collections: sunset; neutral: ocean or monochrome).`,
	anyOf: [{ type: "string", enum: [...PAGE_PRESET_PALETTES] }, { type: "object", properties: { colors: { type: "array", items: { type: "string" } } }, required: ["colors"] }],
};

const NODE_PARAM = { type: "object", description: "A component node {type, id?, props?, children?}.", properties: { type: { type: "string" } }, required: ["type"] };

const SOURCES_PARAM = {
	type: "array",
	description: "Up to 20 sources behind the numbers. Defaults to the sources of your research notes in this conversation.",
	items: { type: "object", properties: { title: { type: "string" }, url: { type: "string", description: "http(s) link" } }, required: ["title"] },
};

export const PAGE_CREATE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PAGE_CREATE_TOOL_NAME,
		description:
			"Builds a live page (report, memo or dashboard) composed of ready-made components, which renders inline in the chat as a card and opens full screen on tap; the user keeps it and you refresh it later with page_update. Users call it a \"painel\" (pt-BR) / \"dashboard\": use that word in your replies, never \"página\"/\"page\", which users confuse with a web page. " +
			"USE WHEN the user asks for a dashboard (painel), report, overview or forecast to keep, review and refresh. " +
			"DO NOT USE for a single chart (use the chart tool path of run_code or a chart fence), a downloadable document (use create_file) or a plain answer. " +
			"Every number must come from tools or run_code results, never invented or estimated; gather the data first, then build the page once. " +
			NODE_GRAMMAR,
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short page title (up to 120 characters)." },
				summary: { type: "string", description: "One or two sentences with the main takeaway (up to 400 characters)." },
				palette: PALETTE_PARAM,
				root: { ...NODE_PARAM, description: "Root component of the tree, usually a stack or section whose children are the page content." },
				sources: SOURCES_PARAM,
			},
			required: ["title", "root"],
		},
	},
};

export const PAGE_UPDATE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PAGE_UPDATE_TOOL_NAME,
		description:
			"Updates an existing page IN PLACE (same card in the chat, revision + 1). Pass `ops` to change only some nodes by id (replace | insert_after | append_child | remove; insert_after without id appends to the root), " +
			"or `root` to rewrite the whole tree; `title`, `summary`, `palette` and `sources` can change on their own. " +
			"USE WHEN the user asks to change, extend or refresh a page you built (get the node ids from page_read first when you do not have them). DO NOT USE to create another page for the same subject. " +
			"Refreshed numbers must come from tools, never invented. " +
			NODE_GRAMMAR,
		parameters: {
			type: "object",
			properties: {
				page_id: { type: "string", description: "Id returned by page_create or page_list." },
				title: { type: "string" },
				summary: { type: "string" },
				palette: PALETTE_PARAM,
				root: { ...NODE_PARAM, description: "Full replacement of the tree." },
				ops: {
					type: "array",
					description: "Partial changes by node id (any depth).",
					items: {
						type: "object",
						properties: {
							op: { type: "string", enum: ["replace", "insert_after", "append_child", "remove"] },
							id: { type: "string", description: "Node id (parent id for append_child; optional for insert_after: omitted appends to the root)." },
							node: { type: "object", description: "New node for replace / insert_after / append_child." },
						},
						required: ["op"],
					},
				},
				sources: SOURCES_PARAM,
			},
			required: ["page_id"],
		},
	},
};

export const PAGE_READ_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PAGE_READ_TOOL_NAME,
		description: "Reads a page of this user: the node ids and content, to update only part of it. USE BEFORE page_update when you do not have the current node ids. DO NOT USE just to show the page to the user (the chat already shows it).",
		parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
	},
};

export const PAGE_LIST_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PAGE_LIST_TOOL_NAME,
		description: "Lists this bot's live pages, which users call \"painéis\"/dashboards (id, title, revision, last update). USE to find the page the user means before updating it, or to avoid creating a duplicate. DO NOT USE to open a page for the user.",
		parameters: { type: "object", properties: {} },
	},
};

export const PAGE_TOOLS: readonly ChatTool[] = [PAGE_CREATE_TOOL, PAGE_UPDATE_TOOL, PAGE_READ_TOOL, PAGE_LIST_TOOL];

/** Acesso às páginas (injetável em teste; produção usa o db). */
export type PagesStore = {
	create(userId: string, input: { botId: string; conversationId?: string | null; spec: PageSpec; sources: PageSource[] }): Promise<PageRecord | null>;
	get(id: string, userId: string): Promise<PageRecord | null>;
	list(userId: string, botId: string): Promise<PageListItem[]>;
	update(id: string, userId: string, input: { spec: PageSpec; sources?: PageSource[]; expectedRevision?: number; refreshed?: boolean }): Promise<UpdatePageResult>;
};

export const dbPagesStore: PagesStore = {
	create: (userId, input) => createPage(userId, input),
	get: (id, userId) => getPageForUser(id, userId),
	list: async (userId, botId) => (await listBotPagesForUser(userId, botId)) ?? [],
	update: (id, userId, input) => updatePage(id, userId, input),
};

export type PageToolContext = {
	userId?: string;
	botId?: string;
	conversationId?: string;
	runId?: string;
	store?: PagesStore;
	/** Notas de pesquisa do run (fontes padrão da página). */
	researchNotes?: () => readonly ResearchNote[];
	/** Rotina que atualiza uma página: `page_update` só vale nela e marca a página como atualizada com dados novos. */
	routinePageId?: string;
	emitPage?: (event: Extract<ComputerUseEvent, { type: "page" }>) => Promise<void>;
};

/** Fontes http(s) das notas de pesquisa (uma por URL), como fonte padrão da página. */
export function sourcesFromResearchNotes(notes: readonly ResearchNote[]): PageSource[] {
	const candidates = notes
		.filter((note) => /^https?:\/\//i.test(note.sourceRef))
		.map((note) => ({ title: note.findings.slice(0, 80) || note.sourceRef, url: note.sourceRef }));
	const parsed = parsePageSources(candidates.slice(0, 20));
	return parsed.ok ? parsed.sources : [];
}

const READ_FULL_MAX_CHARS = 20_000;

function nodeLabel(node: PageNode): string {
	switch (node.type) {
		case "section":
		case "card":
			return node.props.title ?? "";
		case "stat":
		case "progress":
			return node.props.label;
		case "heading":
			return node.props.text.slice(0, 60);
		case "text":
			return node.props.markdown.slice(0, 60);
		case "badge":
			return node.props.text;
		case "callout":
			return (node.props.title ?? node.props.text).slice(0, 60);
		case "chart":
			return node.props.spec.title ?? node.props.spec.type;
		case "table":
			return node.props.columns.map((column) => column.label).join(", ").slice(0, 60);
		case "bar_list":
		case "list":
		case "timeline":
			return `${node.props.items.length} items`;
		case "kanban":
			return node.props.columns.map((column) => column.title).join(" | ").slice(0, 60);
		case "tabs":
			return node.props.tabs.map((tab) => tab.label).join(" | ");
		case "grid":
			return `${node.props.cols} cols`;
		default:
			return "";
	}
}

/** Uma linha por nó (id, tipo, rótulo), com os filhos indentados. */
export function outlinePage(spec: PageSpec): string {
	const lines: string[] = [];
	const visit = (node: PageNode, depth: number) => {
		lines.push(`${"  ".repeat(depth)}- ${node.id} [${node.type}] ${nodeLabel(node)}`.trimEnd());
		for (const child of node.children ?? []) visit(child, depth + 1);
	};
	visit(spec.root, 0);
	return lines.join("\n");
}

function requireScope(ctx: PageToolContext): { userId: string; botId: string; store: PagesStore } {
	const userId = ctx.userId?.trim();
	if (!userId || userId === "default" || !ctx.botId) throw new Error("Pages are not available in this run (no signed-in owner or bot).");
	return { userId, botId: ctx.botId, store: ctx.store ?? dbPagesStore };
}

function pageIdArg(args: Record<string, unknown>): string {
	const id = typeof args.page_id === "string" ? args.page_id.trim() : "";
	if (!id) throw new Error("page_id is required: use the id from page_create or page_list.");
	return id;
}

function sourcesArg(args: Record<string, unknown>): PageSource[] | undefined {
	if (args.sources === undefined || args.sources === null) return undefined;
	const parsed = parsePageSources(args.sources);
	if (!parsed.ok) throw new Error(`Invalid sources: ${parsed.error}`);
	return parsed.sources;
}

function invalid(error: string): Error {
	return new Error(`Invalid page: ${error}. Fix the page and call the tool again.`);
}

const SHOWN_NOTE = "The chat already shows this page to the user as a card: do not repeat its content; reply in one short line.";

async function emit(ctx: PageToolContext, action: "created" | "updated", page: PageRecord): Promise<void> {
	await ctx.emitPage?.({
		type: "page",
		action,
		pageId: page.id,
		revision: page.revision,
		title: page.title,
		spec: page.spec,
		sourceCount: page.sources.length,
		...(ctx.runId ? { runId: ctx.runId } : {}),
	});
}

async function createTool(args: Record<string, unknown>, ctx: PageToolContext): Promise<{ summary: string }> {
	const { userId, botId, store } = requireScope(ctx);
	const parsed = parsePageSpec({ v: 2, title: args.title, summary: args.summary, palette: args.palette, root: args.root });
	if (!parsed.ok) throw invalid(parsed.error);
	const sources = sourcesArg(args) ?? sourcesFromResearchNotes(ctx.researchNotes?.() ?? []);
	const page = await store.create(userId, { botId, conversationId: ctx.conversationId ?? null, spec: parsed.spec, sources });
	if (!page) throw new Error("Could not create the page for this bot. Tell the user it failed; do not retry in a loop.");
	await emit(ctx, "created", page);
	return {
		summary: `Page created (page_id ${page.id}, revision ${page.revision}). ${summarizePageSpec(page.spec)}; ${page.sources.length} sources. ${SHOWN_NOTE} To change it later use page_update with this page_id.`,
	};
}

async function updateTool(args: Record<string, unknown>, ctx: PageToolContext): Promise<{ summary: string }> {
	const { userId, store } = requireScope(ctx);
	const pageId = pageIdArg(args);
	if (ctx.routinePageId && pageId !== ctx.routinePageId) {
		throw new Error(`This routine run may only update its own page (page_id ${ctx.routinePageId}); ${pageId} is not it. Call page_update with page_id ${ctx.routinePageId}.`);
	}
	const hasOps = args.ops !== undefined && args.ops !== null;
	const hasRoot = args.root !== undefined && args.root !== null;
	if (hasOps && hasRoot) throw new Error("Pass either `ops` (partial change) or `root` (full rewrite), not both.");
	const sources = sourcesArg(args);
	if (!hasOps && !hasRoot && args.title === undefined && args.summary === undefined && args.palette === undefined && sources === undefined) {
		throw new Error("Nothing to update: pass `ops`, `root`, `title`, `summary`, `palette` or `sources`.");
	}
	const parsedOps = hasOps ? parsePagePatchOps(args.ops) : null;
	if (parsedOps && !parsedOps.ok) throw invalid(parsedOps.error);

	// Uma releitura se outro update ganhou a corrida entre a leitura e a gravação.
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const current = await store.get(pageId, userId);
		if (!current) throw new Error(`Page ${pageId} not found. Use page_list to see this bot's pages.`);
		let base: PageSpec = current.spec;
		if (parsedOps?.ok) {
			const patched = applyPagePatch(base, parsedOps.ops);
			if (!patched.ok) throw invalid(patched.error);
			base = patched.spec;
		}
		const parsed = parsePageSpec({
			v: 2,
			title: typeof args.title === "string" ? args.title : base.title,
			summary: typeof args.summary === "string" ? args.summary : base.summary,
			palette: args.palette !== undefined && args.palette !== null ? args.palette : base.palette,
			root: hasRoot ? args.root : base.root,
		});
		if (!parsed.ok) throw invalid(parsed.error);
		const result = await store.update(pageId, userId, { spec: parsed.spec, ...(sources ? { sources } : {}), expectedRevision: current.revision, ...(ctx.routinePageId ? { refreshed: true } : {}) });
		if (!result.ok && result.error === "conflict" && attempt === 0) continue;
		if (!result.ok) {
			throw new Error(result.error === "conflict" ? "The page changed while updating. Call page_read and try again." : `Page ${pageId} not found. Use page_list to see this bot's pages.`);
		}
		await emit(ctx, "updated", result.page);
		return {
			summary: `Page updated in place (page_id ${result.page.id}, revision ${result.page.revision}). ${summarizePageSpec(result.page.spec)}. ${SHOWN_NOTE}`,
		};
	}
	throw new Error("The page changed while updating. Call page_read and try again.");
}

async function readTool(args: Record<string, unknown>, ctx: PageToolContext): Promise<{ summary: string }> {
	const { userId, store } = requireScope(ctx);
	const pageId = pageIdArg(args);
	const page = await store.get(pageId, userId);
	if (!page) throw new Error(`Page ${pageId} not found. Use page_list to see this bot's pages.`);
	const json = JSON.stringify({ title: page.title, summary: page.spec.summary, palette: page.spec.palette, root: page.spec.root });
	const head = `Page ${page.id}, revision ${page.revision}, ${page.sources.length} sources. ${summarizePageSpec(page.spec)}.\nNode ids:\n${outlinePage(page.spec)}`;
	if (json.length > READ_FULL_MAX_CHARS) {
		return { summary: `${head}\n(The full content is too large to print; use the ids above with page_update ops.)` };
	}
	return { summary: `${head}\nContent: ${json}` };
}

async function listTool(_args: Record<string, unknown>, ctx: PageToolContext): Promise<{ summary: string }> {
	const { userId, botId, store } = requireScope(ctx);
	const items = await store.list(userId, botId);
	if (items.length === 0) return { summary: "This bot has no pages yet." };
	const lines = items.map((item) => `- ${item.id}: "${item.title}" (revision ${item.revision}, updated ${item.updatedAt})`);
	return { summary: `${items.length} page${items.length === 1 ? "" : "s"}:\n${lines.join("\n")}` };
}

export function isPageTool(name: string): boolean {
	return PAGE_TOOL_NAMES.includes(name);
}

/** Executor das quatro tools; falha lança erro (resultado honesto, `ok:false` no loop). */
export async function executePageTool(name: string, args: Record<string, unknown>, ctx: PageToolContext): Promise<{ summary: string }> {
	switch (name) {
		case PAGE_CREATE_TOOL_NAME:
			return createTool(args, ctx);
		case PAGE_UPDATE_TOOL_NAME:
			return updateTool(args, ctx);
		case PAGE_READ_TOOL_NAME:
			return readTool(args, ctx);
		case PAGE_LIST_TOOL_NAME:
			return listTool(args, ctx);
		default:
			throw new Error(`Unknown page tool: ${name}`);
	}
}

