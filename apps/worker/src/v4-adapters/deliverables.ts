// Portas das entregas ricas do v4 no worker (F2.6): `DeliverableFiles`, `PageStore`, `ChartStore` e o `FileStore`
// simples. Renderiza com `@workspace/files` e grava com as funções do db que o v2 já usa (artefato do dono, painel, cartão
// da conversa). Montado POR RUN: o bot, a conversa e o `emit` vêm do run, nunca de argumento do modelo.
//
// Escopo: tudo recebe o `userId` do run. `inspect` lê só artefato do dono (`loadArtifactForUser` filtra por dono); arquivo
// de outro dono e id inexistente dão o mesmo `null` (a tool devolve o mesmo erro).
import { createHash } from "node:crypto";
import type { ChartStore, DeliverableFile, DeliverablePorts, DeliverableFiles, FileInspection, FileStore, InspectPage, PageStore } from "@workspace/agent";
import { renderFile, type RenderedFile } from "@workspace/files/render";
import { printPdfWithChromium } from "@workspace/files/pdf-chromium";
import { INSPECT_LIMITS, buildFilePreview } from "@workspace/files/preview";
import { countRunFileArtifacts, createOrRotatePageShare, createPage, getPageForUser, getPageShareStatus, listBotPagesForUser, loadArtifactForUser, nextFileVersion, persistConversationCardFromEvent, persistUserArtifact, revokePageShare, updatePage } from "@workspace/db";
import { FILES_PER_RUN_MAX, decodeEntities, deckImageIds, type ChartSpec, type ComputerUseEvent, type CreateFileInput, type FileArtifactMeta, type PageSpec } from "@workspace/shared";

/** Funções do db e do renderizador usadas aqui; injetáveis para o teste (sem banco, sem Chromium). */
export type V4DeliverablesDeps = {
	persistArtifact: typeof persistUserArtifact;
	nextVersion: typeof nextFileVersion;
	countRunFiles: typeof countRunFileArtifacts;
	loadArtifact: (artifactId: string, userId: string) => Promise<{ id: string; kind: string; meta: Record<string, unknown>; bytes: Uint8Array } | null>;
	createPage: typeof createPage;
	getPage: typeof getPageForUser;
	listPages: typeof listBotPagesForUser;
	updatePage: typeof updatePage;
	shareStatus: typeof getPageShareStatus;
	createShare: typeof createOrRotatePageShare;
	revokeShare: typeof revokePageShare;
	/** Base pública do web (onde mora `/p/:token`); vazio = não configurada (compartilhar falha com o motivo). */
	publicWebUrl: () => string;
	render: (input: CreateFileInput) => Promise<RenderedFile>;
	preview: typeof buildFilePreview;
	/** Grava o cartão na conversa (mesmo caminho do v2: `persistConversationCardFromEvent`). */
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4DeliverablesDeps: V4DeliverablesDeps = {
	persistArtifact: persistUserArtifact,
	nextVersion: nextFileVersion,
	countRunFiles: countRunFileArtifacts,
	loadArtifact: loadArtifactForUser,
	createPage,
	getPage: getPageForUser,
	listPages: listBotPagesForUser,
	updatePage,
	shareStatus: getPageShareStatus,
	createShare: createOrRotatePageShare,
	revokeShare: revokePageShare,
	publicWebUrl: () => (process.env.ATLAS_URL ?? "").trim().replace(/\/$/, ""),
	render: (input) => renderFile(input, { printPdf: printPdfWithChromium }),
	preview: buildFilePreview,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

/** O que é do run: preso na montagem. */
export type V4DeliverablesScope = {
	conversationId?: string | null;
	/** Bot do run; painel precisa dele. Sem bot, criar painel falha com o motivo. */
	botId?: string | null;
	/**
	 * Run de ROTINA com painel (F9 parte 2): o painel que a rotina reconstrói a cada execução. Neste run só ele pode ser atualizado
	 * (outro painel do dono, mesmo do mesmo bot, é recusado com o id certo) e cada gravação marca `refreshed` (a "atualizado em" do painel).
	 */
	routinePageId?: string | null;
	/** Evento ao vivo do contrato SSE (o cartão na tela agora; o da conversa já foi gravado por `persistCard`). */
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	/** Log do run; falha técnica de cartão vai aqui (sem segredo). Padrão: `console.warn`. */
	log?: (message: string) => void;
};

const FORMAT_OF_EXT: Readonly<Record<string, FileArtifactMeta["format"]>> = { docx: "docx", pdf: "pdf", xlsx: "xlsx", pptx: "pptx" };

/** Texto simples do HTML já sanitizado da prévia de .docx (quebras por bloco; entidades pelo decode de `shared`). */
export function htmlToPlainText(html: string): string {
	return decodeEntities(
		html
			.replace(/<\/(p|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/t[dh]>/gi, "\t")
			.replace(/<[^>]*>/g, ""),
	)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Limite técnico POR PÁGINA de `inspect_file` (o arquivo inteiro se lê em várias páginas; nada é descartado). */
export const INSPECT_PAGE_CHARS = 20_000;
export const INSPECT_PAGE_ROWS = 200;

function pageOfText(base: { name: string; bytes: number }, full: string, page: InspectPage): FileInspection {
	if (page.sheet !== undefined || page.startRow !== undefined) throw new Error("sheet and start_row apply to spreadsheets only; this file is text. Use offset to read further.");
	const start = page.offset ?? 0;
	if (start > 0 && start >= full.length) throw new Error(`offset ${start} is past the end of the text (${full.length} characters). Use an offset below ${full.length}.`);
	const end = Math.min(start + INSPECT_PAGE_CHARS, full.length);
	return { ...base, text: full.slice(start, end), textRange: { start, end, total: full.length }, truncated: end < full.length };
}

function pageOfSheets(base: { name: string; bytes: number }, sheets: ReadonlyArray<{ name: string; rows: string[][] }>, page: InspectPage): FileInspection {
	if (page.offset !== undefined) throw new Error("offset applies to text files only; this file is a spreadsheet. Use sheet and start_row.");
	if (page.startRow !== undefined && page.sheet === undefined) throw new Error(`start_row needs sheet. Sheets: ${sheets.map((s) => s.name).join(", ")}.`);
	const chosen = page.sheet === undefined ? sheets : sheets.filter((sheet) => sheet.name === page.sheet);
	if (chosen.length === 0) throw new Error(`Sheet "${page.sheet}" not found. Sheets: ${sheets.map((s) => s.name).join(", ")}.`);
	const startRow = page.startRow ?? 1;
	const parts = chosen.map((sheet) => {
		if (startRow > 1 && startRow > sheet.rows.length) throw new Error(`start_row ${startRow} is past the end of "${sheet.name}" (${sheet.rows.length} rows).`);
		const rows = sheet.rows.slice(startRow - 1, startRow - 1 + INSPECT_PAGE_ROWS);
		return { name: sheet.name, rows, startRow, totalRows: sheet.rows.length, truncated: startRow - 1 + rows.length < sheet.rows.length };
	});
	return { ...base, sheets: parts, truncated: parts.some((part) => part.truncated) };
}

const NO_TEXT_NOTE = "No text can be read from this file type here (PDF, image or presentation). Tell the owner plainly and offer another way, e.g. to share the text.";

function createFiles(scope: V4DeliverablesScope, deps: V4DeliverablesDeps): DeliverableFiles {
	return {
		async create(userId, runId, input) {
			if ((await deps.countRunFiles(runId, userId)) >= FILES_PER_RUN_MAX) {
				throw new Error(`File limit reached for this run (max ${FILES_PER_RUN_MAX}). Tell the owner and offer to continue in a new message.`);
			}
			// Imagens em slide e modelo .pptx do dono dependem de leitura de anexos e da VM, que o v4 ainda não tem.
			if (input.slides && deckImageIds(input.slides).length > 0) throw new Error("Images inside slides are not available yet. Build the deck without images, or tell the owner.");
			if (input.templateFileId) throw new Error("Using a .pptx template is not available yet. Build the deck with a built-in theme, or tell the owner.");
			const rendered = await deps.render(input);
			const version = await deps.nextVersion({ userId, conversationId: scope.conversationId ?? null, runId, filename: input.filename });
			const meta: Omit<FileArtifactMeta, "mime" | "size"> = {
				filename: input.filename,
				format: input.format,
				ext: rendered.ext,
				version,
				...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
			};
			const artifact = await deps.persistArtifact({ userId, runId, conversationId: scope.conversationId ?? null, kind: "file", bytes: rendered.bytes, mime: rendered.mime, meta });
			const event: ComputerUseEvent = { type: "file", artifactId: artifact.id, filename: input.filename, mime: rendered.mime, size: rendered.bytes.byteLength, format: FORMAT_OF_EXT[rendered.ext] ?? "text", version, runId };
			await showCard(scope, deps, event);
			const file: DeliverableFile = { id: artifact.id, name: input.filename, bytes: rendered.bytes.byteLength, version };
			return file;
		},
		async inspect(userId, fileId, page: InspectPage = {}): Promise<FileInspection | null> {
			const artifact = await deps.loadArtifact(fileId, userId);
			// Só arquivo (gerado ou enviado pelo dono); screenshot e resultado de tool não são "arquivo do dono".
			if (!artifact || artifact.kind !== "file") return null;
			const name = typeof artifact.meta.filename === "string" && artifact.meta.filename ? artifact.meta.filename : `file-${artifact.id}`;
			const base = { name, bytes: artifact.bytes.byteLength };
			// Teto técnico alto: a leitura é paginada aqui, não cortada pela prévia da tela.
			const preview = await deps.preview({ id: artifact.id, filename: name, bytes: artifact.bytes }, INSPECT_LIMITS);
			switch (preview.kind) {
				case "text":
					return pageOfText(base, preview.text, page);
				case "html":
					return pageOfText(base, htmlToPlainText(preview.html), page);
				case "sheets":
					return pageOfSheets(base, preview.sheets, page);
				default:
					return { ...base, text: NO_TEXT_NOTE, truncated: false };
			}
		},
	};
}

/** Cartão persistido na conversa (se houver) e evento ao vivo. A falha do cartão não desfaz o artefato já criado. */
async function showCard(scope: V4DeliverablesScope, deps: V4DeliverablesDeps, event: ComputerUseEvent): Promise<void> {
	if (scope.conversationId) {
		await deps.persistCard(scope.conversationId, event).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : "unknown error";
			(scope.log ?? console.warn)(`[engine-v4] cartão "${event.type}" não gravado na conversa (o artefato já existe): ${reason.slice(0, 200)}`);
		});
	}
	await scope.emit(event);
}

function createPages(scope: V4DeliverablesScope, deps: V4DeliverablesDeps): PageStore {
	const requireBot = (): string => {
		if (!scope.botId) throw new Error("Panels belong to a bot, and this run has none. Tell the owner plainly.");
		return scope.botId;
	};
	// Painel só do dono E deste bot: o db filtra por dono; o bot confere aqui (outro bot do mesmo dono = not found, como no legado).
	const own = async (userId: string, pageId: string) => {
		const botId = requireBot();
		const page = await deps.getPage(pageId, userId);
		return page && page.botId === botId ? page : null;
	};
	return {
		async save(userId, runId, spec: PageSpec) {
			const botId = requireBot();
			const page = await deps.createPage(userId, { botId, conversationId: scope.conversationId ?? null, spec });
			if (!page) throw new Error("Could not create the panel for this bot. Tell the owner it failed; do not retry in a loop.");
			await showCard(scope, deps, { type: "page", action: "created", pageId: page.id, revision: page.revision, title: page.title, spec: page.spec, sourceCount: page.sources.length, runId });
			return { id: page.id, title: page.title };
		},
		async list(userId) {
			const items = await deps.listPages(userId, requireBot());
			return (items ?? []).map((item) => ({ id: item.id, title: item.title, revision: item.revision, updatedAt: item.updatedAt, groupName: item.groupName ?? null, ...(item.summary ? { summary: item.summary } : {}) }));
		},
		async read(userId, pageId) {
			const page = await own(userId, pageId);
			if (!page) return null;
			const status = await deps.shareStatus(pageId, userId);
			return { id: page.id, title: page.title, revision: page.revision, spec: page.spec, sourceCount: page.sources.length, shared: status?.active === true };
		},
		async update(userId, runId, pageId, spec, expectedRevision) {
			if (scope.routinePageId && pageId !== scope.routinePageId) {
				throw new Error(`This routine run may only update its own panel (panel_id ${scope.routinePageId}); ${pageId} is not it. Call panel_update with panel_id ${scope.routinePageId}.`);
			}
			if (!(await own(userId, pageId))) return { ok: false, error: "not_found" };
			const result = await deps.updatePage(pageId, userId, { spec, expectedRevision, ...(scope.routinePageId ? { refreshed: true } : {}) });
			if (!result.ok) return result;
			const page = result.page;
			// Mesmo `pageId` do cartão criado: o merge da conversa troca a revisão no lugar, sem cartão novo.
			await showCard(scope, deps, { type: "page", action: "updated", pageId: page.id, revision: page.revision, title: page.title, spec: page.spec, sourceCount: page.sources.length, runId });
			return { ok: true, id: page.id, title: page.title, revision: page.revision };
		},
		async share(userId, pageId) {
			if (!(await own(userId, pageId))) return null;
			const base = deps.publicWebUrl();
			if (!base) throw new Error("The public web address is not configured on the server. Tell the owner the link cannot be created from chat; they can use Compartilhar > Link público in the panel.");
			const created = await deps.createShare(pageId, userId);
			return created ? { url: `${base}/p/${created.token}` } : null;
		},
		async unshare(userId, pageId) {
			if (!(await own(userId, pageId))) return null;
			return deps.revokeShare(pageId, userId);
		},
	};
}

function createCharts(scope: V4DeliverablesScope, deps: V4DeliverablesDeps): ChartStore {
	// Id estável por (run, conteúdo): o mesmo gráfico refeito não duplica o cartão. Dentro do run o cartão é gravado e emitido
	// uma vez por `chartId`; a retomada (adaptador novo) cai no dedupe por `chartId` do merge da conversa.
	const shown = new Set<string>();
	return {
		async save(_userId, runId, spec: ChartSpec) {
			if (!scope.conversationId) throw new Error("Charts are drawn in the conversation, and this run has none. Tell the owner plainly.");
			const chartId = `${runId}:chart:${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 12)}`;
			if (!shown.has(chartId)) {
				shown.add(chartId);
				await showCard(scope, deps, { type: "chart", chartId, spec, runId });
			}
			return { id: chartId };
		},
	};
}

/** `FileStore` do `deliverables-lite` (texto simples): o preset exige a porta mesmo quando as entregas ricas a substituem. */
function createTextFileStore(scope: V4DeliverablesScope, deps: V4DeliverablesDeps, runId: string): FileStore {
	return {
		async put(userId, file) {
			const bytes = new TextEncoder().encode(file.content);
			const artifact = await deps.persistArtifact({
				userId,
				runId,
				conversationId: scope.conversationId ?? null,
				kind: "file",
				bytes,
				mime: file.mimeType,
				meta: { filename: file.name, format: "text", ext: file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase(), version: 1 },
			});
			return { id: artifact.id, name: file.name, bytes: bytes.byteLength };
		},
	};
}

export function createV4Deliverables(input: { runId: string; scope: V4DeliverablesScope; deps?: V4DeliverablesDeps }): { ports: DeliverablePorts; fileStore: FileStore } {
	const deps = input.deps ?? realV4DeliverablesDeps;
	return {
		ports: { files: createFiles(input.scope, deps), pages: createPages(input.scope, deps), charts: createCharts(input.scope, deps) },
		fileStore: createTextFileStore(input.scope, deps, input.runId),
	};
}
