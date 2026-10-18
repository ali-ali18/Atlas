import { Hono } from "hono";
import { previewInThread } from "@workspace/agent-runtime";
import { listBotArtifactsForUser, loadArtifactForUser } from "@workspace/db";
import { contentDisposition, sanitizeFilename } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Arquivos e imagens do usuário (F9/F14). Sempre autenticado e escopado pelo
 * dono; recurso de outro usuário responde 404 (não revela que existe).
 */

type LoadArtifact = typeof loadArtifactForUser;

/** Tipos que o navegador pode exibir inline sem executar nada (SVG/HTML nunca). */
const INLINE_SAFE = /^(application\/pdf|image\/(png|jpeg|gif|webp))(;|$)/i;

const NOT_FOUND = { error: "File not found" } as const;

function storedFilename(id: string, meta: Record<string, unknown>): string {
	if (typeof meta.filename === "string" && meta.filename.trim()) return sanitizeFilename(meta.filename);
	const mime = typeof meta.mime === "string" ? meta.mime : "";
	const ext = mime === "image/jpeg" ? "jpg" : mime.startsWith("image/") ? mime.slice(6).replace(/[^a-z0-9]/g, "") : "bin";
	return sanitizeFilename(`${id}.${ext || "bin"}`);
}

type ListBotArtifacts = typeof listBotArtifactsForUser;

export function createFileRoutes(deps: { loadArtifact?: LoadArtifact; listBotArtifacts?: ListBotArtifacts; preview?: typeof previewInThread } = {}) {
	const app = new Hono<AuthEnv>();
	const load = deps.loadArtifact ?? loadArtifactForUser;
	const buildPreview = deps.preview ?? previewInThread;
	const listBotFiles = deps.listBotArtifacts ?? listBotArtifactsForUser;

	/** Biblioteca do bot: arquivos que ele criou, mais novos primeiro (só do dono). */
	app.get("/v1/bots/:botId/artifacts", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const limitRaw = c.req.query("limit");
		const limit = limitRaw === undefined ? undefined : Number(limitRaw);
		if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: "Invalid limit" }, 400);
		const cursor = c.req.query("cursor");
		if (cursor && Number.isNaN(new Date(cursor).getTime())) return c.json({ error: "Invalid cursor" }, 400);
		try {
			const body = await listBotFiles({
				userId,
				botId: c.req.param("botId"),
				...(limit !== undefined ? { limit } : {}),
				cursor: cursor || null,
			});
			if (!body) return c.json({ error: "Bot not found" }, 404);
			return c.json(body);
		} catch (error) {
			console.error("list bot artifacts failed", error);
			return c.json({ error: "Failed to list artifacts" }, 503);
		}
	});

	app.get("/v1/files/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const artifact = await load(c.req.param("id"), userId).catch(() => null);
		if (!artifact) return c.json(NOT_FOUND, 404);
		const mime = artifact.meta.mime;
		// `?inline=1` só vale para PDF/imagem raster; o resto sempre baixa.
		const inline = c.req.query("inline") === "1" && INLINE_SAFE.test(mime);
		return new Response(new Uint8Array(artifact.bytes), {
			status: 200,
			headers: {
				"Content-Type": mime,
				"Content-Length": String(artifact.bytes.byteLength),
				"Content-Disposition": contentDisposition(storedFilename(artifact.id, artifact.meta), inline),
				"Cache-Control": "private, max-age=3600",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
			},
		});
	});

	app.get("/v1/files/:id/preview", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const artifact = await load(c.req.param("id"), userId).catch(() => null);
		if (!artifact) return c.json(NOT_FOUND, 404);
		try {
			// Docx/planilha são lidos numa worker thread com limite de memória e prazo, nunca no loop da API.
			const preview = await buildPreview({
				id: artifact.id,
				filename: storedFilename(artifact.id, artifact.meta),
				bytes: artifact.bytes,
			});
			if (!preview) return c.json({ kind: "none", reason: "Não foi possível gerar a prévia. Baixe o arquivo." });
			return c.json(preview, 200, { "Cache-Control": "private, max-age=3600" });
		} catch {
			// Arquivo corrompido: o cartão ainda baixa; a prévia só diz que não deu.
			return c.json({ kind: "none", reason: "Não foi possível gerar a prévia. Baixe o arquivo." });
		}
	});

	return app;
}
