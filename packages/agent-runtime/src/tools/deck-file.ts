import { CodeRunnerUnavailableError, loadCodeRunnerConfig, runCode, runSandboxOperation, type CodeRunnerOutputFile, type SandboxExecutionContext } from "@workspace/sandbox";
import { loadArtifactForUser, persistUserArtifact, type PersistUserArtifactInput, type UserArtifact } from "@workspace/db";
import type { CreateFileInput } from "@workspace/shared";
import type { DeckImage, DeckImageSource } from "../files/deck/images.js";
import { fillTemplate, type RunPython } from "../files/deck/template/fill.js";
import { openTemplate, TEMPLATE_MAX_BYTES, TemplateError, type OpenedTemplate } from "../files/deck/template/inspect.js";
import { DECK_PREVIEW_PAGES, renderDeckPreview } from "../files/deck/visual-check.js";
import { formatDeckWarnings, lintDeck } from "../files/deck/lint.js";
import { renderFile, type RenderedFile } from "../files/render.js";
import { processImageForStorage } from "../images/process.js";

/**
 * Parte de apresentações do `create_file`: carrega o .pptx modelo do dono, desenha o deck (pptxgenjs ou
 * preenchendo o modelo), roda a conferência de layout e, quando dá, a conferência visual (páginas renderizadas
 * com o LibreOffice que voltam ao modelo como imagens).
 */
export type DeckFileDeps = {
	runPython: RunPython;
	processImage: typeof processImageForStorage;
	persist: (input: PersistUserArtifactInput) => Promise<UserArtifact>;
	loadArtifact?: DeckImageSource["loadArtifact"];
};

export const DEFAULT_DECK_FILE_DEPS: DeckFileDeps = {
	runPython: (input) => runCode(input, loadCodeRunnerConfig()),
	processImage: processImageForStorage,
	persist: persistUserArtifact,
};

export function resolveDeckFileDeps(partial: Partial<DeckFileDeps> | undefined): DeckFileDeps {
	return { ...DEFAULT_DECK_FILE_DEPS, ...partial };
}

export type DeckFileContext = SandboxExecutionContext & {
	userId: string;
	runId?: string;
	conversationId?: string;
	attachmentFiles?: DeckImageSource["attachments"];
	canSeeImages?: boolean;
};

const TEMPLATE_EXT = /\.(pptx|potx)$/i;

/**
 * Anexo da conversa ou arquivo do próprio usuário (biblioteca de Documentos). Outro dono, id inexistente ou
 * arquivo que não é .pptx/.potx dão a mesma resposta: não revela se o id existe.
 */
export async function loadTemplateFile(id: string, ctx: DeckFileContext, deps: Pick<DeckFileDeps, "loadArtifact">): Promise<OpenedTemplate> {
	const notFound = () => new Error(`Template ${id} was not found. Use the id of a .pptx attached to this conversation or of a .pptx file in the user's library, or drop template_file_id to use a built-in theme.`);
	let bytes: Uint8Array | null = null;
	let filename = "template.pptx";
	const attachments = ctx.attachmentFiles ? await ctx.attachmentFiles.list().catch(() => []) : [];
	const attachment = attachments.find((a) => a.id === id);
	if (attachment && ctx.attachmentFiles) {
		filename = attachment.filename;
		bytes = await ctx.attachmentFiles.bytes(id).catch(() => null);
	} else {
		const load = deps.loadArtifact ?? loadArtifactForUser;
		const artifact = await load(id, ctx.userId).catch(() => null);
		const meta = (artifact?.meta ?? {}) as Record<string, unknown>;
		const name = typeof meta.filename === "string" ? meta.filename : "";
		const ext = typeof meta.ext === "string" ? meta.ext : "";
		if (artifact && artifact.kind === "file" && (TEMPLATE_EXT.test(name) || /^(pptx|potx)$/i.test(ext))) {
			bytes = new Uint8Array(artifact.bytes);
			filename = name || `template.${ext}`;
		}
	}
	if (!bytes) throw notFound();
	if (!TEMPLATE_EXT.test(filename)) {
		throw new Error(`Template ${id} is not a .pptx or .potx file (${filename}). Ask the user for the PowerPoint template, or drop template_file_id to use a built-in theme.`);
	}
	if (bytes.byteLength > TEMPLATE_MAX_BYTES) throw new TemplateError(`The template is too large (${Math.round(bytes.byteLength / 1024 / 1024)} MB, max ${TEMPLATE_MAX_BYTES / 1024 / 1024} MB).`);
	return openTemplate(bytes, filename);
}

export type RenderedDeck = RenderedFile & {
	/** Páginas renderizadas (só quando a sandbox as devolveu) e o motivo de não haver, para dizer a verdade ao modelo. */
	previews: CodeRunnerOutputFile[];
	previewSkipped?: string;
	notes: string[];
};

/** Desenha o deck: preenchendo o modelo do usuário (sandbox) ou com os temas embutidos (pptxgenjs). */
export async function renderDeck(
	input: CreateFileInput,
	ctx: DeckFileContext,
	deps: DeckFileDeps,
	images: Map<string, DeckImage> | undefined,
): Promise<RenderedDeck> {
	const notes: string[] = [];
	if (input.templateFileId) {
		if (input.theme && input.theme !== "clean") notes.push("theme is ignored with a template: the template's own fonts and colors are used.");
		if (input.brandColor) notes.push("brand_color is ignored with a template.");
		const template = await loadTemplateFile(input.templateFileId, ctx, deps);
		let filled;
		try {
			filled = await runSandboxOperation(ctx, 125_000, (signal) =>
				fillTemplate({ template, slides: input.slides ?? [], images: images ?? new Map(), run: deps.runPython, signal, ...(ctx.runId ? { labels: { "atlas.run": ctx.runId } } : {}), preview: ctx.canSeeImages === true }),
			);
		} catch (error) {
			if (error instanceof CodeRunnerUnavailableError) {
				throw new Error(`Filling a template needs the code runner, which is not available on this server (${error.message}). Tell the user, or build the deck with a built-in theme (drop template_file_id).`);
			}
			throw error;
		}
		notes.push(...filled.warnings);
		const rendered = { bytes: filled.bytes, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
		return { ...rendered, previews: filled.previews.slice(0, DECK_PREVIEW_PAGES), notes, ...(ctx.canSeeImages && filled.previews.length === 0 ? { previewSkipped: "the template was filled but LibreOffice could not render the pages" } : {}) };
	}
	const rendered = await runSandboxOperation(ctx, 60_000, () => renderFile(input, { deckImages: images }));
	if (ctx.canSeeImages !== true) return { ...rendered, previews: [], previewSkipped: "this model cannot view images", notes };
	const preview = await runSandboxOperation(ctx, 120_000, (signal) => renderDeckPreview(rendered.bytes, deps.runPython, signal)).catch(() => ({ ok: false as const, reason: "the render was interrupted" }));
	return preview.ok ? { ...rendered, previews: preview.pages.slice(0, DECK_PREVIEW_PAGES), notes } : { ...rendered, previews: [], previewSkipped: preview.reason, notes };
}

/** Guarda as páginas como imagens do dono (só o modelo as vê) e devolve os ids. Falha de uma página não derruba as outras. */
export async function persistDeckPreviews(pages: CodeRunnerOutputFile[], ctx: DeckFileContext, deps: Pick<DeckFileDeps, "processImage" | "persist">): Promise<string[]> {
	const ids: string[] = [];
	for (const page of pages) {
		try {
			const processed = await deps.processImage(page.bytes);
			const { id } = await deps.persist({
				userId: ctx.userId, runId: ctx.runId, conversationId: ctx.conversationId, kind: "image", bytes: processed.bytes, mime: processed.mime,
				meta: { mime: processed.mime, width: processed.width, height: processed.height, bytes: processed.bytes.byteLength, source: "deck_preview", origin: "assistant", alt: page.name },
			});
			ids.push(id);
		} catch {
			// página ilegível: a conferência segue com as outras
		}
	}
	return ids;
}

/** Texto que o modelo recebe depois de criar o deck: avisos do layout, resultado da conferência visual e o que fazer. */
export function deckResultNotes(input: CreateFileInput, rendered: RenderedDeck, previewCount: number, totalSlides: number, artifactId: string): string {
	const lines: string[] = [];
	const warnings = formatDeckWarnings(lintDeck(input.slides ?? [], { theme: input.theme, brandColor: input.brandColor }));
	if (warnings) lines.push(warnings);
	for (const note of rendered.notes) lines.push(`Note: ${note}`);
	if (previewCount > 0) {
		const partial = totalSlides > previewCount ? ` (the first ${previewCount} of ${totalSlides} slides)` : "";
		lines.push(
			`Visual check: ${previewCount} slide image${previewCount > 1 ? "s are" : " is"} attached to the next message${partial}; the user does not see them. Look at each one for text cut off or overflowing its box, overlapping elements, unreadable contrast, empty placeholders and missing images. If something is wrong, fix the content and call create_file again with the same filename; if it looks right, reply with one short line.`,
		);
	} else {
		lines.push(`Visual check not done: ${rendered.previewSkipped ?? "no preview available"}. The layout was only estimated from text length. To look at the slides yourself, run_code with files ["${artifactId}"] (see the Files skill, section 8).`);
	}
	return lines.join("\n");
}
