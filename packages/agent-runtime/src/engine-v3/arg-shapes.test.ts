import { describe, expect, it } from "vitest";
import type { ChatTool } from "@workspace/llm";
import { CREATE_FILE_TOOL } from "../tools/create-file.js";
import { coerceJsonText, jsonTextNote, toolSearchText, type CatalogEntry } from "./bridge.js";
import { SHAPES_MAX_CHARS, SHAPE_LINE_MAX_CHARS, argShapes, invalidArgsMessage, toolSignature, toolSignatureWithShapes } from "./failures.js";

/**
 * PR8e (lacuna do PR9): o Haiku mandou `slides`/`sheets` do `create_file` como TEXTO JSON porque a assinatura mostrava
 * só `object[]`. A assinatura passa a mostrar o formato dos itens e o executor converte texto JSON válido com uma nota.
 */
const entry = (tool: ChatTool): CatalogEntry => ({ name: tool.function.name, tool, source: "native", summary: "Create a downloadable file" });

describe("assinatura com o formato dos itens", () => {
	it("create_file: sheets mostra os campos do item (obrigatório sem ?) e slides mostra o começo da descrição", () => {
		const shapes = argShapes(CREATE_FILE_TOOL);
		expect(shapes).toContain("sheets: {name?: string, columns?: string[], rows: unknown[][]}[]");
		const slides = shapes.find((line) => line.startsWith("slides: "));
		expect(slides).toMatch(/^slides: object\[\] \(each item: pptx only, up to \d+ slides, each \{layout\?, title/);
		for (const line of shapes) expect(line.length).toBeLessThanOrEqual(SHAPE_LINE_MAX_CHARS);
		expect(shapes.join("; ").length).toBeLessThanOrEqual(SHAPES_MAX_CHARS);
		// Array de texto não ganha linha: a assinatura curta já basta.
		expect(shapes.some((line) => line.startsWith("unconfirmed"))).toBe(false);
	});

	it("tool_search traz a linha de formatos; tool sem array de objetos fica como antes", () => {
		const text = toolSearchText("arquivo", [entry(CREATE_FILE_TOOL)]);
		expect(text).toMatch(/shapes \(real JSON, not text\): .*sheets: \{name\?: string, columns\?: string\[\], rows: unknown\[\]\[\]\}\[\]/);
		const plain: ChatTool = { type: "function", function: { name: "get_weather", description: "Weather.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };
		expect(toolSearchText("weather", [entry(plain)])).not.toMatch(/shapes/);
		expect(toolSignatureWithShapes(plain)).toBe(toolSignature(plain));
	});

	it("formato com teto: muitos campos não estouram o limite", () => {
		const wide: ChatTool = {
			type: "function",
			function: {
				name: "wide",
				description: "x",
				parameters: {
					type: "object",
					properties: Object.fromEntries(
						Array.from({ length: 20 }, (_, index) => [`list${index}`, { type: "array", items: { type: "object", properties: Object.fromEntries(Array.from({ length: 15 }, (_, k) => [`field_with_long_name_${k}`, { type: "string" }])) } }]),
					),
				},
			},
		};
		const shapes = argShapes(wide);
		expect(shapes.length).toBeGreaterThan(0);
		expect(shapes.join("; ").length).toBeLessThanOrEqual(SHAPES_MAX_CHARS);
		for (const line of shapes) expect(line.length).toBeLessThanOrEqual(SHAPE_LINE_MAX_CHARS);
	});

	it("erro de argumento mostra a assinatura com os formatos", () => {
		expect(invalidArgsMessage(CREATE_FILE_TOOL, "slides must be array")).toMatch(/Expected: create_file\(.*\); shapes \(send real JSON arrays\/objects, not text\): .*sheets: /);
	});
});

describe("texto JSON no lugar de array/objeto", () => {
	it("texto JSON válido vira o array, com nota curta ao modelo", () => {
		const slides = [{ title: "Capa" }, { title: "Resumo", bullets: ["a"] }];
		const out = coerceJsonText(CREATE_FILE_TOOL, { filename: "deck.pptx", slides: JSON.stringify(slides) });
		expect(out).toEqual({ args: { filename: "deck.pptx", slides }, converted: ["slides"] });
		expect(jsonTextNote(["slides"])).toBe("Note: slides arrived as JSON text and was converted. Next time send it as a real JSON array/object, not a string.");
	});

	it("JSON inválido continua falhando com a dica (nada é descartado)", () => {
		const out = coerceJsonText(CREATE_FILE_TOOL, { filename: "deck.pptx", sheets: '[{"rows": [[1, 2]' });
		expect(out).toMatchObject({ error: expect.stringMatching(/^sheets must be a JSON array, not text; the text you sent is not valid JSON either/) });
	});

	it("só onde é seguro: campo de texto, texto que não parece JSON e tipo errado ficam como estão", () => {
		const args = { filename: "notes.md", content: "[1, 2]", slides: "uma lista", sheets: '{"rows": []}' };
		const out = coerceJsonText(CREATE_FILE_TOOL, args);
		expect(out).toEqual({ args, converted: [] });
		if ("args" in out) expect(out.args).toBe(args);
		const objectField: ChatTool = { type: "function", function: { name: "t", description: "x", parameters: { type: "object", properties: { filter: { type: "object" }, either: { type: ["array", "string"] } } } } };
		expect(coerceJsonText(objectField, { filter: '{"a":1}', either: "[1]" })).toEqual({ args: { filter: { a: 1 }, either: "[1]" }, converted: ["filter"] });
	});
});
