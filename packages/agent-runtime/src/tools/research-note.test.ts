import { describe, expect, it } from "vitest";
import { buildRuntimeCheckpoint, parseRuntimeCheckpoint } from "../checkpoint.js";
import {
	RESEARCH_NOTES_LAYER_CHARS,
	RESEARCH_NOTES_PRIOR_CHARS,
	RESEARCH_NOTES_MAX,
	createResearchNotes,
	executeResearchNote,
	parseResearchNoteArgs,
	parseResearchNotes,
} from "./research-note.js";

const note = (n: number, extra: Record<string, unknown> = {}) => ({
	sourceRef: `https://example.test/p${n}`,
	findings: `finding ${n}`,
	keyFacts: [`fact ${n}`],
	...extra,
});

describe("research_note: validação dos args", () => {
	it("exige sourceRef e findings, e confidence válida", () => {
		expect(() => parseResearchNoteArgs({ findings: "x" }, 1)).toThrow(/sourceRef/);
		expect(() => parseResearchNoteArgs({ sourceRef: "u" }, 1)).toThrow(/findings/);
		expect(() => parseResearchNoteArgs({ sourceRef: "u", findings: "x", confidence: "sure" }, 1)).toThrow(/confidence/);
	});

	it("limita tamanhos, descarta links que não são http(s) e usa confidence medium por padrão", () => {
		const parsed = parseResearchNoteArgs(
			{
				sourceRef: "s".repeat(900),
				findings: "f".repeat(900),
				keyFacts: Array.from({ length: 20 }, (_, i) => `${"k".repeat(400)}${i}`),
				links: ["javascript:alert(1)", "https://ok.test/a", "ftp://x.test", 5],
			},
			3,
		);
		expect(parsed.sourceRef).toHaveLength(300);
		expect(parsed.findings).toHaveLength(500);
		expect(parsed.keyFacts).toHaveLength(8);
		expect(parsed.keyFacts[0]).toHaveLength(200);
		expect(parsed.links).toEqual(["https://ok.test/a"]);
		expect(parsed.confidence).toBe("medium");
		expect(parsed.step).toBe(3);
	});
});

describe("research_note: armazenamento e camada", () => {
	it("mesma fonte substitui a nota; passando do teto sai a mais antiga", () => {
		const notes = createResearchNotes();
		notes.add(parseResearchNoteArgs(note(1), 1));
		const replaced = notes.add(parseResearchNoteArgs(note(1, { findings: "novo" }), 2));
		expect(replaced).toEqual({ total: 1, replaced: true });
		for (let i = 2; i <= RESEARCH_NOTES_MAX + 5; i++) notes.add(parseResearchNoteArgs(note(i), i));
		const all = notes.snapshot();
		expect(all).toHaveLength(RESEARCH_NOTES_MAX);
		expect(all.some((item) => item.sourceRef.endsWith("/p1"))).toBe(false);
		expect(all.at(-1)?.sourceRef).toBe(`https://example.test/p${RESEARCH_NOTES_MAX + 5}`);
	});

	it("sem notas não há camada; com notas, mais novas primeiro e dentro do orçamento", () => {
		const notes = createResearchNotes();
		expect(notes.layer()).toBeNull();
		for (let i = 1; i <= 40; i++) {
			notes.add(parseResearchNoteArgs(note(i, { findings: "x".repeat(480), keyFacts: ["y".repeat(190), "z".repeat(190)] }), i));
		}
		const layer = notes.layer()!;
		expect(layer.indexOf("/p40:")).toBeLessThan(layer.indexOf("/p39:"));
		expect(layer).toContain("older note(s) omitted");
		expect(layer.length).toBeLessThan(RESEARCH_NOTES_LAYER_CHARS + 600);
	});

	it("deliver pede o arquivo a partir das notas", () => {
		const notes = createResearchNotes();
		notes.add(parseResearchNoteArgs(note(1), 1));
		expect(notes.layer()).not.toContain("write the requested file");
		expect(notes.layer({ deliver: true })).toContain("write the requested file now from these notes");
	});

	it("notas de runs anteriores aparecem em seção própria e nunca entram no snapshot do run", () => {
		const notes = createResearchNotes(undefined, [note(7)]);
		expect(notes.layer()).toContain("From earlier runs in this conversation:");
		expect(notes.layer()).toContain("/p7:");
		expect(notes.snapshot()).toEqual([]);
	});

	it("executor devolve resumo curto e lança com args inválidos", () => {
		const notes = createResearchNotes();
		const ctx = { researchNotes: notes, currentStep: () => 4 };
		expect(executeResearchNote(note(1), ctx).summary).toMatch(/^Note saved \(1\/40\)/);
		expect(() => executeResearchNote({ sourceRef: "" }, ctx)).toThrow();
		expect(() => executeResearchNote(note(1), {})).toThrow(/not available/);
		expect(notes.snapshot()[0]?.step).toBe(4);
	});
});

describe("research_note: checkpoint", () => {
	it("as notas sobrevivem ao round-trip do checkpoint; lixo é ignorado", () => {
		const notes = createResearchNotes();
		notes.add(parseResearchNoteArgs(note(1), 1));
		const checkpoint = buildRuntimeCheckpoint({
			messages: [],
			conversation: [],
			nextStepIndex: 1,
			model: "m",
			researchNotes: notes.snapshot(),
		});
		const restored = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
		expect(restored?.researchNotes).toEqual(notes.snapshot());
		expect(parseResearchNotes([null, 3, { sourceRef: "" }, note(2)])).toHaveLength(1);
		expect(parseRuntimeCheckpoint({ messages: [] })?.researchNotes).toBeUndefined();
	});
	it("pesquisa anterior longa chega inteira ao modelo (não só as 3 notas mais novas) e a mesma fonte não duplica", () => {
		const prior = Array.from({ length: 14 }, (_, i) => note(i + 1, { findings: "achado ".repeat(60), keyFacts: ["f".repeat(150), "g".repeat(150)] }));
		prior.push(note(1, { findings: "versão nova da fonte 1" }));
		const layer = createResearchNotes(undefined, prior).layer()!;
		for (let i = 1; i <= 14; i++) expect(layer).toContain("/p" + i + ":");
		expect(layer.match(/p1:/g)).toHaveLength(1);
		expect(layer).toContain("versão nova da fonte 1");
		expect(layer.length).toBeLessThan(RESEARCH_NOTES_PRIOR_CHARS + 800);
	});

	it("notas do run atual consomem o orçamento total; as anteriores mantêm o piso", () => {
		const notes = createResearchNotes(undefined, [note(90), note(91)]);
		for (let i = 1; i <= 30; i++) notes.add(parseResearchNoteArgs(note(i, { findings: "x".repeat(450) }), i));
		const layer = notes.layer()!;
		expect(layer).toContain("/p91:");
	});
});
