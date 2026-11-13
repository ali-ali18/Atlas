// `generate_image` (F9): cria uma imagem nova com o modelo de imagem do dono.
//
// Efeito `write_external`: a autonomia decide (Equilibrado pede o cartão de aprovação, Autônomo gera direto), a mesma
// regra das escritas em sistemas de terceiros. Sem dono presente (agenda, rotina, subagente) a tool nem é oferecida.
// `egress`: o prompt sai para o provedor, então com dado privado e conteúdo de fora lidos no mesmo run a política pede
// aprovação (cláusula 8). O dono não é um argumento: o escopo vem do run.
import { z } from "zod";
import type { Images } from "../../ports/images.js";
import { defineTool } from "../../tools/define-tool.js";

/** Limite por chamada do provedor (o legado também usava 2). */
export const IMAGE_COUNT_MAX = 2;

/** Formato `largura:altura` (validação de formato, não de comportamento). */
const ASPECT_RATIO_FORMAT = /^\d{1,2}:\d{1,2}$/;

/**
 * Texto para o modelo (inglês). A regra das várias imagens vem com teste de string (`images-capability.test.ts`): texto
 * entre as chamadas quebra o baralho do chat em dois.
 */
export const GENERATE_IMAGE_DESCRIPTION =
	"Create a NEW picture, logo, art or illustration with the owner's image model (paid, one charge per image) and show it in the chat. " +
	"Use it when the owner asks to generate, create, draw, illustrate or design a new picture. " +
	"Do not use it to find or show existing images, to edit or transform an existing image (reference images are not supported), to take screenshots, or when text or a chart would do. " +
	"When several images are needed, make all generate_image calls back to back and write your comment only after the last one (text between calls splits the gallery).";

export function createGenerateImageTool(images: Images) {
	return defineTool({
		name: "generate_image",
		description: GENERATE_IMAGE_DESCRIPTION,
		inputSchema: z.object({
			prompt: z.string().trim().min(1).max(4000).describe("What the picture shows. Write it in the owner's language."),
			count: z.number().int().min(1).max(IMAGE_COUNT_MAX).optional().describe("How many images: 1 (default) or 2."),
			aspectRatio: z
				.string()
				.regex(ASPECT_RATIO_FORMAT, "use width:height, e.g. 16:9")
				.optional()
				.describe("Width:height, e.g. 1:1 (default), 16:9, 9:16, 4:3, 3:4."),
		}),
		effect: "write_external",
		egress: true,
		riskFacts: () => ({ target: "Imagens" }),
		async execute(args, ctx) {
			const count = args.count ?? 1;
			const result = await images.generate(ctx.ownerId, ctx.runId, {
				prompt: args.prompt,
				count,
				...(args.aspectRatio !== undefined && { aspectRatio: args.aspectRatio }),
				...(ctx.signal && { signal: ctx.signal }),
			});
			const ids = result.images.map((image) => image.artifactId);
			if (ids.length === 0) throw new Error("The image model returned no picture. Ask the owner to try again or to pick another image model.");
			const many = ids.length > 1;
			const cost = result.costUsd !== undefined ? ` Provider cost: US$ ${result.costUsd.toFixed(3)}.` : " Provider cost not reported.";
			return {
				ok: true,
				summary: `Generated ${ids.length} image${many ? "s" : ""}; the card with ${many ? "them" : "it"} is in the chat. Artifact id${many ? "s" : ""}: ${ids.join(", ")}. Do not invent a link.${cost}`,
				receipt: { what: many ? `${ids.length} images generated` : "Image generated", where: "Chat", externalId: ids.join(", ") },
			};
		},
	});
}
