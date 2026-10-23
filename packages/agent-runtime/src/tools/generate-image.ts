import { persistUserArtifact } from "@workspace/db";
import { generateImages, type ChatTool } from "@workspace/llm";
import { processImageForStorage } from "../images/process.js";
import type { ShowImageEvent } from "./show-image.js";

export const IMAGE_MODEL_MISSING_MESSAGE =
	"Nenhum modelo de imagem configurado. Peça ao usuário para configurar um em Configurações › Modelos › Modelo para gerar imagens (precisa ser um modelo do OpenRouter que gera imagem).";

export const GENERATE_IMAGE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "generate_image",
		description: "Generate a new picture (paid). Call it directly whenever the user's latest message asks you to generate, create, draw, illustrate or design a new picture, logo, art or illustration (e.g. 'gera uma imagem de...', 'cria um logo', 'desenha...') — do not answer that you cannot make images. Do not use to find, search or show existing images, to take screenshots, to edit or transform an existing image (reference images are unavailable), or when text or a chart would do.",
		parameters: { type: "object", properties: {
			prompt: { type: "string", description: "The picture to create" },
			aspect_ratio: { type: "string", description: "Width:height such as 1:1 (default), 16:9, 9:16, 4:3, 3:4" }, n: { type: "integer", minimum: 1, maximum: 2 },
		}, required: ["prompt"] },
	},
};

export type GenerateImageArgs = { prompt: string; n: number; aspectRatio?: string;  };

export function parseGenerateImageArgs(args: Record<string, unknown>): GenerateImageArgs {
	if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 4000) throw new Error("Prompt de imagem inválido.");
	const n = args.n ?? 1;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 2) throw new Error("Gere uma ou duas imagens por chamada.");
	const aspectRatio = args.aspect_ratio;
	if (aspectRatio !== undefined && (typeof aspectRatio !== "string" || !/^\d{1,2}:\d{1,2}$/.test(aspectRatio))) throw new Error("Proporção de imagem inválida.");
	if (args.reference_artifact_id !== undefined) throw new Error("Edição por referência ainda não disponível; gere uma imagem nova.");
	return { prompt: args.prompt.trim(), n, ...(aspectRatio ? { aspectRatio: aspectRatio as string } : {}) };
}

export async function executeGenerateImage(args: GenerateImageArgs, ctx: {
	apiKey: string;
	model: string;
	userId: string;
	runId?: string;
	conversationId?: string;
	signal?: AbortSignal;
	onImages: (event: ShowImageEvent) => Promise<void>;
	/** `undefined` = o provider não informou o custo (conta como desconhecido). */
	onCost: (costUsd: number | undefined) => void;
}): Promise<{ summary: string; count: number }> {
	const generated = await generateImages({ apiKey: ctx.apiKey, model: ctx.model, prompt: args.prompt, n: args.n, aspectRatio: args.aspectRatio, signal: ctx.signal });
	ctx.onCost(generated.costUsd);
	const items: ShowImageEvent["items"] = [];
	for (const image of generated.images) {
		const processed = await processImageForStorage(image.bytes);
		const { id: artifactId } = await persistUserArtifact({
			userId: ctx.userId, runId: ctx.runId, conversationId: ctx.conversationId,
			kind: "image", bytes: processed.bytes, mime: processed.mime,
			meta: { mime: processed.mime, width: processed.width, height: processed.height, bytes: processed.bytes.byteLength, source: "generated", origin: "assistant" },
		});
		items.push({ artifactId, mime: processed.mime, width: processed.width, height: processed.height });
	}
	await ctx.onImages({ type: "images", origin: "assistant", items });
	return { summary: `Imagem gerada: ${items.length}. Image id${items.length > 1 ? "s" : ""}: ${items.map((item) => item.artifactId).join(", ")} (use as a slide background or image in create_file; never a URL).`, count: items.length };
}
