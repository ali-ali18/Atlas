import { assertSandboxExecution, runSandboxOperation } from "@workspace/sandbox";
import type { ChatTool } from "@workspace/llm";
import {
	countRunFileArtifacts,
	nextFileVersion,
	persistUserArtifact,
	type PersistUserArtifactInput,
	type UserArtifact,
} from "@workspace/db";
import {
	FILES_PER_RUN_MAX,
	FILE_MAX_CONTENT_CHARS,
	DECK_LAYOUTS,
	DECK_MAX_SLIDES,
	DECK_THEMES,
	deckImageIds,
	formatFileSize,
	parseCreateFileArgs,
	type ComputerUseEvent,
	type FileArtifactMeta,
} from "@workspace/shared";
import { resolveDeckImages, type DeckImageSource } from "../files/deck/images.js";
import { formatDeckWarnings, lintDeck } from "../files/deck/lint.js";
import { renderFile } from "../files/render.js";
import { printPdfWithChromium } from "../files/pdf-chromium.js";
import type { PrintPdf } from "../files/pdf.js";

/**
 * `create_file` (F9): o modelo escreve o CONTEÚDO e o servidor converte para
 * PDF, Word, Excel, PowerPoint ou texto/código. O arquivo vira um artefato do
 * dono (baixado em `GET /v1/files/:id`) e um cartão persistido na conversa.
 * Escrita reversível: não pede confirmação (o usuário pode ignorar/refazer).
 */

export const CREATE_FILE_TOOL_NAME = "create_file";

export const CREATE_FILE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: CREATE_FILE_TOOL_NAME,
		description:
			"Create a downloadable file for the user (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx, or any text/code file such as .txt .md .csv .json .py .js .sql) and show it as a file card in the chat. Use when the user asks for a file or document; do NOT paste the document in chat. filename needs the extension (format is inferred from it). docx/pdf: put rich Markdown in content (headings, lists, tables). xlsx: send sheets [{name, columns?, rows}] (a string starting with '=' becomes a formula). pptx: send slides (see below). Text/code: content is saved as is. To change a file, call again with the same filename (creates v2). For a document built from earlier research, use ALL the research notes and sources gathered (every section and finding, with the sources), not a short summary; a thin file is a failure. For research deliverables, write only what your sources state: a figure or claim you could not confirm must be removed, or kept: list the figure in unconfirmed and mark it as unconfirmed in the text, in the file's language. Large files: send them in parts (part=1,2,... with more=true on every part but the last; the file is created only by the last part, and contents are joined in order). Not for images or executables.\n\nPresentations (.pptx): you build the whole deck in one call. Plan a story first (title, agenda, sections, data, conclusion), 8-15 slides by default, and VARY the layouts instead of repeating bullets. Per slide: layout (title, agenda, section, bullets, two_column, image, chart, table, quote, stats, timeline, closing), title, optional notes (speaker notes). bullets: up to 6 short ones, each a string or {text, sub[]}. two_column: columns [{heading, bullets[]}, {heading, bullets[]}]. stats (KPI cards, 1-4): stats [{value, label, detail?}] with detail such as '+11% vs. last month'; use it for key numbers (big_number is accepted as an alias). chart: chart {type: bar|line|area|pie, x, series[{key,label}], data[rows], unit?} (same spec as the chat charts; one pie series; at most 40 points); prefer a chart or stats over numbers in bullets. table: columns[], rows[][] (max 8 columns, 14 rows). timeline: steps [{label, title, text?}] (2-6). quote: quote, author?. image: image = id of an attached image or of one made with generate_image (never a URL), optional bullets and caption. closing: title, subtitle?, bullets[] for next steps. Numbers and facts in slides must come from the user or from tool results; never invent them. theme: clean (default), dark, corporate or vivid; brand_color: optional hex such as #1d6b3a to match the user's brand. The old {title, bullets[]} slides still work. Ask the user first only when essential information is missing (topic, audience); otherwise make reasonable choices and deliver.",
		parameters: {
			type: "object",
			properties: {
				filename: { type: "string", description: "e.g. report.pdf, summary.docx, prices.xlsx, script.py" },
				format: { type: "string", description: "Optional; inferred from the filename extension" },
				content: {
					type: "string",
					description: `File text or Markdown (max ${FILE_MAX_CONTENT_CHARS} chars). Required for everything except xlsx/pptx.`,
				},
				part: { type: "integer", description: "Large files: 1-based part number; send parts in order, never repeat a part." },
				more: { type: "boolean", description: "true = more parts follow (nothing is created yet); false/omitted = last part, creates the file." },
				title: { type: "string", description: "Optional document title (docx/pdf/pptx)" },
				css: { type: "string", description: "Optional extra CSS for pdf" },
				layout: {
					type: "string",
					enum: ["default", "abnt"],
					description: "docx/pdf only. \"abnt\" formats the Markdown as an ABNT academic document (NBR 14724); conventions are in the built-in skill \"Trabalhos acadêmicos\". Omit for the normal layout.",
				},
				unconfirmed: {
					type: "array",
					items: { type: "string" },
					description: "Research files: figures kept in the file that no source confirms, written as in the file (max 30, 50 chars each). Mark each as unconfirmed in the text too.",
				},
				sheets: {
					type: "array",
					description: "xlsx only",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							columns: { type: "array", items: { type: "string" } },
							rows: { type: "array", items: { type: "array", items: {} } },
						},
						required: ["rows"],
					},
				},
				theme: { type: "string", enum: [...DECK_THEMES], description: "pptx only. Visual theme; default clean." },
				brand_color: { type: "string", description: "pptx only. Optional brand color as hex, e.g. #1d6b3a." },
				slides: {
					type: "array",
					description: `pptx only, up to ${DECK_MAX_SLIDES} slides. Fields by layout are in the tool description.`,
					items: {
						type: "object",
						properties: {
							layout: { type: "string", enum: [...DECK_LAYOUTS], description: "Default bullets." },
							title: { type: "string" },
							subtitle: { type: "string" },
							bullets: { type: "array", items: {} },
							items: { type: "array", items: { type: "string" }, description: "agenda" },
							columns: { type: "array", items: {}, description: "two_column: [{heading, bullets[]}, {heading, bullets[]}]; table: header strings" },
							rows: { type: "array", items: { type: "array", items: {} }, description: "table" },
							stats: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, detail: { type: "string" } }, required: ["value", "label"] } },
							steps: { type: "array", items: { type: "object", properties: { label: { type: "string" }, title: { type: "string" }, text: { type: "string" } }, required: ["label", "title"] } },
							chart: { type: "object", description: "chart spec: {type, x, series, data, unit?}" },
							image: { type: "string", description: "Attachment id or generate_image artifact id" },
							quote: { type: "string" },
							author: { type: "string" },
							caption: { type: "string" },
							notes: { type: "string", description: "Speaker notes" },
						},
					},
				},
			},
			required: ["filename"],
		},
	},
};

export type FileEvent = Extract<ComputerUseEvent, { type: "file" }>;

export type CreateFileDeps = {
	persist: (input: PersistUserArtifactInput) => Promise<UserArtifact>;
	nextVersion: typeof nextFileVersion;
	countRunFiles: typeof countRunFileArtifacts;
	printPdf: PrintPdf;
	loadArtifact?: DeckImageSource["loadArtifact"];
};

const DEFAULT_DEPS: CreateFileDeps = {
	persist: persistUserArtifact,
	nextVersion: nextFileVersion,
	countRunFiles: countRunFileArtifacts,
	printPdf: printPdfWithChromium,
};

export type CreateFileContext = {
	signal?: AbortSignal;
	deadlineAtMs?: number;
	userId: string | undefined;
	runId?: string;
	conversationId?: string;
	/** Anexos do usuário na conversa: fonte das imagens dos slides (junto das imagens geradas). */
	attachmentFiles?: DeckImageSource["attachments"];
};

type StagedFile = {
	nextPart: number;
	content: string;
	sheets: unknown[];
	slides: unknown[];
	title?: unknown;
	css?: unknown;
	layout?: unknown;
	theme?: unknown;
	brandColor?: unknown;
	format?: unknown;
	touchedAt: number;
};

/** Partes de arquivos grandes (A8): ficam em memória até a última parte; sobrevivem só ao processo do run. */
const stagedFiles = new Map<string, StagedFile>();
const STAGE_TTL_MS = 30 * 60_000;
const STAGE_MAX_ENTRIES = 40;

function stageKey(args: Record<string, unknown>, ctx: CreateFileContext): string {
	const name = typeof args.filename === "string" ? args.filename.trim().toLowerCase() : "";
	return `${ctx.userId ?? ""}:${ctx.runId ?? "local"}:${name}`;
}

function pruneStaged(now: number): void {
	for (const [key, value] of stagedFiles) if (now - value.touchedAt > STAGE_TTL_MS) stagedFiles.delete(key);
	while (stagedFiles.size > STAGE_MAX_ENTRIES) {
		const oldest = stagedFiles.keys().next().value;
		if (oldest === undefined) break;
		stagedFiles.delete(oldest);
	}
}

/** Testes: limpa as partes guardadas. */
export function resetStagedFilesForTest(): void {
	stagedFiles.clear();
}

function partNumber(args: Record<string, unknown>): number | undefined {
	if (args.part === undefined || args.part === null) return args.more === true ? 1 : undefined;
	const n = typeof args.part === "string" ? Number(args.part) : args.part;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error("part must be a positive integer (1, 2, 3...).");
	return n;
}

function mergeInto(base: StagedFile, args: Record<string, unknown>): StagedFile {
	return {
		...base,
		content: base.content + (typeof args.content === "string" ? args.content : ""),
		sheets: [...base.sheets, ...(Array.isArray(args.sheets) ? args.sheets : [])],
		slides: [...base.slides, ...(Array.isArray(args.slides) ? args.slides : [])],
		title: base.title ?? args.title,
		css: base.css ?? args.css,
		layout: base.layout ?? args.layout,
		theme: base.theme ?? args.theme,
		brandColor: base.brandColor ?? args.brand_color,
		format: base.format ?? args.format,
		touchedAt: Date.now(),
	};
}

function emptyStage(): StagedFile {
	return { nextPart: 1, content: "", sheets: [], slides: [], touchedAt: Date.now() };
}

function outOfOrder(part: number, staged: StagedFile | undefined): Error {
	return new Error(
		staged
			? `Part ${part} is out of order: parts 1-${staged.nextPart - 1} are stored, so send part ${staged.nextPart} next (or part=1 to start over).`
			: "No earlier parts are stored for this file (they are lost if the run restarted). Start again with part=1 and more=true.",
	);
}

/** Args completos do arquivo a validar (parte final = partes guardadas + esta); sem partes, os próprios args. Não altera o estado. */
export function previewCreateFileArgs(args: Record<string, unknown>, ctx: CreateFileContext): Record<string, unknown> {
	const part = partNumber(args);
	if (part === undefined || part === 1) return args;
	const staged = stagedFiles.get(stageKey(args, ctx));
	if (!staged || staged.nextPart !== part) return args;
	const merged = mergeInto(staged, args);
	return { ...args, content: merged.content, sheets: merged.sheets, slides: merged.slides, title: merged.title, css: merged.css, layout: merged.layout, theme: merged.theme, brand_color: merged.brandColor, format: merged.format };
}

export async function executeCreateFile(
	args: Record<string, unknown>,
	ctx: CreateFileContext,
	deps: Partial<CreateFileDeps> = {},
): Promise<{ summary: string; fileEvent?: FileEvent }> {
	const d = { ...DEFAULT_DEPS, ...deps };
	if (!ctx.userId) throw new Error("create_file needs a signed-in user.");
	// A8: arquivo em partes. Partes intermediárias só guardam; a última junta tudo e renderiza.
	const part = partNumber(args);
	let stagedKeyToClear: string | undefined;
	if (part !== undefined) {
		if (typeof args.filename !== "string" || !args.filename.trim()) throw new Error("filename is required (e.g. report.pdf).");
		const key = stageKey(args, ctx);
		pruneStaged(Date.now());
		const previous = part === 1 ? emptyStage() : stagedFiles.get(key);
		if (!previous || previous.nextPart !== part) throw outOfOrder(part, previous);
		const merged = { ...mergeInto(previous, args), nextPart: part + 1 };
		if (args.more === true) {
			if (merged.content.length > FILE_MAX_CONTENT_CHARS) {
				throw new Error(`content is too long (${merged.content.length} chars, max ${FILE_MAX_CONTENT_CHARS}). Finish the file now with more=false or split it into several files.`);
			}
			stagedFiles.set(key, merged);
			return {
				summary: `Part ${part} stored (${merged.content.length} chars so far). Nothing is created yet. Send part ${part + 1} next, with more=true if more follows or more=false for the last part. Do not repeat earlier parts.`,
			};
		}
		args = { ...args, content: merged.content, sheets: merged.sheets, slides: merged.slides, title: merged.title, css: merged.css, layout: merged.layout, theme: merged.theme, brand_color: merged.brandColor, format: merged.format };
		stagedKeyToClear = key;
	}
	// Valida antes de gastar render: erro acionável volta ao modelo.
	const input = parseCreateFileArgs(args);
	assertSandboxExecution(ctx);

	if (ctx.runId) {
		const already = await d.countRunFiles(ctx.runId, ctx.userId);
		if (already >= FILES_PER_RUN_MAX) {
			throw new Error(`File limit reached for this run (max ${FILES_PER_RUN_MAX}). Tell the user and offer to continue in a new message.`);
		}
	}

	const deckImages =
		input.slides && deckImageIds(input.slides).length > 0
			? await resolveDeckImages(input.slides, { userId: ctx.userId, conversationId: ctx.conversationId, attachments: ctx.attachmentFiles, loadArtifact: d.loadArtifact })
			: undefined;
	const rendered = await runSandboxOperation(ctx, 60_000, (signal) => renderFile(input, { printPdf: (html, _signal, options) => d.printPdf(html, signal, options), deckImages }));
	assertSandboxExecution(ctx);
	const version = await d.nextVersion({
		userId: ctx.userId,
		conversationId: ctx.conversationId,
		runId: ctx.runId,
		filename: input.filename,
	});
	const meta: Omit<FileArtifactMeta, "mime" | "size"> = {
		filename: input.filename,
		format: input.format,
		ext: rendered.ext,
		version,
		...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
	};
	assertSandboxExecution(ctx);
	const artifact = await d.persist({
		userId: ctx.userId,
		runId: ctx.runId,
		conversationId: ctx.conversationId,
		kind: "file",
		bytes: rendered.bytes,
		mime: rendered.mime,
		meta,
	});
	if (stagedKeyToClear) stagedFiles.delete(stagedKeyToClear);
	const size = rendered.bytes.byteLength;
	const fileEvent: FileEvent = {
		type: "file",
		artifactId: artifact.id,
		filename: input.filename,
		mime: rendered.mime,
		size,
		format: input.format,
		version,
		...(ctx.runId ? { runId: ctx.runId } : {}),
	};
	// Conferência barata (sem sandbox): estima estouro de texto, sobreposição e contraste a partir dos próprios slides.
	const layoutCheck = input.format === "pptx" && input.slides ? formatDeckWarnings(lintDeck(input.slides, { theme: input.theme, brandColor: input.brandColor })) : "";
	return {
		summary: `File created: ${input.filename} (${formatFileSize(size)}${version > 1 ? `, v${version}` : ""}). The chat already shows the file card; reply with one short line and do not repeat the content. If you later find an error in this file, call create_file again with the same filename and the fix instead of offering to.${input.format === "pptx" ? ` To check the slides visually, run_code with files ["${artifact.id}"] (see the Files skill, section 8).` : ""}${layoutCheck ? `\n${layoutCheck}` : ""}`,
		fileEvent,
	};
}
