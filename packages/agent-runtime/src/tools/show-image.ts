import { loadArtifactForUser, persistUserArtifact } from "@workspace/db";
import type { ChatTool } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { fetchImageFromUrl } from "../images/fetch-image.js";
import { processImageForStorage } from "../images/process.js";

export const SHOW_IMAGE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "show_image",
		description: "Show an image to the user from a screenshot, owned artifact or direct public image URL. Use only when the user should see an image; do not use for an image already attached by the user.",
		parameters: { type: "object", properties: {
			source: { type: "string", enum: ["screenshot", "artifact", "url"] },
			artifact_id: { type: "string" }, url: { type: "string" }, alt: { type: "string" }, caption: { type: "string" },
			images: { type: "array", maxItems: 6, items: { type: "object", properties: { source: { type: "string", enum: ["screenshot", "artifact", "url"] }, artifact_id: { type: "string" }, url: { type: "string" }, alt: { type: "string" } }, required: ["source"] } },
		}, required: ["source"] },
	},
};

export type ShownImage = { artifactId: string; mime: string; width: number; height: number; alt?: string };
export type ShowImageEvent = { type: "images"; origin: "assistant"; items: ShownImage[]; caption?: string };

function optionalText(value: unknown, max: number, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > max) throw new Error(`${label} inválido.`);
	return value.trim() || undefined;
}

function parseItem(raw: unknown): { source: "screenshot" | "artifact" | "url"; artifactId?: string; url?: string; alt?: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Imagem inválida.");
	const item = raw as Record<string, unknown>;
	if (item.source !== "screenshot" && item.source !== "artifact" && item.source !== "url") throw new Error("Fonte de imagem inválida.");
	const alt = optionalText(item.alt, 200, "Texto alternativo");
	if (item.source === "artifact") {
		if (typeof item.artifact_id !== "string" || !item.artifact_id.trim()) throw new Error("Informe artifact_id da imagem.");
		return { source: item.source, artifactId: item.artifact_id.trim(), alt };
	}
	if (item.source === "url") {
		if (typeof item.url !== "string" || item.url.length > 2048) throw new Error("Informe a URL direta da imagem.");
		return { source: item.source, url: item.url, alt };
	}
	return { source: item.source, alt };
}

export async function executeShowImage(args: Record<string, unknown>, ctx: {
	userId: string;
	runId?: string;
	conversationId?: string;
	manager: Pick<SandboxManager, "execScreenshot">;
	getSessionId: () => Promise<string>;
	remaining: number;
	onImages: (event: ShowImageEvent) => Promise<void>;
}): Promise<{ summary: string; count: number; remaining: number }> {
	const rawItems = args.images === undefined ? [args] : args.images;
	if (!Array.isArray(rawItems) || rawItems.length < 1) {
		throw new Error("Informe ao menos uma imagem.");
	}
	if (rawItems.length > 6 || rawItems.length > ctx.remaining) {
		throw new Error(`IMAGE_DISPLAY_LIMIT: limite de 6 imagens por execução; restam ${Math.max(0, ctx.remaining)} nesta execução. Envie menos imagens ou solicite uma nova execução.`);
	}
	const caption = optionalText(args.caption, 300, "Legenda");
	const items: ShownImage[] = [];
	for (const raw of rawItems) {
		const item = parseItem(raw);
		if (item.source === "artifact") {
			const found = await loadArtifactForUser(item.artifactId!, ctx.userId);
			if (!found || (found.kind !== "image" && found.kind !== "screenshot")) throw new Error("Imagem não encontrada para este usuário.");
			const width = Number(found.meta.width);
			const height = Number(found.meta.height);
			if (found.kind === "image" && Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 && (found.meta.mime === "image/jpeg" || found.meta.mime === "image/png")) {
				items.push({ artifactId: found.id, mime: found.meta.mime, width, height, ...(item.alt ? { alt: item.alt } : {}) });
			} else {
				// Capturas legadas só guardavam os bytes; reencodar gera metadados válidos e remove EXIF.
				const processed = await processImageForStorage(found.bytes);
				const { id: artifactId } = await persistUserArtifact({
					userId: ctx.userId, runId: ctx.runId, conversationId: ctx.conversationId, kind: "image", bytes: processed.bytes, mime: processed.mime,
					meta: { width: processed.width, height: processed.height, source: found.kind, sourceArtifactId: found.id, origin: "assistant", ...(item.alt ? { alt: item.alt } : {}) },
				});
				items.push({ artifactId, mime: processed.mime, width: processed.width, height: processed.height, ...(item.alt ? { alt: item.alt } : {}) });
			}
			continue;
		}
		const source = item.source === "screenshot"
			? { bytes: await ctx.manager.execScreenshot(await ctx.getSessionId()), url: undefined }
			: await fetchImageFromUrl(item.url!);
		const processed = await processImageForStorage(source.bytes);
		const { id: artifactId } = await persistUserArtifact({
			userId: ctx.userId, runId: ctx.runId, conversationId: ctx.conversationId, kind: "image", bytes: processed.bytes, mime: processed.mime,
			meta: { mime: processed.mime, width: processed.width, height: processed.height, bytes: processed.bytes.byteLength, source: item.source, origin: "assistant", ...(source.url ? { sourceUrl: source.url } : {}), ...(item.alt ? { alt: item.alt } : {}) },
		});
		items.push({ artifactId, mime: processed.mime, width: processed.width, height: processed.height, ...(item.alt ? { alt: item.alt } : {}) });
	}
	await ctx.onImages({ type: "images", origin: "assistant", items, ...(caption ? { caption } : {}) });
	const remaining = ctx.remaining - items.length;
	return { summary: `Delivered ${items.length} image(s) to the user (${items.map((item) => `${item.width}x${item.height}`).join(", ")}). Remaining image deliveries in this execution: ${remaining} of 6.`, count: items.length, remaining };
}
