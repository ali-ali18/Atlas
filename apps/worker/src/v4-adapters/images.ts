// Porta de imagens do v4 no worker (F9): gera imagens novas com o modelo de imagem do dono, guarda cada uma como
// artefato do dono e mostra o evento `images` (o mesmo do legado: `origin: "assistant"`, `items` com `artifactId`,
// `mime`, `width`, `height`). O cartão é gravado na conversa pelo mesmo caminho do v2, então o chat agrupa gerações
// seguidas num baralho só. Montado POR RUN: dono, conversa e modelo vêm do run, nunca de argumento do modelo.
import type { GeneratedImageRef, GenerateImageInput, GenerateImageResult, Images } from "@workspace/agent";
import { persistConversationCardFromEvent, persistUserArtifact } from "@workspace/db";
import { processImageForStorage } from "@workspace/files/image-process";
import { generateImages } from "@workspace/llm";
import { sanitizeErrorMessage, type ComputerUseEvent } from "@workspace/shared";

/** Erro devolvido ao modelo quando o dono não escolheu modelo de imagem. Ele repassa a dica ao dono em português. */
export const IMAGE_MODEL_MISSING_ERROR =
	"No image model is configured, so no picture was made. Tell the owner, in Portuguese, to set one in Configurações › Modelos › Modelo para gerar imagens (an OpenRouter model that generates images), then ask again.";

/** Chave e modelo de imagem do run (o modelo do dono, ou `ATLAS_IMAGE_MODEL` como no legado). */
export type V4ImagesConfig = { apiKey: string; model: string };

/** Funções do db, do processamento e do provedor; injetáveis para o teste (sem banco, sem rede). */
export type V4ImagesDeps = {
	generate: typeof generateImages;
	process: typeof processImageForStorage;
	persistArtifact: typeof persistUserArtifact;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4ImagesDeps: V4ImagesDeps = {
	generate: generateImages,
	process: processImageForStorage,
	persistArtifact: persistUserArtifact,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4ImagesScope = {
	conversationId?: string | null;
	/** Evento ao vivo (o cartão na tela agora; o gravado na conversa já saiu por `persistCard`). */
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

export function createV4Images(input: { scope: V4ImagesScope; config?: V4ImagesConfig; deps?: V4ImagesDeps }): Images {
	const deps = input.deps ?? realV4ImagesDeps;
	const { scope, config } = input;
	const log = scope.log ?? console.warn;

	return {
		async generate(userId: string, runId: string, request: GenerateImageInput): Promise<GenerateImageResult> {
			if (!config) throw new Error(IMAGE_MODEL_MISSING_ERROR);
			let generated: Awaited<ReturnType<typeof generateImages>>;
			try {
				generated = await deps.generate({
					apiKey: config.apiKey,
					model: config.model,
					prompt: request.prompt,
					n: request.count,
					...(request.aspectRatio !== undefined && { aspectRatio: request.aspectRatio }),
					...(request.signal && { signal: request.signal }),
				});
			} catch (error) {
				// Erro do provedor pode trazer pedaço da requisição: sem a chave, como no legado.
				throw new Error(sanitizeErrorMessage(error, [config.apiKey]));
			}

			const images: GeneratedImageRef[] = [];
			for (const image of generated.images) {
				const processed = await deps.process(image.bytes);
				const { id } = await deps.persistArtifact({
					userId,
					runId,
					conversationId: scope.conversationId ?? null,
					kind: "image",
					bytes: processed.bytes,
					mime: processed.mime,
					meta: { mime: processed.mime, width: processed.width, height: processed.height, bytes: processed.bytes.byteLength, source: "generated", origin: "assistant" },
				});
				images.push({ artifactId: id, mime: processed.mime, width: processed.width, height: processed.height });
			}

			// Mesmo evento do legado (`ShowImageEvent`): o front agrupa as mensagens `images` consecutivas num baralho.
			const event: ComputerUseEvent = {
				type: "images",
				origin: "assistant",
				items: images.map(({ artifactId, mime, width, height }) => ({ artifactId, mime, width, height })),
			};
			if (scope.conversationId) {
				await deps.persistCard(scope.conversationId, event).catch((error: unknown) => {
					log(`[engine-v4] cartão "images" não gravado na conversa (as imagens já existem): ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
				});
			}
			await scope.emit(event);
			return { images, ...(generated.costUsd !== undefined && { costUsd: generated.costUsd }) };
		},
	};
}
