// Texto que o MODELO lê (inglês, curto). Toda parte diz ONDE está e QUANTO falta; nada é cortado sem dizer.
import type { z } from "zod";
import type { MapData, MapSection, ReadData, findDataSchema } from "./protocol.js";

const num = (n: number) => n.toLocaleString("en-US");

export function sizeOf(section: Pick<MapSection, "items" | "declaredTotal" | "canLoadMore">): string {
	const { items, declaredTotal, canLoadMore } = section;
	if (declaredTotal !== null && declaredTotal > items) return `${num(items)} loaded of ~${num(declaredTotal)}${canLoadMore ? ", more can be loaded" : ", no way to load more was found"}`;
	if (declaredTotal !== null) return `${num(items)} loaded of ${num(declaredTotal)} (all)`;
	return `${num(items)} loaded${canLoadMore ? ", the page does not say the total; more can be loaded" : ""}`;
}

export function renderMap(map: MapData): string {
	const head = `${map.title || "(no title)"} (${map.url}) - ${num(map.totalChars)} characters of content.`;
	const wall = map.wall ? `\nThis page is a ${map.wall === "captcha" ? "captcha" : "block"} wall, not the real content. Do not retry the same URL: try another source, or ask the owner to solve it in the browser view.` : "";
	const rows = map.sections.map((s) => `- ${s.id} [${s.kind}] ${s.label || "(no label)"}: ${s.kind === "form" ? `${s.items} field(s)` : sizeOf(s)}, ${num(s.chars)} chars${s.preview ? `. Starts: "${s.preview}"` : ""}`);
	const tree = map.poorTree ? "\nThe page has few labels (icons, canvas?): if reading does not answer the question, use browser_screenshot." : "";
	const how = map.sections.some((s) => s.items > 0) ? "\nRead a section in parts with browser_read (section, from, count), search it with browser_find, grow it with browser_load_more." : "";
	return `${head}${wall}\nSections:\n${rows.join("\n") || "(no readable sections)"}${tree}${how}`;
}

export function renderRead(data: ReadData): string {
	const range = data.items.length === 0 ? "no items" : `items ${num(data.from)}-${num(data.to)}`;
	const total = data.declaredTotal !== null && data.declaredTotal > data.loaded ? ` The page declares ~${num(data.declaredTotal)}; ${num(data.loaded)} are loaded.` : "";
	const rest = data.nextFrom !== null ? ` ${num(data.loaded - data.to)} loaded item(s) remain: continue with from=${data.nextFrom}.` : data.canLoadMore ? " That is everything loaded so far; browser_load_more brings more." : " That is the end of the section.";
	const head = `Section ${data.section} "${data.label}": ${range} of ${num(data.loaded)} loaded.${total}${rest}`;
	const body = data.items
		.map((item) => {
			const refs = item.refs && item.refs.length > 0 ? ` [${item.refs.map((r) => `${r.ref} ${r.name}`).join("; ")}]` : "";
			const clipped = item.clippedChars ? ` [+${num(item.clippedChars)} more characters in this item: read it alone with itemChars up to 20000]` : "";
			return `${item.n}. ${item.text}${clipped}${refs}`;
		})
		.join("\n");
	return `${head}\n\n${body}`;
}

export function renderFind(data: z.output<typeof findDataSchema>, query: string): string {
	const shown = data.matches.length;
	const more = data.totalMatches > shown ? ` Showing the first ${shown}; ask again with a higher limit or a narrower query for the rest.` : "";
	const head = `${num(data.totalMatches)} match(es) for "${query}" in ${num(data.searchedItems)} item(s)${data.section ? ` of ${data.section}` : " across the page"}.${more}`;
	return `${head}\n${data.matches.map((m) => `- ${m.section} #${m.n}: ${m.snippet}${m.ref ? ` [${m.ref}]` : ""}`).join("\n")}`;
}
