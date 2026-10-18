import { describe, expect, it } from "vitest";
import { routeContextGroups } from "./intent-router.js";
import { P_IMAGES } from "./prompt-blocks.js";
import { GENERATE_IMAGE_TOOL, IMAGE_MODEL_MISSING_MESSAGE } from "../tools/generate-image.js";

describe("roteamento do grupo images para pedidos de geração (pt-BR)", () => {
	const phrases = [
		"gera uma imagem de um gato astronauta",
		"Gere uma imagem de um gato astronauta",
		"cria um logo para minha padaria",
		"crie um logotipo azul",
		"desenha um dragão",
		"faz uma arte para o instagram",
		"cria uma ilustração de uma floresta",
		"faça um banner para o evento",
		"me gera um cartaz de festa junina",
		"monta uma capa para o livro",
		"generate an image of a cat",
		"create a logo for my shop",
	];
	for (const text of phrases) {
		it(`carrega images: "${text}"`, () => {
			expect(routeContextGroups({ text }).has("images")).toBe(true);
		});
	}
	it("não carrega images para conversa comum", () => {
		expect(routeContextGroups({ text: "qual é a capital da França?" }).has("images")).toBe(false);
	});
	it("o prompt manda chamar generate_image direto e avisa onde configurar", () => {
		const prompt = P_IMAGES.join(" ");
		expect(prompt).toContain("call generate_image right away");
		expect(prompt).toContain("Configurações › Modelos");
		expect(GENERATE_IMAGE_TOOL.function.description).toContain("gera uma imagem");
		expect(IMAGE_MODEL_MISSING_MESSAGE).toContain("Configurações › Modelos");
	});
});
