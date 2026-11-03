import { SHAPE_IDS } from "@workspace/shared/avatar/geometry/shapes";
import { projectFrame } from "@workspace/shared/avatar/render/project";
import { stillFrame } from "@workspace/shared/avatar/render/still";
import { describe, expect, it } from "vitest";
import { AVATAR_SHAPES } from "./bot-edit";
import { chunkRows, COLLAPSED_SHAPES, EDITOR_SHAPE_CELL, EDITOR_SHAPE_SIZE, ENGINE_BOX, GRID_SHAPE_CELL, GRID_SHAPE_SIZE, minCellFor, needsExpanded, RING_PAD_UNITS, RING_SCALE, RING_STROKE_PT, ringBoxSize, SHAPES_PER_ROW, visibleShapes } from "./shape-ring";

describe("a célula comporta o contorno inteiro", () => {
	it("a célula é maior que a forma x escala do contorno, com folga", () => {
		for (const [cell, size] of [[GRID_SHAPE_CELL, GRID_SHAPE_SIZE], [EDITOR_SHAPE_CELL, EDITOR_SHAPE_SIZE]] as const) {
			expect(cell).toBeGreaterThanOrEqual(size * RING_SCALE + 2);
			expect(cell).toBeGreaterThanOrEqual(ringBoxSize(size));
			expect(cell).toBe(minCellFor(size));
		}
	});
	it("a caixa onde o contorno é desenhado cobre a forma mais larga de qualquer uma das formas (nada é recortado)", () => {
		for (const size of [GRID_SHAPE_SIZE, EDITOR_SHAPE_SIZE]) {
			const halfStroke = (RING_STROKE_PT * ENGINE_BOX) / size / 2;
			for (const shape of SHAPE_IDS) {
				// maior distância de um ponto do desenho ao centro da caixa do motor (números do caminho, em pares x y)
				const numbers = (projectFrame(stillFrame(shape, "neutral")).body.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
				const reach = Math.max(...numbers.map((value) => Math.abs(value - ENGINE_BOX / 2)));
				expect(reach * RING_SCALE + halfStroke, `${shape} @${size}`).toBeLessThanOrEqual(ENGINE_BOX / 2 + RING_PAD_UNITS);
			}
		}
	});
	it("5 por linha cabem na menor tela (320 pt)", () => {
		expect(SHAPES_PER_ROW * GRID_SHAPE_CELL).toBeLessThanOrEqual(320 - 32);
	});
});

describe("Ver mais e Ver menos", () => {
	it("recolhido mostra 3 linhas de 5; expandido, todas as formas do editor (a mesma lista)", () => {
		expect(visibleShapes(AVATAR_SHAPES, false)).toHaveLength(COLLAPSED_SHAPES);
		expect(COLLAPSED_SHAPES).toBe(15);
		expect(visibleShapes(AVATAR_SHAPES, true)).toEqual([...AVATAR_SHAPES]);
		expect(AVATAR_SHAPES).toEqual([...SHAPE_IDS]);
		// as geométricas que ficam atrás do "Ver mais"
		expect(visibleShapes(AVATAR_SHAPES, true).slice(COLLAPSED_SHAPES)).toEqual(expect.arrayContaining(["sparkle", "clover", "flower", "heart", "house", "star"]));
	});
	it("a forma escolhida nunca fica escondida: depois da 3a linha, a grade abre expandida", () => {
		expect(needsExpanded(AVATAR_SHAPES, "blob")).toBe(false);
		expect(needsExpanded(AVATAR_SHAPES, AVATAR_SHAPES[COLLAPSED_SHAPES - 1])).toBe(false);
		expect(needsExpanded(AVATAR_SHAPES, "cloud")).toBe(true);
		expect(needsExpanded(AVATAR_SHAPES, "star")).toBe(true);
	});
});

describe("linhas da grade sem buraco", () => {
	it("completa a última linha com espaços, na mesma grade", () => {
		const rows = chunkRows(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"], 6);
		expect(rows).toEqual([["a", "b", "c", "d", "e", "f"], ["g", "h", "i", "j", "k", null]]);
		expect(rows.every((row) => row.length === 6)).toBe(true);
	});
	it("as 11 cores ficam em 2 linhas de 6 e as 25 formas em 5 linhas de 5", () => {
		expect(chunkRows(new Array(11).fill("c"), 6)).toHaveLength(2);
		expect(chunkRows(AVATAR_SHAPES, SHAPES_PER_ROW)).toHaveLength(5);
		expect(chunkRows([], 5)).toEqual([]);
	});
});
