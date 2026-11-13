import JSZip from "jszip";
import type { CodeRunInput, CodeRunResult, CodeRunnerOutputFile } from "@workspace/sandbox";
import type { SlideInput } from "@workspace/shared";
import { prepareDeckAssets } from "../assets.js";
import type { DeckImage } from "../images.js";
import { TEMPLATE_FILL_SCRIPT } from "./fill-script.js";
import { templateAsPptx, type OpenedTemplate } from "./inspect.js";
import { planTemplateDeck, templatePalette, type PlannedElement, type TemplatePlan } from "./plan.js";

/**
 * Preenche o .pptx do usuário. O servidor decide o plano (`plan.ts`) e empacota entradas; a sandbox
 * `run_code` (python-pptx, sem rede) abre o modelo, descarta os slides de exemplo e cria os novos a partir dos
 * LAYOUTS do próprio modelo, então fontes, cores, fundos e mestres do usuário se mantêm e tudo continua editável.
 */
export type RunPython = (input: CodeRunInput) => Promise<CodeRunResult>;

export type FilledTemplate = { bytes: Uint8Array; previews: CodeRunnerOutputFile[]; warnings: string[]; plan: TemplatePlan };

const EXT: Record<string, string> = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", gif: "gif" };

function decodeData(data: string): { bytes: Uint8Array; ext: string } {
	const comma = data.indexOf(",");
	const mime = data.slice(0, comma).split(";")[0]!.split("/")[1] ?? "png";
	return { bytes: Buffer.from(data.slice(comma + 1), "base64"), ext: EXT[mime] ?? "png" };
}

/** Texto curto do erro da sandbox, sem caminhos internos, para o modelo agir. */
function failure(result: CodeRunResult): Error {
	if (result.timedOut) return new Error("Filling the template timed out. Try fewer slides or a lighter template.");
	if (result.crashed) return new Error("Filling the template ran out of memory. Try a template with fewer or smaller images.");
	const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-4).join(" ").replace(/\/work\S*/g, "<file>").slice(0, 400);
	return new Error(`Filling the template failed (${tail || `exit code ${result.exitCode}`}). The template may use features this tool cannot read; ask the user for a simpler .pptx or use a built-in theme.`);
}

export async function fillTemplate(input: {
	template: OpenedTemplate;
	slides: readonly SlideInput[];
	images: ReadonlyMap<string, DeckImage>;
	run: RunPython;
	signal?: AbortSignal;
	labels?: Record<string, string>;
	/** Renderizar as páginas com o LibreOffice na mesma execução (padrão). */
	preview?: boolean;
}): Promise<FilledTemplate> {
	const { template, slides, images } = input;
	const plan = planTemplateDeck(slides, template.info, { hints: slides.map((s) => s.templateLayout) });
	const assets = await prepareDeckAssets(slides, templatePalette(template.info), images);
	const job = new JSZip();
	const fileOf = new Map<string, string>();
	const addAsset = (key: string): string => {
		const known = fileOf.get(key);
		if (known) return known;
		let source: { bytes: Uint8Array; ext: string } | undefined;
		if (key.startsWith("image:")) {
			const image = images.get(key.slice("image:".length));
			if (image) source = decodeData(image.data);
		} else {
			const data = assets.get(key);
			if (data) source = decodeData(data);
		}
		if (!source) throw new Error(`Asset ${key} was not prepared for the template.`);
		const name = `a${fileOf.size + 1}.${source.ext}`;
		job.file(`assets/${name}`, source.bytes);
		fileOf.set(key, name);
		return name;
	};
	const withFiles = plan.slides.map((slide) => ({
		...slide,
		elements: slide.elements.map((el): PlannedElement => (el.type === "picture" ? { ...el, asset: addAsset(el.asset) } : el)),
		...(slide.background?.kind === "picture" ? { background: { ...slide.background, asset: addAsset(slide.background.asset) } } : {}),
	}));
	job.file("job.json", JSON.stringify({ slides: withFiles, preview: input.preview !== false }));
	const result = await input.run({
		code: TEMPLATE_FILL_SCRIPT,
		files: [
			{ name: "template.pptx", bytes: await templateAsPptx(template) },
			{ name: "job.zip", bytes: await job.generateAsync({ type: "uint8array", compression: "DEFLATE" }) },
		],
		timeoutSec: 115,
		...(input.signal ? { signal: input.signal } : {}),
		...(input.labels ? { labels: input.labels } : {}),
	});
	const out = result.outputs.find((file) => file.name === "deck.pptx");
	if (result.exitCode !== 0 || !out) throw failure(result);
	const previews = [...(result.previews ?? [])].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
	return { bytes: out.bytes, previews, warnings: plan.warnings, plan: { ...plan, slides: withFiles } };
}
