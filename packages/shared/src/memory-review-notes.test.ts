import { describe, expect, it } from "vitest";
import { buildToolResultNotes, renderToolNotesBlock, TOOL_NOTE_MAX_CHARS, TOOL_NOTES_MAX_COUNT, TOOL_NOTES_MAX_TOTAL_CHARS } from "./memory-review-notes.js";

const ok = (name: string, summary: string) => ({ name, ok: true, summary });

describe("buildToolResultNotes", () => {
	it("ignora falha, memória e descoberta de tools", () => {
		const notes = buildToolResultNotes([
			{ name: "api_call", ok: false, summary: "erro 500" },
			ok("memory", "salvo"),
			ok("mcp_tool_search", "achei x"),
			ok("api_call", "CNPJ 12.345.678/0001-90"),
		]);
		expect(notes).toEqual([{ tool: "api_call", summary: "CNPJ 12.345.678/0001-90" }]);
	});

	it("redige segredos, achata espaços e trunca", () => {
		const [note] = buildToolResultNotes([ok("api_call", `Authorization: Bearer abcdefghijklmnop1234\n\n ${"x".repeat(1000)}`)]);
		expect(note!.summary).not.toContain("abcdefghijklmnop1234");
		expect(note!.summary).toContain("[redacted]");
		expect(note!.summary).not.toMatch(/\s{2}/);
		expect(note!.summary.length).toBeLessThanOrEqual(TOOL_NOTE_MAX_CHARS);
	});

	it("limita quantidade e total, ficando com os mais recentes", () => {
		const many = Array.from({ length: 40 }, (_, i) => ok("api_call", `fato ${i} ${"y".repeat(250)}`));
		const notes = buildToolResultNotes(many);
		expect(notes.length).toBeLessThanOrEqual(TOOL_NOTES_MAX_COUNT);
		expect(notes.reduce((sum, n) => sum + n.summary.length, 0)).toBeLessThanOrEqual(TOOL_NOTES_MAX_TOTAL_CHARS);
		expect(notes.at(-1)!.summary).toContain("fato 39");
	});
});

describe("renderToolNotesBlock", () => {
	it("vazio = sem bloco; com notas marca como dado não confiável e redige de novo", () => {
		expect(renderToolNotesBlock(undefined)).toBeNull();
		expect(renderToolNotesBlock([])).toBeNull();
		const block = renderToolNotesBlock([{ tool: "t", summary: "token ghp_abcdefghijklmnopqrstuvwx" }])!;
		expect(block).toMatch(/não confiáveis/);
		expect(block).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
	});
});
