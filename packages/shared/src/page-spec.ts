/**
 * Especificação de "Página": um relatório/painel vivo que o bot monta e a UI desenha inline no chat.
 * Um JSON pequeno e validado (como o `chart-spec`), em blocos com `id` estável para o bot atualizar
 * só uma parte (`applyPagePatch`) sem reescrever a página inteira.
 *
 * ```json
 * { "v": 1, "title": "Forecast Q4", "summary": "Receita 8% acima da meta",
 *   "blocks": [ { "type": "stats", "items": [{ "label": "Receita", "value": 120000, "unit": "BRL" }] } ] }
 * ```
 * As mensagens de erro vão para o modelo (inglês, acionáveis).
 */
import { parseChartSpec, type ChartSpec } from "./chart-spec.js";

export const PAGE_MAX_JSON_CHARS = 200_000;
export const PAGE_MAX_BLOCKS = 30;
export const PAGE_MAX_CHARTS = 6;
export const PAGE_MAX_MARKDOWN_CHARS = 4000;
export const PAGE_MAX_STATS = 8;
export const PAGE_MAX_BAR_ITEMS = 30;
export const PAGE_MAX_TABLE_COLUMNS = 10;
export const PAGE_MAX_TABLE_ROWS = 100;
export const PAGE_MIN_TABS = 2;
export const PAGE_MAX_TABS = 6;
export const PAGE_MAX_SOURCES = 20;
export const PAGE_FORMATS = ["number", "compact", "percent", "currency"] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];
export const PAGE_BLOCK_TYPES = ["heading", "markdown", "stats", "chart", "bar_list", "table", "tabs"] as const;
export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

export type PageStatDelta = { value: number | string; direction: "up" | "down" | "flat"; label?: string };
export type PageStat = { label: string; value: number | string; unit?: string; format?: PageFormat; delta?: PageStatDelta };
export type PageBarItem = { label: string; value: number; display?: string };
export type PageTableColumn = { key: string; label: string; align?: "left" | "right" | "center"; format?: PageFormat };
export type PageTableRow = Record<string, string | number | null>;

export type PageLeafBlock =
	| { id: string; type: "heading"; text: string }
	| { id: string; type: "markdown"; text: string }
	| { id: string; type: "stats"; items: PageStat[] }
	| { id: string; type: "chart"; spec: ChartSpec }
	| { id: string; type: "bar_list"; items: PageBarItem[]; unit?: string }
	| { id: string; type: "table"; columns: PageTableColumn[]; rows: PageTableRow[] };
export type PageTab = { id: string; label: string; blocks: PageLeafBlock[] };
export type PageTabsBlock = { id: string; type: "tabs"; tabs: PageTab[] };
export type PageBlock = PageLeafBlock | PageTabsBlock;

export type PageSpec = { v: 1; title: string; summary?: string; blocks: PageBlock[] };
export type PageSource = { title: string; url?: string };

export type PageSpecParse = { ok: true; spec: PageSpec } | { ok: false; error: string };

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Id estável: minúsculo, `a-z0-9_-`, até 40 caracteres. */
export function slugifyPageId(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

type Ctx = { ids: Set<string>; blocks: number; charts: number; auto: number };

function takeId(ctx: Ctx, raw: unknown, fallbackBase: string, where: string): string | Fail {
	let id: string;
	if (raw === undefined || raw === null || raw === "") {
		do {
			ctx.auto += 1;
			id = `${fallbackBase}-${ctx.auto}`;
		} while (ctx.ids.has(id));
	} else {
		if (typeof raw !== "string") return fail(`${where}.id must be a string`);
		id = slugifyPageId(raw);
		if (!id) return fail(`${where}.id must contain letters or digits`);
		if (ctx.ids.has(id)) return fail(`duplicate id "${id}" (${where}); block ids must be unique across the page`);
	}
	ctx.ids.add(id);
	return id;
}

function parseFormat(value: unknown, where: string): PageFormat | undefined | Fail {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !(PAGE_FORMATS as readonly string[]).includes(value)) {
		return fail(`${where}.format must be one of: ${PAGE_FORMATS.join(", ")}`);
	}
	return value as PageFormat;
}

function parseStats(row: Record<string, unknown>, where: string): PageStat[] | Fail {
	if (!Array.isArray(row.items) || row.items.length === 0) return fail(`${where}.items must be a non-empty array of { label, value }`);
	if (row.items.length > PAGE_MAX_STATS) return fail(`${where}.items has too many entries (max ${PAGE_MAX_STATS})`);
	const items: PageStat[] = [];
	for (const [i, entry] of row.items.entries()) {
		const at = `${where}.items[${i}]`;
		if (!isRecord(entry)) return fail(`${at} must be an object`);
		const label = text(entry.label, 60);
		if (!label) return fail(`${at}.label is required`);
		const value = entry.value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return fail(`${at}.value must be a finite number or a string`);
		} else if (typeof value !== "string" || !value.trim()) {
			return fail(`${at}.value must be a number or a non-empty string`);
		}
		const format = parseFormat(entry.format, at);
		if (format && typeof format === "object") return format;
		const unit = text(entry.unit, 12);
		let delta: PageStatDelta | undefined;
		if (entry.delta !== undefined && entry.delta !== null) {
			if (!isRecord(entry.delta)) return fail(`${at}.delta must be { value, direction, label? }`);
			const dv = entry.delta.value;
			if (!((typeof dv === "number" && Number.isFinite(dv)) || (typeof dv === "string" && dv.trim()))) {
				return fail(`${at}.delta.value must be a number or a string`);
			}
			const dir = entry.delta.direction;
			if (dir !== "up" && dir !== "down" && dir !== "flat") return fail(`${at}.delta.direction must be "up", "down" or "flat"`);
			const dl = text(entry.delta.label, 40);
			delta = { value: typeof dv === "string" ? dv.trim().slice(0, 24) : dv, direction: dir, ...(dl ? { label: dl } : {}) };
		}
		items.push({
			label,
			value: typeof value === "string" ? value.trim().slice(0, 40) : value,
			...(unit ? { unit } : {}),
			...(format ? { format } : {}),
			...(delta ? { delta } : {}),
		});
	}
	return items;
}

function parseBarList(row: Record<string, unknown>, where: string): { items: PageBarItem[]; unit?: string } | Fail {
	if (!Array.isArray(row.items) || row.items.length === 0) return fail(`${where}.items must be a non-empty array of { label, value }`);
	if (row.items.length > PAGE_MAX_BAR_ITEMS) return fail(`${where}.items has too many entries (max ${PAGE_MAX_BAR_ITEMS})`);
	const items: PageBarItem[] = [];
	for (const [i, entry] of row.items.entries()) {
		const at = `${where}.items[${i}]`;
		if (!isRecord(entry)) return fail(`${at} must be an object`);
		const label = text(entry.label, 80);
		if (!label) return fail(`${at}.label is required`);
		if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) return fail(`${at}.value must be a number`);
		const display = text(entry.display, 40);
		items.push({ label, value: entry.value, ...(display ? { display } : {}) });
	}
	const unit = text(row.unit, 12);
	return { items, ...(unit ? { unit } : {}) };
}

function parseTable(row: Record<string, unknown>, where: string): { columns: PageTableColumn[]; rows: PageTableRow[] } | Fail {
	if (!Array.isArray(row.columns) || row.columns.length === 0) return fail(`${where}.columns must be a non-empty array of { key, label }`);
	if (row.columns.length > PAGE_MAX_TABLE_COLUMNS) return fail(`${where}.columns has too many entries (max ${PAGE_MAX_TABLE_COLUMNS})`);
	const columns: PageTableColumn[] = [];
	for (const [i, entry] of row.columns.entries()) {
		const at = `${where}.columns[${i}]`;
		if (!isRecord(entry)) return fail(`${at} must be an object`);
		const key = text(entry.key, 64);
		if (!key) return fail(`${at}.key is required`);
		if (columns.some((c) => c.key === key)) return fail(`${at}: duplicate column key "${key}"`);
		const align = entry.align;
		if (align !== undefined && align !== "left" && align !== "right" && align !== "center") return fail(`${at}.align must be left, right or center`);
		const format = parseFormat(entry.format, at);
		if (format && typeof format === "object") return format;
		columns.push({ key, label: text(entry.label, 60) ?? key, ...(align ? { align } : {}), ...(format ? { format } : {}) });
	}
	if (!Array.isArray(row.rows)) return fail(`${where}.rows must be an array of row objects`);
	if (row.rows.length > PAGE_MAX_TABLE_ROWS) return fail(`${where}.rows has too many rows (max ${PAGE_MAX_TABLE_ROWS})`);
	const rows: PageTableRow[] = [];
	for (const [i, entry] of row.rows.entries()) {
		if (!isRecord(entry)) return fail(`${where}.rows[${i}] must be an object keyed by column key`);
		const out: PageTableRow = {};
		for (const col of columns) {
			const cell = entry[col.key];
			if (cell === undefined || cell === null) out[col.key] = null;
			else if (typeof cell === "number") {
				if (!Number.isFinite(cell)) return fail(`${where}.rows[${i}].${col.key} must be a finite number`);
				out[col.key] = cell;
			} else if (typeof cell === "string") out[col.key] = cell.slice(0, 200);
			else return fail(`${where}.rows[${i}].${col.key} must be a string, number or null`);
		}
		rows.push(out);
	}
	return { columns, rows };
}

function parseBlock(raw: unknown, ctx: Ctx, where: string, inTab: boolean): PageBlock | Fail {
	if (!isRecord(raw)) return fail(`${where} must be an object with a "type"`);
	const type = raw.type;
	if (typeof type !== "string" || !(PAGE_BLOCK_TYPES as readonly string[]).includes(type)) {
		return fail(`${where}.type must be one of: ${PAGE_BLOCK_TYPES.join(", ")}`);
	}
	if (type === "tabs" && inTab) return fail(`${where}: tabs cannot be nested inside tabs (one level only)`);
	ctx.blocks += 1;
	if (ctx.blocks > PAGE_MAX_BLOCKS) return fail(`too many blocks (max ${PAGE_MAX_BLOCKS} in total, tab contents included)`);
	const id = takeId(ctx, raw.id, type.replace("_", "-"), where);
	if (typeof id !== "string") return id;

	switch (type) {
		case "heading": {
			const value = text(raw.text, 160);
			if (!value) return fail(`${where}.text is required for a heading`);
			return { id, type, text: value };
		}
		case "markdown": {
			const value = text(raw.text, Number.MAX_SAFE_INTEGER);
			if (!value) return fail(`${where}.text is required for a markdown block`);
			if (value.length > PAGE_MAX_MARKDOWN_CHARS) return fail(`${where}.text is too long (max ${PAGE_MAX_MARKDOWN_CHARS} characters); split it into several blocks`);
			return { id, type, text: value };
		}
		case "stats": {
			const items = parseStats(raw, where);
			return Array.isArray(items) ? { id, type, items } : items;
		}
		case "chart": {
			ctx.charts += 1;
			if (ctx.charts > PAGE_MAX_CHARTS) return fail(`too many charts (max ${PAGE_MAX_CHARTS} per page)`);
			const parsed = parseChartSpec(raw.spec);
			if (!parsed.ok) return fail(`${where}.spec: ${parsed.error}`);
			return { id, type, spec: parsed.spec };
		}
		case "bar_list": {
			const parsed = parseBarList(raw, where);
			return "ok" in parsed ? parsed : { id, type, ...parsed };
		}
		case "table": {
			const parsed = parseTable(raw, where);
			return "ok" in parsed ? parsed : { id, type, ...parsed };
		}
		default: {
			if (!Array.isArray(raw.tabs)) return fail(`${where}.tabs must be an array of { label, blocks }`);
			if (raw.tabs.length < PAGE_MIN_TABS || raw.tabs.length > PAGE_MAX_TABS) {
				return fail(`${where}.tabs must have between ${PAGE_MIN_TABS} and ${PAGE_MAX_TABS} tabs`);
			}
			const tabs: PageTab[] = [];
			const tabIds = new Set<string>();
			for (const [t, entry] of raw.tabs.entries()) {
				const at = `${where}.tabs[${t}]`;
				if (!isRecord(entry)) return fail(`${at} must be an object`);
				const label = text(entry.label, 40);
				if (!label) return fail(`${at}.label is required`);
				const tabId = slugifyPageId(typeof entry.id === "string" ? entry.id : label) || `tab-${t + 1}`;
				if (tabIds.has(tabId)) return fail(`${at}: duplicate tab id "${tabId}"`);
				tabIds.add(tabId);
				if (!Array.isArray(entry.blocks) || entry.blocks.length === 0) return fail(`${at}.blocks must be a non-empty array`);
				const blocks: PageLeafBlock[] = [];
				for (const [b, child] of entry.blocks.entries()) {
					const parsed = parseBlock(child, ctx, `${at}.blocks[${b}]`, true);
					if ("ok" in parsed) return parsed;
					blocks.push(parsed as PageLeafBlock);
				}
				tabs.push({ id: tabId, label, blocks });
			}
			return { id, type: "tabs", tabs };
		}
	}
}

/** Valida e normaliza a página (aceita o texto JSON ou o objeto já lido). Não inclui as fontes (ver `parsePageSources`). */
export function parsePageSpec(input: unknown): PageSpecParse {
	let raw = input;
	if (typeof input === "string") {
		if (input.length > PAGE_MAX_JSON_CHARS) return fail(`page spec too large (max ${PAGE_MAX_JSON_CHARS} characters)`);
		try {
			raw = JSON.parse(input) as unknown;
		} catch {
			return fail("page spec is not valid JSON");
		}
	} else if (input !== undefined && input !== null) {
		try {
			if (JSON.stringify(input).length > PAGE_MAX_JSON_CHARS) return fail(`page spec too large (max ${PAGE_MAX_JSON_CHARS} characters)`);
		} catch {
			return fail("page spec is not serializable JSON");
		}
	}
	if (!isRecord(raw)) return fail("page spec must be a JSON object { title, summary?, blocks }");
	if (raw.v !== undefined && raw.v !== 1) return fail("page spec v must be 1");
	const title = text(raw.title, 120);
	if (!title) return fail("title is required (short, up to 120 characters)");
	if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) return fail("blocks must be a non-empty array");
	const ctx: Ctx = { ids: new Set(), blocks: 0, charts: 0, auto: 0 };
	const blocks: PageBlock[] = [];
	for (const [i, entry] of raw.blocks.entries()) {
		const parsed = parseBlock(entry, ctx, `blocks[${i}]`, false);
		if ("ok" in parsed) return parsed;
		blocks.push(parsed);
	}
	const summary = text(raw.summary, 400);
	return { ok: true, spec: { v: 1, title, ...(summary ? { summary } : {}), blocks } };
}

export type PageSourcesParse = { ok: true; sources: PageSource[] } | { ok: false; error: string };

function safeHttpUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString().slice(0, 500) : undefined;
	} catch {
		return undefined;
	}
}

/** Fontes da página (título + URL http(s) opcional), até 20; `undefined` = lista vazia. */
export function parsePageSources(input: unknown): PageSourcesParse {
	if (input === undefined || input === null) return { ok: true, sources: [] };
	if (!Array.isArray(input)) return fail("sources must be an array of { title, url? }");
	if (input.length > PAGE_MAX_SOURCES) return fail(`too many sources (max ${PAGE_MAX_SOURCES})`);
	const sources: PageSource[] = [];
	for (const [i, entry] of input.entries()) {
		if (!isRecord(entry)) return fail(`sources[${i}] must be { title, url? }`);
		const url = typeof entry.url === "string" && entry.url.trim() ? safeHttpUrl(entry.url.trim()) : undefined;
		if (typeof entry.url === "string" && entry.url.trim() && !url) return fail(`sources[${i}].url must be an http(s) URL`);
		const title = text(entry.title, 160) ?? (url ? new URL(url).hostname : undefined);
		if (!title) return fail(`sources[${i}].title is required`);
		if (sources.some((s) => s.title === title && s.url === url)) continue;
		sources.push({ title, ...(url ? { url } : {}) });
	}
	return { ok: true, sources };
}

/** Passa por todos os blocos (inclusive os dentro de abas). */
export function walkPageBlocks(blocks: readonly PageBlock[], visit: (block: PageBlock) => void): void {
	for (const block of blocks) {
		visit(block);
		if (block.type === "tabs") for (const tab of block.tabs) walkPageBlocks(tab.blocks, visit);
	}
}

export function countPageBlocks(spec: PageSpec): { blocks: number; charts: number } {
	let blocks = 0;
	let charts = 0;
	walkPageBlocks(spec.blocks, (block) => {
		blocks += 1;
		if (block.type === "chart") charts += 1;
	});
	return { blocks, charts };
}

/** Resumo curto para o resultado da tool e para a memória do modelo. */
export function summarizePageSpec(spec: PageSpec): string {
	const counts = new Map<string, number>();
	walkPageBlocks(spec.blocks, (block) => counts.set(block.type, (counts.get(block.type) ?? 0) + 1));
	const parts = [...counts.entries()].map(([type, n]) => `${n} ${type}`);
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	return `Page "${spec.title}": ${total} block${total === 1 ? "" : "s"} (${parts.join(", ")})`;
}

export type PagePatchOp =
	| { op: "replace"; id: string; block: unknown }
	| { op: "insert_after"; id?: string; block: unknown }
	| { op: "remove"; id: string };

export const PAGE_MAX_PATCH_OPS = 20;

/** Valida os ops vindos do modelo (forma, não o conteúdo do bloco: isso é do `parsePageSpec`). */
export function parsePagePatchOps(input: unknown): { ok: true; ops: PagePatchOp[] } | Fail {
	if (!Array.isArray(input) || input.length === 0) return fail("ops must be a non-empty array of { op, id, block? }");
	if (input.length > PAGE_MAX_PATCH_OPS) return fail(`too many ops (max ${PAGE_MAX_PATCH_OPS})`);
	const ops: PagePatchOp[] = [];
	for (const [i, entry] of input.entries()) {
		if (!isRecord(entry)) return fail(`ops[${i}] must be an object`);
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (entry.op === "remove") {
			if (!id) return fail(`ops[${i}].id is required for remove`);
			ops.push({ op: "remove", id });
		} else if (entry.op === "replace") {
			if (!id) return fail(`ops[${i}].id is required for replace`);
			if (!isRecord(entry.block)) return fail(`ops[${i}].block is required for replace`);
			ops.push({ op: "replace", id, block: entry.block });
		} else if (entry.op === "insert_after") {
			if (!isRecord(entry.block)) return fail(`ops[${i}].block is required for insert_after`);
			ops.push({ op: "insert_after", ...(id ? { id } : {}), block: entry.block });
		} else {
			return fail(`ops[${i}].op must be replace, insert_after or remove`);
		}
	}
	return { ok: true, ops };
}

type Located = { list: PageBlock[]; index: number };

function locate(blocks: PageBlock[], id: string): Located | undefined {
	for (const [index, block] of blocks.entries()) {
		if (block.id === id) return { list: blocks, index };
		if (block.type === "tabs") {
			for (const tab of block.tabs) {
				const found = locate(tab.blocks, id);
				if (found) return found;
			}
		}
	}
	return undefined;
}

/**
 * Aplica ops por id de bloco (replace | insert_after | remove) e revalida a página inteira:
 * o resultado respeita os mesmos limites do `parsePageSpec`. Não muta o `spec` recebido.
 */
export function applyPagePatch(spec: PageSpec, ops: readonly PagePatchOp[]): PageSpecParse {
	const draft = structuredClone(spec) as PageSpec;
	for (const [i, op] of ops.entries()) {
		if (op.op === "insert_after" && !op.id) {
			draft.blocks.push(op.block as PageBlock);
			continue;
		}
		const found = locate(draft.blocks, op.id!);
		if (!found) return fail(`ops[${i}]: no block with id "${op.id}" (use page_read to see the current ids)`);
		if (op.op === "remove") found.list.splice(found.index, 1);
		else if (op.op === "replace") {
			const block = op.block as Record<string, unknown>;
			found.list[found.index] = { ...block, id: typeof block.id === "string" && block.id ? block.id : op.id } as PageBlock;
		} else found.list.splice(found.index + 1, 0, op.block as PageBlock);
	}
	return parsePageSpec(draft);
}
