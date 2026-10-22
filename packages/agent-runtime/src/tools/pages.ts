import type { ChatTool } from "@workspace/llm";
import {
	PAGE_MAX_BLOCKS,
	PAGE_MAX_CHARTS,
	applyPagePatch,
	parsePagePatchOps,
	parsePageSources,
	parsePageSpec,
	summarizePageSpec,
	type ComputerUseEvent,
	type PageBlock,
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

const BLOCK_GRAMMAR =
	"Block shapes (every block may carry a stable `id`; it is generated if missing): " +
	'{type:"heading",text} · {type:"markdown",text<=4000} · ' +
	'{type:"stats",items<=8:[{label,value:number|string,unit?,format?:number|compact|percent|currency,delta?:{value,direction:up|down|flat,label?}}]} · ' +
	'{type:"chart",spec:{type:line|bar|area|pie,x,series:[{key,label?}],data:[{...}],unit?}} (same spec as the chart tool) · ' +
	'{type:"bar_list",items<=30:[{label,value:number,display?}],unit?} · ' +
	'{type:"table",columns<=10:[{key,label,align?,format?}],rows<=100:[{key:value}]} · ' +
	'{type:"tabs",tabs:[{id?,label,blocks:[...]}]} with 2-6 tabs and no nested tabs. ' +
	`Limits: ${PAGE_MAX_BLOCKS} blocks in total (tab contents included), ${PAGE_MAX_CHARTS} charts. Put the key numbers first (stats), then charts and tables.`;

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
			"Builds a live page (report, memo or dashboard) that renders inline in the chat as a card and opens full screen on tap; the user keeps it and you refresh it later with page_update. " +
			"USE WHEN the user asks for a dashboard, report, overview, forecast or page to keep, review and refresh. " +
			"DO NOT USE for a single chart (use the chart block of run_code or a chart fence), a downloadable document (use create_file) or a plain answer. " +
			"Every number must come from tools or run_code results, never invented or estimated; gather the data first, then build the page once. " +
			BLOCK_GRAMMAR,
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short page title (up to 120 characters)." },
				summary: { type: "string", description: "One or two sentences with the main takeaway (up to 400 characters)." },
				blocks: { type: "array", description: "The page content, in order.", items: { type: "object", properties: { type: { type: "string", enum: ["heading", "markdown", "stats", "chart", "bar_list", "table", "tabs"] } }, required: ["type"] } },
				sources: SOURCES_PARAM,
			},
			required: ["title", "blocks"],
		},
	},
};

export const PAGE_UPDATE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PAGE_UPDATE_TOOL_NAME,
		description:
			"Updates an existing page IN PLACE (same card in the chat, revision + 1). Pass `ops` to change only some blocks by id (replace | insert_after | remove; insert_after without id appends), " +
			"or `blocks` to rewrite the whole content; `title`, `summary` and `sources` can change on their own. " +
			"USE WHEN the user asks to change, extend or refresh a page you built (get the block ids from page_read first when you do not have them). DO NOT USE to create another page for the same subject. " +
			"Refreshed numbers must come from tools, never invented. " +
			BLOCK_GRAMMAR,
		parameters: {
			type: "object",
			properties: {
				page_id: { type: "string", description: "Id returned by page_create or page_list." },
				title: { type: "string" },
				summary: { type: "string" },
				blocks: { type: "array", description: "Full replacement of the content.", items: { type: "object", properties: { type: { type: "string" } }, required: ["type"] } },
				ops: {
					type: "array",
					description: "Partial changes by block id (also tab contents).",
					items: {
						type: "object",
						properties: {
							op: { type: "string", enum: ["replace", "insert_after", "remove"] },
							id: { type: "string", description: "Block id (optional for insert_after: omitted appends at the end)." },
							block: { type: "object", description: "New block for replace / insert_after." },
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
		description: "Reads a page of this user: the block ids and content, to update only part of it. USE BEFORE page_update when you do not have the current block ids. DO NOT USE just to show the page to the user (the chat already shows it).",
		parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
	},
};

export const PAGE_LIST_TOOL: ChatTool = {
	type: "function",
	function: {
		name: PAGE_LIST_TOOL_NAME,
		description: "Lists this bot's pages (id, title, revision, last update). USE to find the page the user means before updating it, or to avoid creating a duplicate. DO NOT USE to open a page for the user.",
		parameters: { type: "object", properties: {} },
	},
};

export const PAGE_TOOLS: readonly ChatTool[] = [PAGE_CREATE_TOOL, PAGE_UPDATE_TOOL, PAGE_READ_TOOL, PAGE_LIST_TOOL];

/** Acesso às páginas (injetável em teste; produção usa o db). */
export type PagesStore = {
	create(userId: string, input: { botId: string; conversationId?: string | null; spec: PageSpec; sources: PageSource[] }): Promise<PageRecord | null>;
	get(id: string, userId: string): Promise<PageRecord | null>;
	list(userId: string, botId: string): Promise<PageListItem[]>;
	update(id: string, userId: string, input: { spec: PageSpec; sources?: PageSource[]; expectedRevision?: number }): Promise<UpdatePageResult>;
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

function blockLabel(block: PageBlock): string {
	switch (block.type) {
		case "heading":
		case "markdown":
			return block.text.slice(0, 60);
		case "stats":
			return block.items.map((item) => item.label).join(", ").slice(0, 60);
		case "chart":
			return block.spec.title ?? block.spec.type;
		case "table":
			return block.columns.map((column) => column.label).join(", ").slice(0, 60);
		case "bar_list":
			return `${block.items.length} items`;
		case "tabs":
			return block.tabs.map((tab) => tab.label).join(" | ");
	}
}

/** Uma linha por bloco (id, tipo, rótulo), com as abas indentadas. */
export function outlinePage(spec: PageSpec): string {
	const lines: string[] = [];
	const visit = (blocks: readonly PageBlock[], depth: number) => {
		for (const block of blocks) {
			lines.push(`${"  ".repeat(depth)}- ${block.id} [${block.type}] ${blockLabel(block)}`);
			if (block.type === "tabs") for (const tab of block.tabs) visit(tab.blocks, depth + 1);
		}
	};
	visit(spec.blocks, 0);
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
	const parsed = parsePageSpec({ v: 1, title: args.title, summary: args.summary, blocks: args.blocks });
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
	const hasOps = args.ops !== undefined && args.ops !== null;
	const hasBlocks = args.blocks !== undefined && args.blocks !== null;
	if (hasOps && hasBlocks) throw new Error("Pass either `ops` (partial change) or `blocks` (full rewrite), not both.");
	const sources = sourcesArg(args);
	if (!hasOps && !hasBlocks && args.title === undefined && args.summary === undefined && sources === undefined) {
		throw new Error("Nothing to update: pass `ops`, `blocks`, `title`, `summary` or `sources`.");
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
			v: 1,
			title: typeof args.title === "string" ? args.title : base.title,
			summary: typeof args.summary === "string" ? args.summary : base.summary,
			blocks: hasBlocks ? args.blocks : base.blocks,
		});
		if (!parsed.ok) throw invalid(parsed.error);
		const result = await store.update(pageId, userId, { spec: parsed.spec, ...(sources ? { sources } : {}), expectedRevision: current.revision });
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
	const json = JSON.stringify({ title: page.title, summary: page.spec.summary, blocks: page.spec.blocks });
	const head = `Page ${page.id}, revision ${page.revision}, ${page.sources.length} sources. ${summarizePageSpec(page.spec)}.\nBlock ids:\n${outlinePage(page.spec)}`;
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

