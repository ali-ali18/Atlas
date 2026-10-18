import pptxgen from "pptxgenjs";
import type { SlideInput } from "@workspace/shared";

// Os tipos do pptxgenjs declaram o módulo como default; em runtime (Node ESM) o default é a classe.
type PptxInstance = InstanceType<typeof pptxgen.default>;
const PptxGenJS = pptxgen as unknown as new () => PptxInstance;

export async function renderPptx(slides: SlideInput[], title?: string): Promise<Uint8Array> {
	const pptx = new PptxGenJS();
	if (title) pptx.title = title;
	for (const slide of slides) {
		const s = pptx.addSlide();
		s.addText(slide.title, { x: 0.5, y: 0.3, w: 9, h: 0.9, fontSize: 28, bold: true });
		if (slide.bullets.length > 0) {
			s.addText(
				slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
				{ x: 0.7, y: 1.4, w: 8.6, h: 4, fontSize: 18, valign: "top" },
			);
		}
	}
	return (await pptx.write({ outputType: "uint8array" })) as Uint8Array;
}
