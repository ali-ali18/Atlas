// Capacidade lazy `images` (F9): gerar imagens novas com o modelo de imagem do dono. Só o índice vai no prompt; o
// schema e estas instruções entram ao carregar (`use_capability`). Sem dono presente a capacidade não entra (o preset
// monta sem a porta nesses runs).
import type { Images } from "../../ports/images.js";
import { defineCapability } from "../define-capability.js";
import { createGenerateImageTool } from "./generate-image.js";

export * from "./generate-image.js";

export const IMAGES_INSTRUCTIONS =
	"Image rules: generate only a NEW picture, logo, art or illustration the owner asked for. Do not use this for existing images or to edit one. " +
	"The picture appears in the chat; say that in one plain sentence and do not invent a link. " +
	"If the tool says no image model is set, tell the owner to set one in Configurações › Modelos › Modelo para gerar imagens, in Portuguese.";

export function createImagesCapability(images: Images) {
	return defineCapability({
		id: "images",
		title: "Imagens",
		summary: "Generate new pictures, logos or illustrations from a text prompt with the owner's image model (paid).",
		tools: [createGenerateImageTool(images)],
		instructions: IMAGES_INSTRUCTIONS,
		cards: ["images"],
	});
}
