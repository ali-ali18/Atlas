import pptxgen from "pptxgenjs";
import type { DeckTheme, SlideInput } from "@workspace/shared";
import type { DeckImage } from "./deck/images.js";
import { drawSlide, masterFor, PAGE_W, MARGIN, type DeckContext } from "./deck/layouts.js";
import { buildPalette, type DeckPalette } from "./deck/themes.js";

// Os tipos do pptxgenjs declaram o módulo como default; em runtime (Node ESM) o default é a classe.
type PptxInstance = InstanceType<typeof pptxgen.default>;
const PptxGenJS = pptxgen as unknown as new () => PptxInstance;

export type RenderPptxOptions = {
	title?: string;
	theme?: DeckTheme;
	/** Hex `#rrggbb` da marca (troca o destaque do tema). */
	brandColor?: string;
	/** Imagens já resolvidas (id → dados); o desenho não faz I/O. */
	images?: Map<string, DeckImage>;
};

type MasterObject = NonNullable<Parameters<PptxInstance["defineSlideMaster"]>[0]["objects"]>[number];

/** Fundos e rodapé. Formas decorativas das capas ficam em `deck/layouts.ts` (o mestre só aceita retângulos). */
function defineMasters(pptx: PptxInstance, p: DeckPalette, footer: string): void {
	const footerText = footer.length > 80 ? `${footer.slice(0, 79)}…` : footer;
	pptx.defineSlideMaster({ title: "COVER", background: { color: p.coverBg } });
	pptx.defineSlideMaster({ title: "SECTION", background: { color: p.coverBg } });
	pptx.defineSlideMaster({ title: "QUOTE", background: { color: p.surface } });
	const objects: MasterObject[] = [
		{ rect: { x: 0, y: 0, w: PAGE_W, h: 0.18, fill: { color: p.accent } } },
		{ line: { x: MARGIN, y: 6.98, w: PAGE_W - MARGIN * 2, h: 0, line: { color: p.border, width: 0.75 } } },
		{ text: { text: footerText, options: { x: MARGIN, y: 7.03, w: 9, h: 0.3, fontSize: 11, color: p.muted, fontFace: p.bodyFont, margin: 0, valign: "middle" } } },
	];
	pptx.defineSlideMaster({
		title: "CONTENT",
		background: { color: p.bg },
		objects,
		slideNumber: { x: PAGE_W - MARGIN - 1, y: 7.03, w: 1, h: 0.3, fontSize: 11, color: p.muted, fontFace: p.bodyFont, align: "right" },
	});
}

/** Desenha a apresentação com o tema escolhido e devolve o .pptx. */
export async function renderPptx(slides: SlideInput[], options: RenderPptxOptions = {}): Promise<Uint8Array> {
	const theme = options.theme ?? "clean";
	const palette = buildPalette(theme, options.brandColor);
	const pptx = new PptxGenJS();
	pptx.layout = "LAYOUT_WIDE";
	const first = slides[0];
	const deckTitle = options.title ?? (first && "title" in first && first.title ? first.title : "Apresentação");
	pptx.title = deckTitle;
	pptx.theme = { headFontFace: palette.headFont, bodyFontFace: palette.bodyFont };
	defineMasters(pptx, palette, deckTitle);
	const ctx: DeckContext = { pptx, palette, images: options.images ?? new Map(), sectionCount: { n: 0 } };
	for (const input of slides) {
		const slide = pptx.addSlide({ masterName: masterFor(input.layout) });
		drawSlide(ctx, slide, input);
	}
	return (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
}
