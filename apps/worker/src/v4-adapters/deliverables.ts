// Portas das entregas ricas do v4 no worker (F2.6): `DeliverableFiles`, `PageStore`, `ChartStore` e o `FileStore`
// simples. Renderiza com `@workspace/files` e grava com as funções do db que o v2 já usa (artefato do dono, painel, cartão
// da conversa). Montado POR RUN: o bot, a conversa e o `emit` vêm do run, nunca de argumento do modelo.
//
// Escopo: tudo recebe o `userId` do run. `inspect` lê só artefato do dono (`loadArtifactForUser` filtra por dono); arquivo
// de outro dono e id inexistente dão o mesmo `null` (a tool devolve o mesmo erro).
import { createHash } from "node:crypto";
import type { ChartStore, DeliverableFile, DeliverablePorts, DeliverableFiles, FileInspection, FileStore, PageStore } from "@workspace/agent";
import { renderFile, type RenderedFile } from "@workspace/files/render";
import { printPdfWithChromium } from "@workspace/files/pdf-chromium";
import { buildFilePreview } from "@workspace/files/preview";
import { countRunFileArtifacts, createPage, loadArtifactForUser, nextFileVersion, persistConversationCardFromEvent, persistUserArtifact } from "@workspace/db";
import { FILES_PER_RUN_MAX, decodeEntities, deckImageIds, type ChartSpec, type ComputerUseEvent, type CreateFileInput, type FileArtifactMeta, type PageSpec } from "@workspace/shared";

/** Funções do db e do renderizador usadas aqui; injetáveis para o teste (sem banco, sem Chromium). */
export type V4DeliverablesDeps = {
	persistArtifact: typeof persistUserArtifact;
	nextVersion: typeof nextFileVersion;
	countRunFiles: typeof countRunFileArtifacts;
	loadArtifact: (artifactId: string, userId: string) => Promise<{ id: string; kind: string; meta: Record<string, unknown>; bytes: Uint8Array } | null>;
	createPage: typeof createPage;
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
	render: (input) => renderFile(input, { printPdf: printPdfWithChromium }),
	preview: buildFilePreview,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

/** O que é do run: preso na montagem. */
export type V4DeliverablesScope = {
	conversationId?: string | null;
	/** Bot do run; painel precisa dele. Sem bot, criar painel falha com o motivo. */
	botId?: string | null;
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
		async inspect(userId, fileId): Promise<FileInspection | null> {
			const artifact = await deps.loadArtifact(fileId, userId);
			// Só arquivo (gerado ou enviado pelo dono); screenshot e resultado de tool não são "arquivo do dono".
			if (!artifact || artifact.kind !== "file") return null;
			const name = typeof artifact.meta.filename === "string" && artifact.meta.filename ? artifact.meta.filename : `file-${artifact.id}`;
			const bytes = artifact.bytes.byteLength;
			const preview = await deps.preview({ id: artifact.id, filename: name, bytes: artifact.bytes });
			switch (preview.kind) {
				case "text":
					return { name, bytes, text: preview.text, truncated: preview.truncated };
				case "html":
					return { name, bytes, text: htmlToPlainText(preview.html), truncated: false };
				case "sheets":
					return { name, bytes, sheets: preview.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows, truncated: sheet.truncated })), truncated: preview.sheets.some((sheet) => sheet.truncated) };
				default:
					return { name, bytes, text: NO_TEXT_NOTE, truncated: false };
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
	return {
		async save(userId, runId, spec: PageSpec) {
			if (!scope.botId) throw new Error("Panels belong to a bot, and this run has none. Tell the owner plainly.");
			const page = await deps.createPage(userId, { botId: scope.botId, conversationId: scope.conversationId ?? null, spec });
			if (!page) throw new Error("Could not create the panel for this bot. Tell the owner it failed; do not retry in a loop.");
			await showCard(scope, deps, { type: "page", action: "created", pageId: page.id, revision: page.revision, title: page.title, spec: page.spec, sourceCount: page.sources.length, runId });
			return { id: page.id, title: page.title };
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
