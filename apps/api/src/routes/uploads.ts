import { Hono } from "hono";
import { processImageForStorage } from "@workspace/agent-runtime";
import { persistUserArtifact, sanitizeArtifactName } from "@workspace/db";
import { ATTACHMENT_LIMITS, classifyAttachment, IMAGE_LIMITS, sniffImageType } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

const MAX_MULTIPART_BYTES = IMAGE_LIMITS.maxBytes + 64 * 1024;
const MAX_FILE_MULTIPART_BYTES = ATTACHMENT_LIMITS.maxBytes + 64 * 1024;
const RATE_WINDOW_MS = 10 * 60_000;
const MAX_UPLOADS_PER_WINDOW = 30;
const attempts = new Map<string, { count: number; expires: number }>();

function allowUpload(userId: string, now = Date.now()): boolean {
	const row = attempts.get(userId);
	if (!row || row.expires <= now) {
		attempts.set(userId, { count: 1, expires: now + RATE_WINDOW_MS });
		return true;
	}
	if (row.count >= MAX_UPLOADS_PER_WINDOW) return false;
	row.count += 1;
	return true;
}

async function readLimited(request: Request, maxBytes: number): Promise<Uint8Array | null> {
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
	return output;
}

type MultipartResult = { file: File } | { status: 400 | 413; error: string };

/** Lê o multipart com teto de bytes (corpo e `Content-Length`) e devolve o campo `file`. */
async function readMultipartFile(request: Request, contentType: string, maxBytes: number, tooBig: string): Promise<MultipartResult> {
	if (!/^multipart\/form-data\s*;/i.test(contentType)) return { status: 400, error: "multipart/form-data obrigatório" };
	const contentLength = Number(request.headers.get("Content-Length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) return { status: 413, error: tooBig };
	const raw = await readLimited(request, maxBytes);
	if (!raw) return { status: 413, error: tooBig };
	let file: File | null = null;
	try {
		const form = await new Request("http://localhost/upload", { method: "POST", headers: { "Content-Type": contentType }, body: Uint8Array.from(raw) }).formData();
		const value = form.get("file");
		file = value instanceof File ? value : null;
	} catch { return { status: 400, error: "Multipart inválido" }; }
	if (!file) return { status: 400, error: "Arquivo obrigatório" };
	return { file };
}

export function createUploadRoutes(dependencies: {
	processImage?: typeof processImageForStorage;
	persistArtifact?: typeof persistUserArtifact;
	/** Pede ao worker que leia o anexo já (fila); falha nunca atrapalha o upload. */
	enqueueExtract?: (input: { userId: string; artifactId: string }) => Promise<unknown>;
} = {}) {
	const app = new Hono<AuthEnv>();
	app.post("/v1/uploads/images", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!allowUpload(userId)) return c.json({ error: "Limite de uploads excedido" }, 429);
		const read = await readMultipartFile(c.req.raw, c.req.header("Content-Type") ?? "", MAX_MULTIPART_BYTES, "Imagem maior que 10 MB");
		if ("error" in read) return c.json({ error: read.error }, read.status);
		const file = read.file;
		if (file.size > IMAGE_LIMITS.maxBytes) return c.json({ error: "Imagem maior que 10 MB" }, 413);
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (!sniffImageType(bytes)) return c.json({ error: "Formato de imagem não suportado" }, 415);
		let processed: Awaited<ReturnType<typeof processImageForStorage>>;
		try { processed = await (dependencies.processImage ?? processImageForStorage)(Buffer.from(bytes)); }
		catch { return c.json({ error: "Imagem inválida ou não suportada" }, 415); }
		const name = sanitizeArtifactName(file.name);
		const { id } = await (dependencies.persistArtifact ?? persistUserArtifact)({ userId, kind: "image", bytes: processed.bytes, mime: processed.mime, meta: { source: "upload", origin: "user", width: processed.width, height: processed.height, name } });
		return c.json({ id, mime: processed.mime, width: processed.width, height: processed.height, name, url: `/v1/files/${id}` }, 201);
	});

	/**
	 * Anexo de arquivo do chat (PDF, Office, planilha, texto, zip...). O tipo vem do conteúdo e da
	 * extensão (o MIME do cliente é ignorado), o nome é sanitizado e o arquivo nunca é executado:
	 * fica como artefato `file` do dono, baixado sempre como anexo com `nosniff`.
	 */
	app.post("/v1/uploads/files", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		if (!allowUpload(userId)) return c.json({ error: "Limite de uploads excedido" }, 429);
		const read = await readMultipartFile(c.req.raw, c.req.header("Content-Type") ?? "", MAX_FILE_MULTIPART_BYTES, "Arquivo maior que 20 MB");
		if ("error" in read) return c.json({ error: read.error }, read.status);
		if (read.file.size > ATTACHMENT_LIMITS.maxBytes) return c.json({ error: "Arquivo maior que 20 MB" }, 413);
		const bytes = new Uint8Array(await read.file.arrayBuffer());
		const verdict = classifyAttachment(read.file.name, bytes);
		if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);
		try {
			const { id } = await (dependencies.persistArtifact ?? persistUserArtifact)({
				userId,
				kind: "file",
				bytes,
				mime: verdict.mime,
				meta: { source: "upload", origin: "user", filename: verdict.filename, attachmentKind: verdict.kind },
			});
			if (verdict.kind !== "other" && verdict.kind !== "zip") void dependencies.enqueueExtract?.({ userId, artifactId: id })?.catch(() => undefined);
			return c.json({ id, name: verdict.filename, mime: verdict.mime, size: bytes.byteLength, kind: verdict.kind, url: `/v1/files/${id}` }, 201);
		} catch {
			return c.json({ error: "Não foi possível guardar o arquivo" }, 503);
		}
	});
	return app;
}
