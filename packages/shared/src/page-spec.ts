/**
 * Especificação de "Página" (v2): um relatório/painel vivo que o bot COMPÕE como uma árvore de componentes
 * pré-prontos (UI generativa declarativa: JSON validado contra uma lista fixa, nunca HTML nem JS do modelo).
 * Cada nó tem `id` estável para o bot atualizar só uma parte (`applyPagePatch`).
 *
 * ```json
 * { "v": 2, "title": "Forecast Q4", "palette": "grove",
 *   "root": { "type": "stack", "children": [
 *     { "type": "grid", "props": { "cols": 2 }, "children": [
 *       { "type": "stat", "props": { "label": "Receita", "value": 120000, "unit": "BRL" } } ] } ] } }
 * ```
 * Páginas v1 (`{ blocks: [...] }`) continuam válidas: `parsePageSpec` converte para v2 na leitura.
 * As mensagens de erro vão para o modelo (inglês, acionáveis, com as props válidas de cada componente).
 */
import { CHART_CUSTOM_COLORS_MAX, CHART_PALETTES, normalizeChartHexColor, parseChartSpec, type ChartPalette, type ChartSpec } from "./chart-spec.js";

export const PAGE_MAX_JSON_CHARS = 200_000;
export const PAGE_MAX_NODES = 120;
export const PAGE_MAX_DEPTH = 6;
export const PAGE_MAX_CHARTS = 8;
export const PAGE_MAX_MARKDOWN_CHARS = 4000;
export const PAGE_MAX_BAR_ITEMS = 30;
export const PAGE_MAX_TABLE_COLUMNS = 10;
export const PAGE_MAX_TABLE_ROWS = 100;
export const PAGE_MAX_LIST_ITEMS = 30;
export const PAGE_MAX_TIMELINE_ITEMS = 30;
export const PAGE_MAX_KANBAN_COLUMNS = 6;
export const PAGE_MAX_KANBAN_ITEMS = 20;
export const PAGE_MIN_TABS = 2;
export const PAGE_MAX_TABS = 6;
export const PAGE_MAX_SOURCES = 20;
/** Limites das páginas v1 já gravadas (um bloco `stats` virava até 9 nós; não devem quebrar na conversão). */
const LEGACY_MAX_NODES = 400;

export const PAGE_FORMATS = ["number", "compact", "percent", "currency"] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];
export const PAGE_TONES = ["neutral", "positive", "warning", "critical", "accent"] as const;
export type PageTone = (typeof PAGE_TONES)[number];
export const PAGE_CALLOUT_TONES = ["info", "success", "warning", "critical"] as const;
export type PageCalloutTone = (typeof PAGE_CALLOUT_TONES)[number];
export const PAGE_GAPS = ["sm", "md", "lg"] as const;
export type PageGap = (typeof PAGE_GAPS)[number];

export const PAGE_NODE_TYPES = [
	"section", "grid", "stack", "card", "tabs", "tab", "divider",
	"stat", "chart", "bar_list", "table", "progress", "badge", "callout", "timeline", "kanban", "list", "text", "heading",
] as const;
export type PageNodeType = (typeof PAGE_NODE_TYPES)[number];
/** Componentes que têm filhos (o resto é folha). */
const CONTAINER_TYPES: readonly PageNodeType[] = ["section", "grid", "stack", "card", "tabs", "tab"];

/** Paletas prontas (as mesmas dos gráficos) ou até 6 cores hex próprias. */
export type PagePresetPalette = Exclude<ChartPalette, "custom">;
export type PagePalette = PagePresetPalette | { colors: string[] };
export const PAGE_PRESET_PALETTES: readonly PagePresetPalette[] = CHART_PALETTES.filter((p): p is PagePresetPalette => p !== "custom");

export type PageStatDelta = { value: number | string; kind?: "percent" | "absolute"; direction: "up" | "down" | "flat"; label?: string };
export type PageBarItem = { label: string; value: number; display?: string };
export type PageTableColumn = { key: string; label: string; align?: "left" | "right" | "center"; format?: PageFormat; unit?: string };
export type PageTableRow = Record<string, string | number | null>;
export type PageTimelineItem = { date: string; title: string; text?: string; tone?: PageTone };
export type PageKanbanItem = { title: string; subtitle?: string; badge?: string };
export type PageKanbanColumn = { title: string; items: PageKanbanItem[] };
export type PageListItem = { title: string; subtitle?: string; value?: number | string; tone?: PageTone };

type WithSpan = { span?: number };
export type PageNodePropsMap = {
	section: WithSpan & { title?: string; description?: string };
	grid: WithSpan & { cols: number; gap?: PageGap };
	stack: WithSpan & { direction?: "vertical" | "horizontal"; gap?: PageGap };
	card: WithSpan & { title?: string; variant?: "plain" | "outlined" | "filled"; tone?: PageTone };
	tabs: WithSpan & { tabs: Array<{ id: string; label: string }> };
	/** `tab` = id da aba declarada em `tabs.props.tabs`. */
	tab: { tab: string };
	divider: WithSpan;
	stat: WithSpan & { label: string; value: number | string; unit?: string; format?: PageFormat; delta?: PageStatDelta; size?: "sm" | "md" | "lg"; tone?: PageTone };
	chart: WithSpan & { spec: ChartSpec };
	bar_list: WithSpan & { items: PageBarItem[]; unit?: string; format?: PageFormat; tone?: PageTone };
	table: WithSpan & { columns: PageTableColumn[]; rows: PageTableRow[]; variant?: "default" | "compact" | "striped" };
	progress: WithSpan & { label: string; value: number; max: number; unit?: string; format?: PageFormat; tone?: PageTone };
	badge: WithSpan & { text: string; tone: PageTone };
	callout: WithSpan & { title?: string; text: string; tone: PageCalloutTone };
	timeline: WithSpan & { items: PageTimelineItem[] };
	kanban: WithSpan & { columns: PageKanbanColumn[] };
	list: WithSpan & { items: PageListItem[]; unit?: string; format?: PageFormat };
	text: WithSpan & { markdown: string };
	heading: WithSpan & { text: string; level?: 1 | 2 | 3 };
};

type NodeOf<T extends PageNodeType> = { id: string; type: T; props: PageNodePropsMap[T]; children?: PageNode[] };
export type PageNode = { [T in PageNodeType]: NodeOf<T> }[PageNodeType];

export type PageSpec = { v: 2; title: string; summary?: string; palette?: PagePalette; root: PageNode };
export type PageSource = { title: string; url?: string };

export type PageSpecParse = { ok: true; spec: PageSpec } | { ok: false; error: string };

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const isFail = (value: unknown): value is Fail => !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false && "error" in value;

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

type Ctx = { ids: Set<string>; nodes: number; charts: number; auto: number; maxNodes: number };

function takeId(ctx: Ctx, raw: unknown, fallbackBase: string, where: string, preferred?: string): string | Fail {
	let id: string;
	if (raw === undefined || raw === null || raw === "") {
		if (preferred && !ctx.ids.has(preferred)) id = preferred;
		else {
			do {
				ctx.auto += 1;
				id = `${fallbackBase}-${ctx.auto}`;
			} while (ctx.ids.has(id));
		}
	} else {
		if (typeof raw !== "string") return fail(`${where}.id must be a string`);
		id = slugifyPageId(raw);
		if (!id) return fail(`${where}.id must contain letters or digits`);
		if (ctx.ids.has(id)) return fail(`duplicate id "${id}" (${where}); node ids must be unique across the page`);
	}
	ctx.ids.add(id);
	return id;
}

// ---- Props de cada componente ----

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T | undefined | Fail {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) return fail(`${where} must be one of: ${allowed.join(", ")}`);
	return value as T;
}

/** Atribui só o que veio definido (e repassa o primeiro erro). */
function optional<T extends object>(out: T, entries: Record<string, unknown>): T | Fail {
	for (const [key, value] of Object.entries(entries)) {
		if (isFail(value)) return value;
		if (value !== undefined) (out as Record<string, unknown>)[key] = value;
	}
	return out;
}

function numOrText(value: unknown, where: string, max = 40): number | string | Fail {
	if (typeof value === "number") return Number.isFinite(value) ? value : fail(`${where} must be a finite number or a string`);
	if (typeof value === "string" && value.trim()) return value.trim().slice(0, max);
	return fail(`${where} must be a number or a non-empty string`);
}

function listOf(value: unknown, where: string, max: number, shape: string): unknown[] | Fail {
	if (!Array.isArray(value) || value.length === 0) return fail(`${where} must be a non-empty array of ${shape}`);
	if (value.length > max) return fail(`${where} has too many entries (max ${max})`);
	return value;
}

function parseDelta(raw: unknown, where: string): PageStatDelta | undefined | Fail {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecord(raw)) return fail(`${where} must be { value, direction: up|down|flat, kind?: percent|absolute, label? }`);
	const value = numOrText(raw.value, `${where}.value`, 24);
	if (isFail(value)) return value;
	const direction = oneOf(raw.direction, ["up", "down", "flat"] as const, `${where}.direction`);
	if (direction === undefined || isFail(direction)) return isFail(direction) ? direction : fail(`${where}.direction is required (up, down or flat)`);
	const kind = oneOf(raw.kind, ["percent", "absolute"] as const, `${where}.kind`);
	if (isFail(kind)) return kind;
	const label = text(raw.label, 40);
	return { value, direction, ...(kind ? { kind } : {}), ...(label ? { label } : {}) };
}

function parseTableProps(p: Record<string, unknown>, where: string): PageNodePropsMap["table"] | Fail {
	const cols = listOf(p.columns, `${where}.columns`, PAGE_MAX_TABLE_COLUMNS, "{ key, label }");
	if (isFail(cols)) return cols;
	const columns: PageTableColumn[] = [];
	for (const [i, entry] of cols.entries()) {
		const at = `${where}.columns[${i}]`;
		if (!isRecord(entry)) return fail(`${at} must be an object`);
		const key = text(entry.key, 64);
		if (!key) return fail(`${at}.key is required`);
		if (columns.some((c) => c.key === key)) return fail(`${at}: duplicate column key "${key}"`);
		const align = oneOf(entry.align, ["left", "right", "center"] as const, `${at}.align`);
		const format = oneOf(entry.format, PAGE_FORMATS, `${at}.format`);
		const col = optional<PageTableColumn>({ key, label: text(entry.label, 60) ?? key }, { align, format, unit: text(entry.unit, 12) });
		if (isFail(col)) return col;
		columns.push(col);
	}
	if (!Array.isArray(p.rows)) return fail(`${where}.rows must be an array of row objects keyed by column key`);
	if (p.rows.length > PAGE_MAX_TABLE_ROWS) return fail(`${where}.rows has too many rows (max ${PAGE_MAX_TABLE_ROWS})`);
	const rows: PageTableRow[] = [];
	for (const [i, entry] of p.rows.entries()) {
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
	const variant = oneOf(p.variant, ["default", "compact", "striped"] as const, `${where}.variant`);
	return optional({ columns, rows }, { variant }) as PageNodePropsMap["table"] | Fail;
}

type Parsed<T> = T | Fail;

const PROP_PARSERS: { [K in Exclude<PageNodeType, "chart" | "tabs" | "tab">]: (p: Record<string, unknown>, where: string) => Parsed<PageNodePropsMap[K]> } = {
	section: (p) => optional({}, { title: text(p.title, 120), description: text(p.description, 300) }),
	grid: (p, where) => {
		const cols = p.cols === undefined ? 2 : p.cols;
		if (typeof cols !== "number" || !Number.isInteger(cols) || cols < 1 || cols > 4) return fail(`${where}.cols must be an integer from 1 to 4`);
		return optional({ cols }, { gap: oneOf(p.gap, PAGE_GAPS, `${where}.gap`) });
	},
	stack: (p, where) => optional({}, { direction: oneOf(p.direction, ["vertical", "horizontal"] as const, `${where}.direction`), gap: oneOf(p.gap, PAGE_GAPS, `${where}.gap`) }),
	card: (p, where) => optional({}, { title: text(p.title, 120), variant: oneOf(p.variant, ["plain", "outlined", "filled"] as const, `${where}.variant`), tone: oneOf(p.tone, PAGE_TONES, `${where}.tone`) }),
	divider: () => ({}),
	stat: (p, where) => {
		const label = text(p.label, 60);
		if (!label) return fail(`${where}.label is required (short, up to 60 characters)`);
		const value = numOrText(p.value, `${where}.value`);
		if (isFail(value)) return value;
		return optional({ label, value }, {
			unit: text(p.unit, 12),
			format: oneOf(p.format, PAGE_FORMATS, `${where}.format`),
			delta: parseDelta(p.delta, `${where}.delta`),
			size: oneOf(p.size, ["sm", "md", "lg"] as const, `${where}.size`),
			tone: oneOf(p.tone, PAGE_TONES, `${where}.tone`),
		});
	},
	bar_list: (p, where) => {
		const list = listOf(p.items, `${where}.items`, PAGE_MAX_BAR_ITEMS, "{ label, value }");
		if (isFail(list)) return list;
		const items: PageBarItem[] = [];
		for (const [i, entry] of list.entries()) {
			const at = `${where}.items[${i}]`;
			if (!isRecord(entry)) return fail(`${at} must be an object`);
			const label = text(entry.label, 80);
			if (!label) return fail(`${at}.label is required`);
			if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) return fail(`${at}.value must be a number`);
			const display = text(entry.display, 40);
			items.push({ label, value: entry.value, ...(display ? { display } : {}) });
		}
		return optional({ items }, { unit: text(p.unit, 12), format: oneOf(p.format, PAGE_FORMATS, `${where}.format`), tone: oneOf(p.tone, PAGE_TONES, `${where}.tone`) });
	},
	table: parseTableProps,
	progress: (p, where) => {
		const label = text(p.label, 80);
		if (!label) return fail(`${where}.label is required`);
		if (typeof p.value !== "number" || !Number.isFinite(p.value)) return fail(`${where}.value must be a number`);
		if (typeof p.max !== "number" || !Number.isFinite(p.max) || p.max <= 0) return fail(`${where}.max must be a number greater than 0 (the goal)`);
		return optional({ label, value: p.value, max: p.max }, { unit: text(p.unit, 12), format: oneOf(p.format, PAGE_FORMATS, `${where}.format`), tone: oneOf(p.tone, PAGE_TONES, `${where}.tone`) });
	},
	badge: (p, where) => {
		const value = text(p.text, 40);
		if (!value) return fail(`${where}.text is required (up to 40 characters)`);
		const tone = oneOf(p.tone, PAGE_TONES, `${where}.tone`);
		return isFail(tone) ? tone : { text: value, tone: tone ?? "neutral" };
	},
	callout: (p, where) => {
		const value = text(p.text, 600);
		if (!value) return fail(`${where}.text is required (up to 600 characters)`);
		const tone = oneOf(p.tone, PAGE_CALLOUT_TONES, `${where}.tone`);
		if (isFail(tone)) return tone;
		return optional({ text: value, tone: tone ?? "info" }, { title: text(p.title, 120) });
	},
	timeline: (p, where) => {
		const list = listOf(p.items, `${where}.items`, PAGE_MAX_TIMELINE_ITEMS, "{ date, title, text?, tone? }");
		if (isFail(list)) return list;
		const items: PageTimelineItem[] = [];
		for (const [i, entry] of list.entries()) {
			const at = `${where}.items[${i}]`;
			if (!isRecord(entry)) return fail(`${at} must be an object`);
			const date = text(entry.date, 30);
			const title = text(entry.title, 120);
			if (!date || !title) return fail(`${at} needs date (display text such as "12/11") and title`);
			const item = optional<PageTimelineItem>({ date, title }, { text: text(entry.text, 300), tone: oneOf(entry.tone, PAGE_TONES, `${at}.tone`) });
			if (isFail(item)) return item;
			items.push(item);
		}
		return { items };
	},
	kanban: (p, where) => {
		const list = listOf(p.columns, `${where}.columns`, PAGE_MAX_KANBAN_COLUMNS, "{ title, items }");
		if (isFail(list)) return list;
		const columns: PageKanbanColumn[] = [];
		for (const [c, entry] of list.entries()) {
			const at = `${where}.columns[${c}]`;
			if (!isRecord(entry)) return fail(`${at} must be an object`);
			const title = text(entry.title, 60);
			if (!title) return fail(`${at}.title is required`);
			if (!Array.isArray(entry.items)) return fail(`${at}.items must be an array of { title, subtitle?, badge? }`);
			if (entry.items.length > PAGE_MAX_KANBAN_ITEMS) return fail(`${at}.items has too many entries (max ${PAGE_MAX_KANBAN_ITEMS})`);
			const items: PageKanbanItem[] = [];
			for (const [i, raw] of entry.items.entries()) {
				if (!isRecord(raw)) return fail(`${at}.items[${i}] must be an object`);
				const itemTitle = text(raw.title, 120);
				if (!itemTitle) return fail(`${at}.items[${i}].title is required`);
				items.push(optional<PageKanbanItem>({ title: itemTitle }, { subtitle: text(raw.subtitle, 120), badge: text(raw.badge, 30) }) as PageKanbanItem);
			}
			columns.push({ title, items });
		}
		return { columns };
	},
	list: (p, where) => {
		const list = listOf(p.items, `${where}.items`, PAGE_MAX_LIST_ITEMS, "{ title, subtitle?, value?, tone? }");
		if (isFail(list)) return list;
		const items: PageListItem[] = [];
		for (const [i, entry] of list.entries()) {
			const at = `${where}.items[${i}]`;
			if (!isRecord(entry)) return fail(`${at} must be an object`);
			const title = text(entry.title, 120);
			if (!title) return fail(`${at}.title is required`);
			const value = entry.value === undefined || entry.value === null ? undefined : numOrText(entry.value, `${at}.value`);
			const item = optional<PageListItem>({ title }, { subtitle: text(entry.subtitle, 120), value, tone: oneOf(entry.tone, PAGE_TONES, `${at}.tone`) });
			if (isFail(item)) return item;
			items.push(item);
		}
		return optional({ items }, { unit: text(p.unit, 12), format: oneOf(p.format, PAGE_FORMATS, `${where}.format`) });
	},
	text: (p, where) => {
		const value = text(p.markdown ?? p.text, Number.MAX_SAFE_INTEGER);
		if (!value) return fail(`${where}.markdown is required for a text node`);
		if (value.length > PAGE_MAX_MARKDOWN_CHARS) return fail(`${where}.markdown is too long (max ${PAGE_MAX_MARKDOWN_CHARS} characters); split it into several text nodes`);
		return { markdown: value };
	},
	heading: (p, where) => {
		const value = text(p.text, 160);
		if (!value) return fail(`${where}.text is required for a heading`);
		const level = p.level === undefined || p.level === null ? undefined : p.level;
		if (level !== undefined && level !== 1 && level !== 2 && level !== 3) return fail(`${where}.level must be 1, 2 or 3`);
		return optional({ text: value }, { level });
	},
};

/** Resumo das props de cada componente, para as mensagens de erro e para as descrições das tools. */
export const PAGE_NODE_GRAMMAR: Record<PageNodeType, string> = {
	section: "{title?, description?} children",
	grid: "{cols:1-4, gap?:sm|md|lg} children (1 col on phones, 2 on tablets); `span` on a child = columns it takes",
	stack: "{direction?:vertical|horizontal, gap?} children",
	card: "{title?, variant?:plain|outlined|filled, tone?} children",
	tabs: "{tabs:[{id,label}]} children = one `tab` node per tab",
	tab: "{tab:<id declared in tabs>} children",
	divider: "{}",
	stat: "{label, value:number|string, unit?, format?, delta?:{value,kind?:percent|absolute,direction:up|down|flat,label?}, size?:sm|md|lg, tone?}",
	chart: "{spec:{type:line|area|bar|pie|composed|radar|funnel|gauge, x, series:[{key,label?}], data:[{...}], unit?, palette?, reference?, forecast?}}",
	bar_list: "{items:[{label,value,display?}] <=30, unit?, format?, tone?}",
	table: "{columns:[{key,label,align?,format?,unit?}] <=10, rows:[{key:value}] <=100, variant?:default|compact|striped}",
	progress: "{label, value, max (goal), unit?, format?, tone?}",
	badge: "{text, tone}",
	callout: "{title?, text, tone:info|success|warning|critical}",
	timeline: "{items:[{date,title,text?,tone?}] <=30}",
	kanban: "{columns:[{title,items:[{title,subtitle?,badge?}]}] <=6 columns}",
	list: "{items:[{title,subtitle?,value?,tone?}] <=30, unit?, format?}",
	text: "{markdown <=4000}",
	heading: "{text, level?:1|2|3}",
};

const KNOWN_NODE_KEYS = new Set(["type", "id", "props", "children"]);

function parseSpan(p: Record<string, unknown>, parent: { type: PageNodeType; cols?: number } | undefined, where: string): number | undefined | Fail {
	if (p.span === undefined || p.span === null) return undefined;
	// `span` só tem efeito dentro de um `grid`; fora dele é ignorado em vez de quebrar a página.
	if (parent?.type !== "grid") return undefined;
	const cols = parent.cols ?? 1;
	if (typeof p.span !== "number" || !Number.isInteger(p.span) || p.span < 1 || p.span > cols) return fail(`${where}.props.span must be an integer from 1 to ${cols} (the grid has ${cols} columns)`);
	return p.span > 1 ? p.span : undefined;
}

type ParentInfo = { type: PageNodeType; cols?: number; tabIds?: string[]; index: number };

function parseNode(raw: unknown, ctx: Ctx, where: string, depth: number, parent?: ParentInfo): PageNode | Fail {
	if (!isRecord(raw)) return fail(`${where} must be an object { type, props?, children? }`);
	const type = raw.type;
	if (typeof type !== "string" || !(PAGE_NODE_TYPES as readonly string[]).includes(type)) {
		return fail(`${where}.type must be one of: ${PAGE_NODE_TYPES.join(", ")}`);
	}
	const t = type as PageNodeType;
	if (depth > PAGE_MAX_DEPTH) return fail(`${where}: the tree is too deep (max ${PAGE_MAX_DEPTH} levels; a tabs node counts two: tabs and tab). Flatten the layout`);
	if (t === "tab" && parent?.type !== "tabs") return fail(`${where}: a "tab" node can only be a direct child of "tabs"`);
	if (parent?.type === "tabs" && t !== "tab") return fail(`${where}: children of "tabs" must be "tab" nodes ({type:"tab", props:{tab:"<id>"}, children:[...]})`);
	ctx.nodes += 1;
	if (ctx.nodes > ctx.maxNodes) return fail(`too many nodes (max ${ctx.maxNodes} in total, children included); merge or drop some components`);
	const id = takeId(ctx, raw.id, t.replace("_", "-"), where, depth === 1 ? "root" : undefined);
	if (typeof id !== "string") return id;

	// Tolerante: props soltas no próprio nó (`{type:"stat", label:"x"}`) valem como `props`.
	const loose: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) if (!KNOWN_NODE_KEYS.has(key)) loose[key] = value;
	if (raw.props !== undefined && raw.props !== null && !isRecord(raw.props)) return fail(`${where}.props must be an object`);
	const p: Record<string, unknown> = { ...loose, ...(isRecord(raw.props) ? raw.props : {}) };

	const span = parseSpan(p, parent, where);
	if (isFail(span)) return span;
	const withSpan = <T extends object>(props: T): T => (span ? { ...props, span } : props);

	const isContainer = CONTAINER_TYPES.includes(t);
	const rawChildren = raw.children;
	if (rawChildren !== undefined && rawChildren !== null && !Array.isArray(rawChildren)) return fail(`${where}.children must be an array of nodes`);
	if (!isContainer && Array.isArray(rawChildren) && rawChildren.length > 0) {
		return fail(`${where}: "${t}" takes no children (only section, grid, stack, card and tabs do); put it inside a container instead`);
	}

	let props: unknown;
	let tabIds: string[] | undefined;
	if (t === "chart") {
		ctx.charts += 1;
		if (ctx.charts > PAGE_MAX_CHARTS) return fail(`too many charts (max ${PAGE_MAX_CHARTS} per page)`);
		const parsed = parseChartSpec(p.spec);
		if (!parsed.ok) return fail(`${where}.props.spec: ${parsed.error}`);
		props = withSpan({ spec: parsed.spec });
	} else if (t === "tabs") {
		const list = listOf(p.tabs, `${where}.props.tabs`, PAGE_MAX_TABS, "{ id, label }");
		if (isFail(list)) return list;
		if (list.length < PAGE_MIN_TABS) return fail(`${where}.props.tabs must have between ${PAGE_MIN_TABS} and ${PAGE_MAX_TABS} tabs`);
		const tabs: Array<{ id: string; label: string }> = [];
		for (const [i, entry] of list.entries()) {
			const at = `${where}.props.tabs[${i}]`;
			if (!isRecord(entry)) return fail(`${at} must be { id, label }`);
			const label = text(entry.label, 40);
			if (!label) return fail(`${at}.label is required`);
			const tabId = slugifyPageId(typeof entry.id === "string" ? entry.id : label) || `tab-${i + 1}`;
			if (tabs.some((tab) => tab.id === tabId)) return fail(`${at}: duplicate tab id "${tabId}"`);
			tabs.push({ id: tabId, label });
		}
		tabIds = tabs.map((tab) => tab.id);
		props = withSpan({ tabs });
	} else if (t === "tab") {
		const declared = parent?.tabIds ?? [];
		const wanted = typeof p.tab === "string" && p.tab.trim() ? slugifyPageId(p.tab) : declared[parent?.index ?? 0];
		if (!wanted || !declared.includes(wanted)) return fail(`${where}.props.tab must be one of the ids declared in tabs.props.tabs: ${declared.join(", ")}`);
		props = { tab: wanted };
	} else {
		const parsed = PROP_PARSERS[t](p, `${where}.props`);
		if (isFail(parsed)) return parsed;
		props = withSpan(parsed);
	}

	const node = { id, type: t, props } as PageNode;
	if (!isContainer) return node;
	if (!Array.isArray(rawChildren) || rawChildren.length === 0) {
		return fail(t === "tabs" ? `${where}.children must hold one "tab" node per declared tab` : `${where}.children must be a non-empty array (a ${t} without content is useless)`);
	}
	const info: ParentInfo = { type: t, ...(t === "grid" ? { cols: (props as PageNodePropsMap["grid"]).cols } : {}), ...(tabIds ? { tabIds } : {}), index: 0 };
	const children: PageNode[] = [];
	const usedTabs = new Set<string>();
	for (const [i, child] of rawChildren.entries()) {
		const parsed = parseNode(child, ctx, `${where}.children[${i}]`, depth + 1, { ...info, index: i });
		if (isFail(parsed)) return parsed;
		if (parsed.type === "tab") {
			if (usedTabs.has(parsed.props.tab)) return fail(`${where}.children[${i}]: tab "${parsed.props.tab}" is used twice`);
			usedTabs.add(parsed.props.tab);
		}
		children.push(parsed);
	}
	if (t === "tabs" && tabIds && usedTabs.size !== tabIds.length) {
		return fail(`${where}: tabs declares ${tabIds.length} tabs (${tabIds.join(", ")}) but has ${usedTabs.size} "tab" children; keep them in sync`);
	}
	node.children = children;
	return node;
}

// ---- Paleta ----

function parsePalette(raw: unknown): PagePalette | undefined | Fail {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw === "string") {
		if ((PAGE_PRESET_PALETTES as readonly string[]).includes(raw)) return raw as PagePresetPalette;
		return fail(`palette must be one of: ${PAGE_PRESET_PALETTES.join(", ")}, or { colors: ["#rrggbb", ...] } (1-${CHART_CUSTOM_COLORS_MAX} hex colors)`);
	}
	if (isRecord(raw) && Array.isArray(raw.colors)) {
		if (raw.colors.length < 1 || raw.colors.length > CHART_CUSTOM_COLORS_MAX) return fail(`palette.colors needs 1 to ${CHART_CUSTOM_COLORS_MAX} colors`);
		const colors: string[] = [];
		for (const [i, entry] of raw.colors.entries()) {
			const hex = normalizeChartHexColor(entry);
			if (!hex) return fail(`palette.colors[${i}] must be a hex color like #2563eb`);
			colors.push(hex);
		}
		return { colors };
	}
	return fail(`palette must be one of: ${PAGE_PRESET_PALETTES.join(", ")}, or { colors: ["#rrggbb", ...] }`);
}

// ---- v1 → v2 ----

type Raw = Record<string, unknown>;

/** Bloco v1 → nó v2 (mesmo id; filhos gerados recebem id automático). */
function blockToNode(block: unknown): Raw {
	if (!isRecord(block)) return { type: "invalid" };
	const id = block.id;
	switch (block.type) {
		case "heading":
			return { id, type: "heading", props: { text: block.text, level: 2 } };
		case "markdown":
			return { id, type: "text", props: { markdown: block.text } };
		case "stats": {
			const items = Array.isArray(block.items) ? block.items : [];
			return {
				id,
				type: "grid",
				props: { cols: Math.min(4, Math.max(1, items.length)) },
				children: items.map((item) => {
					const it = isRecord(item) ? item : {};
					const delta = isRecord(it.delta) ? { ...it.delta, kind: "percent" } : undefined;
					return { type: "stat", props: { label: it.label, value: it.value, unit: it.unit, format: it.format, delta } };
				}),
			};
		}
		case "chart":
			return { id, type: "chart", props: { spec: block.spec } };
		case "bar_list":
			return { id, type: "bar_list", props: { items: block.items, unit: block.unit } };
		case "table":
			return { id, type: "table", props: { columns: block.columns, rows: block.rows } };
		case "tabs": {
			const tabs = Array.isArray(block.tabs) ? block.tabs : [];
			const ids = tabs.map((tab, i) => {
				const t = isRecord(tab) ? tab : {};
				return slugifyPageId(typeof t.id === "string" ? t.id : typeof t.label === "string" ? t.label : "") || `tab-${i + 1}`;
			});
			return {
				id,
				type: "tabs",
				props: { tabs: tabs.map((tab, i) => ({ id: ids[i], label: isRecord(tab) ? tab.label : undefined })) },
				children: tabs.map((tab, i) => ({
					type: "tab",
					props: { tab: ids[i] },
					children: (isRecord(tab) && Array.isArray(tab.blocks) ? tab.blocks : []).map(blockToNode),
				})),
			};
		}
		default:
			return { type: String(block.type) };
	}
}

function pageV1ToRaw(raw: Raw): Raw {
	return { v: 2, title: raw.title, summary: raw.summary, root: { type: "stack", props: { gap: "md" }, children: (raw.blocks as unknown[]).map(blockToNode) } };
}

/** Valida e normaliza a página (texto JSON ou objeto já lido; v1 vira v2). Não inclui as fontes (ver `parsePageSources`). */
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
	if (!isRecord(raw)) return fail("page spec must be a JSON object { v: 2, title, summary?, palette?, root }");
	let doc: Record<string, unknown> = raw;
	let legacy = false;
	if (doc.root === undefined && Array.isArray(doc.blocks) && (doc.v === undefined || doc.v === 1)) {
		if (doc.blocks.length === 0) return fail("blocks must be a non-empty array");
		doc = pageV1ToRaw(doc);
		legacy = true;
	} else if (doc.v !== undefined && doc.v !== 2) {
		return fail("page spec v must be 2");
	}
	const title = text(doc.title, 120);
	if (!title) return fail("title is required (short, up to 120 characters)");
	if (doc.root === undefined || doc.root === null) return fail("root is required: a node such as { type: \"stack\", children: [...] }");
	const palette = parsePalette(doc.palette);
	if (isFail(palette)) return palette;
	const ctx: Ctx = { ids: new Set(), nodes: 0, charts: 0, auto: 0, maxNodes: legacy ? LEGACY_MAX_NODES : PAGE_MAX_NODES };
	const root = parseNode(doc.root, ctx, "root", 1);
	if (isFail(root)) return root;
	const summary = pageSummaryText(doc.summary);
	return { ok: true, spec: { v: 2, title, ...(summary ? { summary } : {}), ...(palette ? { palette } : {}), root } };
}

/** Resumo do painel como `parsePageSpec` o normaliza (vale para v1 e v2). Listagens leem só esse campo do JSON. */
export function pageSummaryText(raw: unknown): string | undefined {
	return text(raw, 400);
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

/** Passa por todos os nós (a raiz primeiro, depois os filhos em ordem). */
export function walkPageNodes(node: PageNode, visit: (node: PageNode, depth: number) => void, depth = 1): void {
	visit(node, depth);
	for (const child of node.children ?? []) walkPageNodes(child, visit, depth + 1);
}

export function countPageNodes(spec: PageSpec): { nodes: number; charts: number } {
	let nodes = 0;
	let charts = 0;
	walkPageNodes(spec.root, (node) => {
		nodes += 1;
		if (node.type === "chart") charts += 1;
	});
	return { nodes, charts };
}

/** Resumo curto para o resultado da tool e para a memória do modelo. */
export function summarizePageSpec(spec: PageSpec): string {
	const counts = new Map<string, number>();
	walkPageNodes(spec.root, (node) => counts.set(node.type, (counts.get(node.type) ?? 0) + 1));
	const parts = [...counts.entries()].map(([type, n]) => `${n} ${type}`);
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	const palette = spec.palette ? (typeof spec.palette === "string" ? `, palette ${spec.palette}` : ", custom palette") : "";
	return `Page "${spec.title}": ${total} node${total === 1 ? "" : "s"} (${parts.join(", ")})${palette}`;
}

export type PagePatchOp =
	| { op: "replace"; id: string; node: unknown }
	| { op: "insert_after"; id?: string; node: unknown }
	| { op: "append_child"; id: string; node: unknown }
	| { op: "remove"; id: string };

export const PAGE_MAX_PATCH_OPS = 20;

/** Valida os ops vindos do modelo (forma, não o conteúdo do nó: isso é do `parsePageSpec`). Aceita `block` como apelido de `node`. */
export function parsePagePatchOps(input: unknown): { ok: true; ops: PagePatchOp[] } | Fail {
	if (!Array.isArray(input) || input.length === 0) return fail("ops must be a non-empty array of { op, id, node? }");
	if (input.length > PAGE_MAX_PATCH_OPS) return fail(`too many ops (max ${PAGE_MAX_PATCH_OPS})`);
	const ops: PagePatchOp[] = [];
	for (const [i, entry] of input.entries()) {
		if (!isRecord(entry)) return fail(`ops[${i}] must be an object`);
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		const node = entry.node ?? entry.block;
		if (entry.op === "remove") {
			if (!id) return fail(`ops[${i}].id is required for remove`);
			ops.push({ op: "remove", id });
		} else if (entry.op === "replace") {
			if (!id) return fail(`ops[${i}].id is required for replace`);
			if (!isRecord(node)) return fail(`ops[${i}].node is required for replace`);
			ops.push({ op: "replace", id, node });
		} else if (entry.op === "append_child") {
			if (!id) return fail(`ops[${i}].id (the parent node) is required for append_child`);
			if (!isRecord(node)) return fail(`ops[${i}].node is required for append_child`);
			ops.push({ op: "append_child", id, node });
		} else if (entry.op === "insert_after") {
			if (!isRecord(node)) return fail(`ops[${i}].node is required for insert_after`);
			ops.push({ op: "insert_after", ...(id ? { id } : {}), node });
		} else {
			return fail(`ops[${i}].op must be replace, insert_after, append_child or remove`);
		}
	}
	return { ok: true, ops };
}

type Located = { list: PageNode[]; index: number };

function locate(parent: PageNode, id: string): Located | undefined {
	const children = parent.children;
	if (!children) return undefined;
	for (const [index, child] of children.entries()) {
		if (child.id === id) return { list: children, index };
		const found = locate(child, id);
		if (found) return found;
	}
	return undefined;
}

function findNode(root: PageNode, id: string): PageNode | undefined {
	let found: PageNode | undefined;
	walkPageNodes(root, (node) => {
		if (node.id === id) found = node;
	});
	return found;
}

/**
 * Aplica ops por id de nó (replace | insert_after | append_child | remove) e revalida a página inteira:
 * o resultado respeita os mesmos limites do `parsePageSpec`. Não muta o `spec` recebido.
 */
export function applyPagePatch(spec: PageSpec, ops: readonly PagePatchOp[]): PageSpecParse {
	const draft = structuredClone(spec) as PageSpec;
	const missing = (i: number, id?: string) => fail(`ops[${i}]: no node with id "${id}" (use page_read to see the current ids)`);
	for (const [i, op] of ops.entries()) {
		if (op.op === "insert_after" && !op.id) {
			draft.root.children = [...(draft.root.children ?? []), op.node as PageNode];
			continue;
		}
		if (op.op === "append_child") {
			const parent = findNode(draft.root, op.id);
			if (!parent) return missing(i, op.id);
			parent.children = [...(parent.children ?? []), op.node as PageNode];
			continue;
		}
		if (draft.root.id === op.id) {
			if (op.op === "remove") return fail(`ops[${i}]: the root node cannot be removed (replace it, or remove its children)`);
			if (op.op === "insert_after") return fail(`ops[${i}]: the root node has no siblings; use append_child on "${op.id}" to add content`);
			const node = op.node as Record<string, unknown>;
			draft.root = { ...node, id: typeof node.id === "string" && node.id ? node.id : op.id } as PageNode;
			continue;
		}
		const found = locate(draft.root, op.id!);
		if (!found) return missing(i, op.id);
		if (op.op === "remove") found.list.splice(found.index, 1);
		else if (op.op === "replace") {
			const node = op.node as Record<string, unknown>;
			found.list[found.index] = { ...node, id: typeof node.id === "string" && node.id ? node.id : op.id } as PageNode;
		} else found.list.splice(found.index + 1, 0, op.node as PageNode);
	}
	return parsePageSpec(draft);
}
