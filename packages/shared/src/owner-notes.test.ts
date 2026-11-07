import { describe, expect, it } from "vitest";
import {
	OWNER_NOTES_PINNED_CONTEXT_MAX,
	OWNER_NOTES_PINNED_CONTEXT_MAX_CHARS,
	OWNER_NOTE_BODY_MAX_CHARS,
	OWNER_NOTE_TITLE_MAX_CHARS,
	findDuplicateNote,
	noteSnippet,
	parseCreateOwnerNote,
	parseUpdateOwnerNote,
	rankNotes,
	renderPinnedNotesContext,
} from "./owner-notes.js";

const note = (id: string, title: string, body: string, over: Partial<{ pinned: boolean; updatedAt: string; botId: string | null }> = {}) => ({ id, title, body, pinned: false, updatedAt: "2026-11-01T10:00:00Z", botId: null, ...over });

describe("validação do corpo", () => {
	it("aceita nota mínima e recusa vazio, grande demais e campo desconhecido", () => {
		expect(parseCreateOwnerNote({ title: " Mercado ", body: "leite" })).toEqual({ ok: true, value: { title: "Mercado", body: "leite" } });
		expect(parseCreateOwnerNote({ title: "x", body: "   " }).ok).toBe(false);
		expect(parseCreateOwnerNote({ title: "", body: "x" }).ok).toBe(false);
		expect(parseCreateOwnerNote({ title: "x".repeat(OWNER_NOTE_TITLE_MAX_CHARS + 1), body: "x" }).ok).toBe(false);
		expect(parseCreateOwnerNote({ title: "x", body: "y".repeat(OWNER_NOTE_BODY_MAX_CHARS + 1) }).ok).toBe(false);
		const unknown = parseCreateOwnerNote({ title: "x", body: "y", userId: "outro" });
		expect(unknown).toEqual({ ok: false, error: "Campo desconhecido: userId." });
	});
	it("a edição exige ao menos um campo e não muda o escopo", () => {
		expect(parseUpdateOwnerNote({}).ok).toBe(false);
		expect(parseUpdateOwnerNote({ pinned: true })).toEqual({ ok: true, value: { pinned: true } });
		expect(parseUpdateOwnerNote({ botId: "b2" }).ok).toBe(false);
	});
});

describe("duplicata por igualdade normalizada", () => {
	const existing = [note("n1", "A", "Prefiro reuniões às 10h!"), note("n2", "B", "Prefiro reuniões às 10h", { botId: "b1" })];
	it("ignora acento, caixa e pontuação, dentro do mesmo escopo", () => {
		expect(findDuplicateNote(existing, { body: "prefiro REUNIOES as 10h", botId: null })?.id).toBe("n1");
		expect(findDuplicateNote(existing, { body: "prefiro reuniões às 10h", botId: "b1" })?.id).toBe("n2");
		expect(findDuplicateNote(existing, { body: "prefiro reuniões às 10h", botId: "b9" })).toBeNull();
	});
	it("a própria nota não conta como duplicata de si", () => {
		expect(findDuplicateNote(existing, { body: "Prefiro reuniões às 10h!", botId: null }, "n1")).toBeNull();
	});
	it("texto sem letras ou números nunca é duplicata", () => {
		expect(findDuplicateNote([note("n1", "t", "...")], { body: "!!!", botId: null })).toBeNull();
	});
});

describe("busca", () => {
	const notes = [
		note("a", "Viagem a Lisboa", "voo dia 12, hotel perto do centro", { updatedAt: "2026-10-01T00:00:00Z" }),
		note("b", "Compras", "comprar café e pão; lembrar do voo", { updatedAt: "2026-10-20T00:00:00Z" }),
		note("c", "Receitas", "bolo de cenoura", { updatedAt: "2026-10-10T00:00:00Z", pinned: true }),
	];
	it("título pesa mais que o corpo e acento não atrapalha", () => {
		expect(rankNotes(notes, "viagem").map((n) => n.id)).toEqual(["a"]);
		expect(rankNotes(notes, "VOO").map((n) => n.id)).toEqual(["b", "a"]);
		expect(rankNotes(notes, "cafe").map((n) => n.id)).toEqual(["b"]);
	});
	it("sem consulta devolve as mais recentes; sem acerto, vazio; respeita o limite", () => {
		expect(rankNotes(notes, "", 2).map((n) => n.id)).toEqual(["b", "c"]);
		expect(rankNotes(notes, "inexistente")).toEqual([]);
		expect(rankNotes(notes, "voo", 1)).toHaveLength(1);
	});
});

describe("trecho do contexto", () => {
	it("sem fixadas não há trecho (o prompt não cresce)", () => {
		expect(renderPinnedNotesContext([])).toBeNull();
	});
	it("lista id e título, sem o corpo", () => {
		const text = renderPinnedNotesContext([{ id: "n1", title: "Viagem\nLisboa" }])!;
		expect(text).toContain("- [n1] Viagem Lisboa");
		expect(text).toContain("note_get");
	});
	it("o teto técnico vale e o excedente aparece como +N", () => {
		const many = Array.from({ length: OWNER_NOTES_PINNED_CONTEXT_MAX + 5 }, (_, i) => ({ id: `n${i}`, title: `Título ${i}` }));
		const text = renderPinnedNotesContext(many)!;
		expect(text.split("\n").filter((line) => line.startsWith("- [")).length).toBe(OWNER_NOTES_PINNED_CONTEXT_MAX);
		expect(text).toContain("(+5 more pinned notes: use note_search)");
		const long = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, title: "t".repeat(OWNER_NOTE_TITLE_MAX_CHARS) }));
		expect(renderPinnedNotesContext(long)!.length).toBeLessThanOrEqual(OWNER_NOTES_PINNED_CONTEXT_MAX_CHARS + 80);
	});
});

describe("noteSnippet", () => {
	it("junta linhas e corta com reticências", () => {
		expect(noteSnippet("a\n\nb")).toBe("a b");
		expect(noteSnippet("x".repeat(300), 10)).toBe("xxxxxxxxx…");
	});
});
