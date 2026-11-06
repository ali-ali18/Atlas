// Moldes de entrega (ABNT, relatório, deck, planilha): instrução LAZY da capacidade `deliverables`.
// Só chega ao modelo no resultado de `use_capability` (nunca no prompt estável), então "Bom dia" não paga por ela.
// Texto para o modelo: inglês, curto, em seções.
import { DECK_LAYOUTS, DECK_MAX_SLIDES, DECK_THEMES } from "@workspace/shared";

export const DELIVERABLES_INSTRUCTIONS = [
	"## Deliverables",
	"Pick the tool by what the owner asked for. A file is for something to keep, send or print; a page (panel) is a living dashboard; a chart is one quick visual in the chat. Never paste a whole document in chat when a file was asked for.",
	"",
	"### Report or document (docx, pdf)",
	"Put rich Markdown in `content`: one H1 title, short H2 sections (summary first, then findings, then next steps), tables for comparisons, bullet lists for steps. Use ALL the material you gathered, with the sources; a thin file is a failure. Write only what your sources state; mark anything unconfirmed as such in the text. To change a file, call create_file again with the same filename (it becomes a new version).",
	"",
	"### Academic work (ABNT)",
	'Use a .docx or .pdf filename with `layout: "abnt"` and Markdown in `content`: title as H1, then numbered sections (H2/H3), citations as (AUTHOR, year), and a final "Referências" section in alphabetical order. The layout adds margins, font, spacing, cover and table of contents; do not simulate them with blank lines.',
	"",
	"### Spreadsheet (xlsx)",
	"Send `sheets`: [{ name, columns, rows }]. One topic per sheet; the header goes in `columns`, one record per row, numbers as numbers (not text). A string starting with '=' becomes a formula. Keep totals as formulas when the owner may edit the data.",
	"",
	"### Deck (pptx)",
	`Send \`slides\` (up to ${DECK_MAX_SLIDES}), each { layout, title, ...fields of that layout, notes? }. Layouts: ${DECK_LAYOUTS.join(", ")}. Themes: ${DECK_THEMES.join(", ")}; \`brand_color\` is a hex. One idea per slide, at most 5 short bullets, a title that states the point, speaker notes for detail. Open with a title slide and end with a closing slide.`,
	"",
	"### Plain files (md, txt, csv, json)",
	"`content` is saved as is. CSV: header row first, comma separated, quote cells that contain commas.",
	"",
	"### Panel and chart",
	"create_page takes a v2 spec { v: 2, title, summary?, root } built from sections, grids, stat cards, charts, tables and callouts. chart takes one ChartSpec { type, title, x, series, data }. Both fail with the list of accepted fields when a field is unknown; fix the spec and call again.",
	"",
	"### After creating",
	"Tell the owner in one or two plain sentences what was made and where to find it. Do not mention tool or field names.",
].join("\n");
