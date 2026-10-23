/**
 * Apresentações (.pptx) do `create_file`: esquema validado dos slides e do tema.
 * Só funções puras. O desenho (pptxgenjs) mora em `packages/agent-runtime/src/files`.
 * O formato antigo `{ title, bullets[] }` continua valendo e vira o layout `bullets`.
 */
import { normalizeChartHexColor, type ChartSpec } from "./chart-spec.js";
import { fail, list, need, obj, parseChart, parseDeckImageId, str } from "./deck-util.js";
import { freeImageIds, parseDeckBackground, parseFreeElements, type DeckBackground, type FreeElement } from "./deck-free.js";

export { DECK_CHART_TYPES, DECK_MAX_CHART_POINTS, parseDeckImageId } from "./deck-util.js";
export * from "./deck-free.js";

export const DECK_MAX_SLIDES = 60;
export const DECK_MAX_BULLETS = 20;
export const DECK_MAX_SUB_BULLETS = 6;
export const DECK_MAX_STATS = 4;
export const DECK_MAX_TIMELINE_STEPS = 6;
export const DECK_MAX_AGENDA_ITEMS = 8;
export const DECK_MAX_TABLE_COLUMNS = 8;
export const DECK_MAX_TABLE_ROWS = 14;
export const DECK_MAX_NOTES_CHARS = 2_000;
export const DECK_TITLE_MAX_CHARS = 300;
export const DECK_TEXT_MAX_CHARS = 500;

export const DECK_THEMES = ["clean", "dark", "corporate", "vivid"] as const;
export type DeckTheme = (typeof DECK_THEMES)[number];

export const DECK_LAYOUTS = ["title", "agenda", "section", "bullets", "two_column", "image", "chart", "table", "quote", "stats", "timeline", "closing", "free"] as const;
export type DeckLayout = (typeof DECK_LAYOUTS)[number];


export type DeckBullet = { text: string; sub: string[] };
export type DeckColumn = { heading?: string; bullets: DeckBullet[] };
export type DeckStat = { value: string; label: string; detail?: string };
export type DeckStep = { label: string; title: string; text?: string };

/** `templateLayout`: nome de um layout do .pptx modelo (só vale com `template_file_id`). */
type Common = { notes?: string; background?: DeckBackground; templateLayout?: string };

export type SlideInput = Common &
	(
		| { layout: "title"; title: string; subtitle?: string }
		| { layout: "agenda"; title: string; items: string[] }
		| { layout: "section"; title: string; subtitle?: string }
		| { layout: "bullets"; title: string; bullets: DeckBullet[] }
		| { layout: "two_column"; title: string; columns: [DeckColumn, DeckColumn] }
		| { layout: "image"; title: string; image: string; caption?: string; bullets: DeckBullet[] }
		| { layout: "chart"; title: string; chart: ChartSpec; caption?: string }
		| { layout: "table"; title: string; columns: string[]; rows: string[][]; caption?: string }
		| { layout: "quote"; quote: string; author?: string; title?: string }
		| { layout: "stats"; title: string; stats: DeckStat[]; caption?: string }
		| { layout: "timeline"; title: string; steps: DeckStep[] }
		| { layout: "closing"; title: string; subtitle?: string; bullets: DeckBullet[] }
		/** Posições absolutas na grade 13.333 x 7.5 pol.; nenhum título é desenhado sozinho. */
		| { layout: "free"; name?: string; elements: FreeElement[] }
	);

export type DeckOptions = { theme: DeckTheme; brandColor?: string };

/** Aceita `"texto"` ou `{ text, sub?: string[] }`. Itens vazios somem (compatível com o formato antigo). */
function parseBullets(value: unknown, label: string, max = DECK_MAX_BULLETS): DeckBullet[] {
	if (value === undefined || value === null) return [];
	const items = list(value, label, 0, max);
	const out: DeckBullet[] = [];
	items.forEach((raw, i) => {
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const item = raw as Record<string, unknown>;
			const text = str(item.text, DECK_TEXT_MAX_CHARS, `${label}[${i}].text`);
			if (!text) return;
			const sub = item.sub === undefined || item.sub === null ? [] : list(item.sub, `${label}[${i}].sub`, 0, DECK_MAX_SUB_BULLETS);
			out.push({ text, sub: sub.map((s) => String(s ?? "").trim().slice(0, DECK_TEXT_MAX_CHARS)).filter(Boolean) });
			return;
		}
		const text = String(raw ?? "").trim().slice(0, DECK_TEXT_MAX_CHARS);
		if (text) out.push({ text, sub: [] });
	});
	return out;
}

function parseColumn(raw: unknown, label: string): DeckColumn {
	const col = obj(raw, label);
	const heading = str(col.heading, 120, `${label}.heading`);
	return { ...(heading ? { heading } : {}), bullets: parseBullets(col.bullets, `${label}.bullets`, 10) };
}

function parseOne(raw: unknown, index: number): SlideInput {
	const label = `slides[${index}]`;
	const slide = obj(raw, label);
	const notes = str(slide.notes, DECK_MAX_NOTES_CHARS, `${label}.notes`);
	const background = parseDeckBackground(slide.background, `${label}.background`);
	const templateLayout = str(slide.template_layout, 80, `${label}.template_layout`);
	const extra = { ...(notes ? { notes } : {}), ...(background ? { background } : {}), ...(templateLayout ? { templateLayout } : {}) };
	let layout = typeof slide.layout === "string" ? slide.layout.trim().toLowerCase() : "bullets";
	if (layout === "big_number" || layout === "kpi" || layout === "kpis") layout = "stats";
	if (layout === "default" || layout === "") layout = "bullets";
	if (!(DECK_LAYOUTS as readonly string[]).includes(layout)) {
		fail(`${label}.layout "${String(slide.layout)}" is not valid. Use one of: ${DECK_LAYOUTS.join(", ")} (big_number is accepted as stats).`);
	}
	const title = (required: boolean) =>
		required ? need(slide.title, DECK_TITLE_MAX_CHARS, `${label}.title`) : str(slide.title, DECK_TITLE_MAX_CHARS, `${label}.title`);
	const subtitle = str(slide.subtitle, DECK_TEXT_MAX_CHARS, `${label}.subtitle`);
	const caption = str(slide.caption, DECK_TEXT_MAX_CHARS, `${label}.caption`);

	switch (layout as DeckLayout) {
		case "title":
			return { layout: "title", title: title(true)!, ...(subtitle ? { subtitle } : {}), ...extra };
		case "section":
			return { layout: "section", title: title(true)!, ...(subtitle ? { subtitle } : {}), ...extra };
		case "agenda": {
			const items = list(slide.items ?? slide.bullets, `${label}.items`, 1, DECK_MAX_AGENDA_ITEMS)
				.map((i) => String((i && typeof i === "object" ? (i as Record<string, unknown>).text : i) ?? "").trim().slice(0, 200))
				.filter(Boolean);
			if (items.length === 0) fail(`${label}.items needs at least 1 non-empty item.`);
			return { layout: "agenda", title: title(false) ?? "Agenda", items, ...extra };
		}
		case "bullets":
			return { layout: "bullets", title: title(true)!, bullets: parseBullets(slide.bullets, `${label}.bullets`), ...extra };
		case "two_column": {
			const cols = list(slide.columns, `${label}.columns`, 2, 2);
			return { layout: "two_column", title: title(true)!, columns: [parseColumn(cols[0], `${label}.columns[0]`), parseColumn(cols[1], `${label}.columns[1]`)], ...extra };
		}
		case "image":
			return {
				layout: "image",
				title: title(true)!,
				image: parseDeckImageId(slide.image, `${label}.image`),
				...(caption ? { caption } : {}),
				bullets: parseBullets(slide.bullets, `${label}.bullets`, 6),
				...extra,
			};
		case "chart":
			return { layout: "chart", title: title(true)!, chart: parseChart(slide.chart, `${label}.chart`), ...(caption ? { caption } : {}), ...extra };
		case "table": {
			const columns = list(slide.columns, `${label}.columns`, 1, DECK_MAX_TABLE_COLUMNS).map((c) => String(c ?? "").trim().slice(0, 80));
			const rows = list(slide.rows, `${label}.rows`, 1, DECK_MAX_TABLE_ROWS).map((row, r) => {
				if (!Array.isArray(row)) fail(`${label}.rows[${r}] must be an array of cells.`);
				if (row.length > columns.length) fail(`${label}.rows[${r}] has more cells than columns (${columns.length}).`);
				return columns.map((_, c) => String(row[c] ?? "").trim().slice(0, 200));
			});
			return { layout: "table", title: title(true)!, columns, rows, ...(caption ? { caption } : {}), ...extra };
		}
		case "quote": {
			const author = str(slide.author, 200, `${label}.author`);
			const heading = title(false);
			return { layout: "quote", quote: need(slide.quote, 600, `${label}.quote`), ...(author ? { author } : {}), ...(heading ? { title: heading } : {}), ...extra };
		}
		case "stats": {
			const source = slide.stats ?? (slide.value !== undefined ? [{ value: slide.value, label: slide.label, detail: slide.detail }] : undefined);
			const stats = list(source, `${label}.stats`, 1, DECK_MAX_STATS).map((raw, i) => {
				const s = obj(raw, `${label}.stats[${i}]`);
				const detail = str(s.detail, 120, `${label}.stats[${i}].detail`);
				return { value: need(s.value, 24, `${label}.stats[${i}].value`), label: need(s.label, 80, `${label}.stats[${i}].label`), ...(detail ? { detail } : {}) };
			});
			return { layout: "stats", title: title(true)!, stats, ...(caption ? { caption } : {}), ...extra };
		}
		case "timeline": {
			const steps = list(slide.steps, `${label}.steps`, 2, DECK_MAX_TIMELINE_STEPS).map((raw, i) => {
				const s = obj(raw, `${label}.steps[${i}]`);
				const text = str(s.text, 160, `${label}.steps[${i}].text`);
				return { label: need(s.label, 30, `${label}.steps[${i}].label`), title: need(s.title, 80, `${label}.steps[${i}].title`), ...(text ? { text } : {}) };
			});
			return { layout: "timeline", title: title(true)!, steps, ...extra };
		}
		case "free": {
			const name = str(slide.name ?? slide.title, DECK_TITLE_MAX_CHARS, `${label}.name`);
			return { layout: "free", ...(name ? { name } : {}), elements: parseFreeElements(slide.elements, `${label}.elements`), ...extra };
		}
		case "closing":
			return { layout: "closing", title: title(true)!, ...(subtitle ? { subtitle } : {}), bullets: parseBullets(slide.bullets, `${label}.bullets`, 4), ...extra };
	}
}

/** Valida os slides do modelo (formato antigo ou rico). Lança erro acionável. */
export function parseDeckSlides(value: unknown): SlideInput[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail("slides must be a non-empty array of { layout?, title, ... } (layouts: " + DECK_LAYOUTS.join(", ") + ").");
	}
	if (value.length > DECK_MAX_SLIDES) fail(`Too many slides (max ${DECK_MAX_SLIDES}).`);
	return value.map((raw, index) => parseOne(raw, index));
}

export function parseDeckTheme(value: unknown): DeckTheme {
	if (value === undefined || value === null || value === "") return "clean";
	const theme = typeof value === "string" ? value.trim().toLowerCase() : "";
	if ((DECK_THEMES as readonly string[]).includes(theme)) return theme as DeckTheme;
	return fail(`theme must be one of: ${DECK_THEMES.join(", ")}.`);
}

/** `brand_color`: hex `#rgb`/`#rrggbb`. Inválido é erro (o modelo corrige), ausente é `undefined`. */
export function parseDeckBrandColor(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return normalizeChartHexColor(value) ?? fail('brand_color must be a hex color such as "#1d6b3a".');
}

/** Ids de imagem usados pelos slides (layout image, elementos livres e fundos), sem repetição: o runtime resolve cada um uma vez. */
export function deckImageIds(slides: SlideInput[]): string[] {
	const ids = slides.flatMap((s) => [
		...(s.layout === "image" ? [s.image] : []),
		...(s.layout === "free" ? freeImageIds(s.elements) : []),
		...(s.background?.kind === "image" ? [s.background.image] : []),
	]);
	return [...new Set(ids)];
}

/** `template_file_id`: id de um anexo .pptx ou de um arquivo do usuário. URL não vale. */
export function parseDeckTemplateId(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const raw = need(value, 200, "template_file_id").replace(/^(attachment|artifact):/, "");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("data:")) fail("template_file_id must be the id of an attached .pptx or of a file in the user's library, not a URL.");
	if (!/^[\w.-]{1,200}$/.test(raw)) fail("template_file_id is not a valid file id.");
	return raw;
}
