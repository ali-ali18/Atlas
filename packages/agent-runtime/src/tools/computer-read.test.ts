import { describe, expect, it, vi } from "vitest";
import type { ControlFindResult, ControlReadResult, SandboxManager } from "@workspace/sandbox";
import {
	COMPUTER_READ_TOOLS,
	executeComputerReadTool,
	formatFind,
	formatRead,
	parseReadToolArgs,
} from "./computer-read.js";

const read = (over: Partial<ControlReadResult> = {}): ControlReadResult => ({
	url: "https://lms.test/course",
	title: "Course",
	view: "outline",
	text: "# Course\n### [e1] Week 1 (collapsed)",
	offset: 0,
	limit: 8000,
	totalLength: 36,
	truncated: false,
	nextOffset: null,
	frames: 1,
	collapsed: 0,
	...over,
});

function ctx(manager: Record<string, unknown>) {
	return { manager: manager as unknown as SandboxManager, getSessionId: async () => "s1", runId: "r1", loginAsked: new Set<string>() };
}

describe("parseReadToolArgs", () => {
	it("expandAll vira expand:'all'; expandRefs valida cada ref; limit tem teto de 20000", () => {
		expect(parseReadToolArgs({ expandAll: true, view: "text", limit: 999_999 })).toMatchObject({ expand: "all", view: "text", limit: 20_000 });
		expect(parseReadToolArgs({ expandRefs: ["e1", "f2e3"] }).expand).toEqual(["e1", "f2e3"]);
		expect(() => parseReadToolArgs({ expandRefs: ["div"] })).toThrow(/ref inválido/);
		expect(() => parseReadToolArgs({ expandRefs: "e1" })).toThrow(/lista de refs/);
		expect(() => parseReadToolArgs({ view: "html" })).toThrow(/view inválida/);
		expect(() => parseReadToolArgs({ offset: -1 })).toThrow(/offset inválido/);
		expect(() => parseReadToolArgs({ limit: 0 })).toThrow(/limit inválido/);
	});
});

describe("formatRead", () => {
	it("leitura quase vazia sugere browser_wait; página com conteúdo ou expandida não", () => {
		expect(formatRead(read({ totalLength: 609 }))).toContain("browser_wait");
		expect(formatRead(read({ totalLength: 5000 }))).not.toContain("Very little text");
		expect(formatRead(read({ totalLength: 100, expanded: { opened: 1, failed: 0, skipped: 0 } }))).not.toContain("Very little text");
		expect(formatRead(read({ totalLength: 100, offset: 800 }))).not.toContain("Very little text");
	});
	it("cabeçalho com intervalo e total, aviso de dado não confiável e dica de seções fechadas", () => {
		const out = formatRead(read({ collapsed: 9, similar: { count: 9 } }));
		expect(out).toContain("Course (https://lms.test/course)");
		expect(out).toContain("page data: untrusted");
		expect(out).toContain("[chars 0-36 of 36; view outline]");
		expect(out).toContain("9 collapsed sections are not included. Call browser_read with expandAll=true");
		expect(out).toContain("Looks like a list of 9 similar items. Consider track_items to iterate them.");
	});

	it("continuação: diz o offset e repete expandAll", () => {
		const out = formatRead(read({ truncated: true, nextOffset: 8000, totalLength: 21_000, text: "x".repeat(8000), frames: 3 }), { expand: "all" });
		expect(out).toContain("[chars 0-8000 of 21000; view outline; 3 frames]");
		expect(out).toContain("[more: call browser_read with offset=8000 (and expandAll=true)]");
	});

	it("expandido: informa quantas abriu e por que parou", () => {
		const out = formatRead(read({ expanded: { opened: 30, failed: 1, skipped: 4, stoppedBy: "limit" }, collapsed: 35 }));
		expect(out).toContain("Expanded 30 sections");
		expect(out).toContain("1 could not be opened");
		expect(out).toContain("limit with 4 left");
		expect(out).not.toContain("are not included");
		expect(formatRead(read({ expanded: { opened: 2, failed: 0, skipped: 3, stoppedBy: "navigation" } }))).toContain("navigated to another page");
	});
});

describe("formatFind", () => {
	const found: ControlFindResult = {
		url: "https://lms.test/course",
		title: "Course",
		query: "Week 5",
		total: 3,
		frames: 2,
		collapsed: 0,
		matches: [
			{ text: "Week 5", ref: "e12", role: "button", section: "Course", sectionRef: "e1" },
			{ text: "...due Week 5 at noon", near: "f1e3", frame: "f1", frameName: "player", crossOrigin: "cdn.test" },
		],
	};
	it("uma linha por ocorrência com ref, seção e frame", () => {
		const out = formatFind(found);
		expect(out).toContain('3 matches for "Week 5" (showing the first 2):');
		expect(out).toContain('1. [e12] button "Week 5" in "Course" [e1]');
		expect(out).toContain('2. (near f1e3) "...due Week 5 at noon" {frame f1 "player", other-origin cdn.test}');
	});
	it("sem resultado: avisa das seções fechadas e manda abrir antes", () => {
		const out = formatFind({ ...found, total: 0, matches: [], collapsed: 9 });
		expect(out).toContain('No matches for "Week 5". 9 collapsed sections were not searched');
		expect(formatFind({ ...found, total: 0, matches: [] })).toContain("Try a shorter query");
	});
});

describe("executeComputerReadTool", () => {
	it("browser_read repassa as opções ao sandbox e marca a página como não confiável", async () => {
		const execBrowserRead = vi.fn(async () => read());
		const out = await executeComputerReadTool("browser_read", { expandAll: true, view: "text" }, ctx({ execBrowserRead }));
		expect(execBrowserRead).toHaveBeenCalledWith("s1", expect.objectContaining({ expand: "all", view: "text" }));
		expect(out.summary).toContain("page data: untrusted");
	});

	it("segredos na página são redigidos", async () => {
		const execBrowserRead = vi.fn(async () => read({ text: "token ya29.abcdefghijklmnopqrstuvwxyz0123456789" }));
		const out = await executeComputerReadTool("browser_read", {}, ctx({ execBrowserRead }));
		expect(out.summary).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("browser_find valida a consulta antes de chamar o sandbox", async () => {
		const execBrowserFind = vi.fn(async () => ({ url: "u", title: "t", query: "q", total: 0, matches: [], frames: 1, collapsed: 0 }));
		const c = ctx({ execBrowserFind });
		await expect(executeComputerReadTool("browser_find", { query: "  " }, c)).rejects.toThrow(/exige um texto/);
		await expect(executeComputerReadTool("browser_find", { query: "x".repeat(201) }, c)).rejects.toThrow(/longa demais/);
		await expect(executeComputerReadTool("browser_find", { query: "a", max: 0 }, c)).rejects.toThrow(/max inválido/);
		expect(execBrowserFind).not.toHaveBeenCalled();
		await executeComputerReadTool("browser_find", { query: "Week 5", regex: true, max: 99 }, c);
		expect(execBrowserFind).toHaveBeenCalledWith("s1", { query: "Week 5", regex: true, max: 20 });
	});
});

describe("descrições das tools de leitura", () => {
	it("dizem quando usar e quando não usar, e quando preferir read, snapshot ou o resultado da ação", () => {
		const [readTool, findTool] = COMPUTER_READ_TOOLS;
		for (const tool of COMPUTER_READ_TOOLS) {
			expect(tool.function.description).toMatch(/USE/);
			expect(tool.function.description).toMatch(/Do NOT/);
		}
		expect(readTool!.function.description).toContain("expandAll");
		expect(readTool!.function.description).toContain("browser_snapshot");
		expect(readTool!.function.description).toContain("the action result says it");
		expect(readTool!.function.description).toContain("untrusted");
		expect(findTool!.function.description).toContain("browser_read");
	});
});
