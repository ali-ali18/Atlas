import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import { COMPUTER_TABS_TOOL, executeComputerTabsTool, formatTabs, parseTabsToolArgs } from "./computer-tabs.js";

const ctx = (manager: Record<string, unknown>) => ({ manager: manager as unknown as SandboxManager, getSessionId: async () => "s1" });

describe("parseTabsToolArgs", () => {
	it("list não pede índice; switch e close pedem um inteiro de 1 a 99", () => {
		expect(parseTabsToolArgs({ action: "list", index: 7 })).toEqual({ action: "list" });
		expect(parseTabsToolArgs({ action: "switch", index: 2 })).toEqual({ action: "switch", index: 2 });
		expect(parseTabsToolArgs({ action: "close", index: "3" })).toEqual({ action: "close", index: 3 });
	});
	it("recusa ação desconhecida e índice ausente, zero, fracionário ou fora do teto", () => {
		expect(() => parseTabsToolArgs({})).toThrow(/action must be one of/);
		expect(() => parseTabsToolArgs({ action: "open" })).toThrow(/action must be one of/);
		for (const index of [undefined, 0, -1, 1.5, 100, "x", "", null, NaN]) {
			expect(() => parseTabsToolArgs({ action: "switch", index }), String(index)).toThrow(/needs "index"/);
			expect(() => parseTabsToolArgs({ action: "close", index }), String(index)).toThrow(/needs "index"/);
		}
	});
});

describe("formatTabs", () => {
	it("lista numerada com a aba ativa marcada e aviso de dado não confiável", () => {
		const out = formatTabs({
			action: "list",
			tabs: [
				{ index: 1, title: "Curso", url: "https://lms.test/curso", active: false },
				{ index: 2, title: "", url: "https://lms.test/aula", active: true },
			],
		});
		expect(out).toContain('Open tabs (2):\n1. "Curso" — https://lms.test/curso\n2. [active] https://lms.test/aula');
		expect(out).toContain("untrusted");
	});
	it("switch e close dizem onde o modelo está agora", () => {
		expect(formatTabs({ action: "switch", active: { index: 1, title: "Curso", url: "https://lms.test/curso" } })).toBe(
			'Switched to tab 1: "Curso" — https://lms.test/curso. Read or screenshot it before acting.',
		);
		expect(formatTabs({ action: "close", closed: { index: 2, title: "Aula", url: "u" }, active: '"Curso" — https://lms.test/curso' })).toBe(
			'Closed tab 2: "Aula" — u. You are now on: "Curso" — https://lms.test/curso.',
		);
		expect(formatTabs({ action: "close", closed: { index: 2, title: "", url: "u" } })).toBe("Closed tab 2: u.");
	});
});

describe("executeComputerTabsTool", () => {
	it("valida antes de chamar a VM e repassa a ação limpa", async () => {
		const execBrowserTabs = vi.fn(async () => ({ action: "list" as const, tabs: [] }));
		const c = ctx({ execBrowserTabs });
		await expect(executeComputerTabsTool({ action: "switch" }, c)).rejects.toThrow(/needs "index"/);
		expect(execBrowserTabs).not.toHaveBeenCalled();
		await executeComputerTabsTool({ action: "list", index: 4 }, c);
		expect(execBrowserTabs).toHaveBeenCalledWith("s1", { action: "list" });
	});
	it("erro da VM (ex.: fechar a última aba) sobe como erro, nunca como sucesso", async () => {
		const execBrowserTabs = vi.fn(async () => { throw new Error("This is the only open tab; it cannot be closed."); });
		await expect(executeComputerTabsTool({ action: "close", index: 1 }, ctx({ execBrowserTabs }))).rejects.toThrow(/only open tab/);
	});
});

describe("descrição da tool", () => {
	it("diz quando usar e quando não usar", () => {
		const text = COMPUTER_TABS_TOOL.function.description ?? "";
		expect(text).toMatch(/USE/);
		expect(text).toMatch(/Do NOT/);
		expect(text).toContain("followed automatically");
		expect(COMPUTER_TABS_TOOL.function.name).toBe("browser_tabs");
	});
});
