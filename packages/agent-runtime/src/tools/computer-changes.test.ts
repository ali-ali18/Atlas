import { describe, expect, it } from "vitest";
import {
	MAX_ADDED_CHARS,
	MAX_NEW_ELEMENTS,
	UNTRUSTED_PAGE_NOTE,
	formatActionOutcome,
	formatBrowserClick,
	formatBrowserType,
} from "./computer-changes.js";
import { formatAct } from "./computer-refs.js";

const base = { ok: true as const, ref: "e20", action: "click" as const, url: "https://x.test/c", navigated: false, settled: true, waitMs: 280, newElements: [], newTotal: 0 };

describe("formatActionOutcome (V4)", () => {
	it("acordeão expandido: estado, texto revelado e refs novos na mesma resposta", () => {
		const text = formatAct({
			...base,
			changes: { added: "Unit 01 Intro | Activity guide", addedBlocks: 2, states: ['e20 "Week 1" expanded false→true'] },
			newElements: ['[e29] link "Unit 01 Intro" → /u/1', '[e31] link "Activity guide" → /u/2'],
			newTotal: 2,
		});
		expect(text).toContain("Clicked e20 [280 ms]");
		expect(text).toContain('Changed: e20 "Week 1" expanded false→true');
		expect(text).toContain('Added content (30 chars): "Unit 01 Intro | Activity guide"');
		expect(text).toContain("New elements (2):");
		expect(text).toContain('[e31] link "Activity guide"');
		expect(text).toContain(UNTRUSTED_PAGE_NOTE);
		expect(text).not.toContain("Verification warning");
	});

	it("texto novo e elementos têm teto; diz quanto ficou de fora", () => {
		const added = "x".repeat(MAX_ADDED_CHARS + 500);
		const many = Array.from({ length: 30 }, (_, i) => `[e${i + 40}] link "L${i}"`);
		const lines = formatActionOutcome({
			...base,
			changes: { added, addedTotalChars: 2400 },
			newElements: many,
			newTotal: 30,
		}).join("\n");
		expect(lines).toContain(`(+${2400 - MAX_ADDED_CHARS} more chars: use browser_read to read the rest)`);
		expect(lines.split("\n").filter((l) => l.startsWith("[e")).length).toBe(MAX_NEW_ELEMENTS);
		expect(lines).toContain(`New elements (30, ${30 - MAX_NEW_ELEMENTS} more: browser_snapshot):`);
		expect(lines.length).toBeLessThan(MAX_ADDED_CHARS + 1200);
	});

	it("diálogo aberto e fechado", () => {
		const lines = formatActionOutcome({ ...base, changes: { dialogsOpened: ["Settings"], dialogsClosed: ["Welcome"] } }).join("\n");
		expect(lines).toContain('Dialog opened: "Settings"');
		expect(lines).toContain('Dialog closed: "Welcome"');
	});

	it("navegação completa pede snapshot; rota de SPA só avisa que refs podem estar velhos", () => {
		const full = formatActionOutcome({ ...base, navigated: true, title: "Next", changes: { reloaded: true } }).join("\n");
		expect(full).toContain('Navigated to https://x.test/c ("Next")');
		expect(full).toContain("use browser_snapshot");
		const spa = formatActionOutcome({ ...base, navigated: true, changes: { added: "Courses" } }).join("\n");
		expect(spa).toContain("URL changed to https://x.test/c (same page; older refs may be stale)");
		expect(spa).toContain('Added content (7 chars): "Courses"');
	});

	it("nada mudou: browser_act deixa o aviso de verificação; click/type dizem 'No visible change'", () => {
		const act = formatAct(base);
		expect(act).toContain("Verification warning: no visible change");
		expect(act).not.toContain("No visible change (");
		const click = formatBrowserClick({ ...base, target: "Save" });
		expect(click).toContain("No visible change");
		expect(click).toContain("browser_wait");
	});

	it("página ainda mudando avisa; erros de validação entram como dado da página", () => {
		const lines = formatActionOutcome({ ...base, settled: false, waitMs: 3000, errors: ["Name: required"] }).join("\n");
		expect(lines).toContain("still changing after 3000 ms");
		expect(lines).toContain("Validation errors (1):");
		expect(lines).toContain("Name: required");
		expect(lines).toContain("(waited 3000 ms)");
	});

	it("segredo no texto novo é redigido", () => {
		const lines = formatActionOutcome({ ...base, changes: { added: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }).join("\n");
		expect(lines).not.toContain("AAAAAAAAAAAAAAAA");
	});

	it("browser_click e browser_type usam o mesmo contrato", () => {
		const click = formatBrowserClick({
			...base,
			target: "Week 2",
			matches: 3,
			ambiguous: true,
			changes: { added: "Unit 02 Intro" },
			newElements: ['[e50] link "Unit 02 Intro"'],
			newTotal: 1,
		});
		expect(click).toContain("Clicked Week 2 (3 elements matched");
		expect(click).toContain('Added content (13 chars): "Unit 02 Intro"');
		const type = formatBrowserType({ selector: "#q", submit: true }, { ...base, changes: { added: "3 results" } });
		expect(type).toContain("Filled #q + Enter [280 ms]");
		expect(type).toContain('Added content (9 chars): "3 results"');
	});
});
