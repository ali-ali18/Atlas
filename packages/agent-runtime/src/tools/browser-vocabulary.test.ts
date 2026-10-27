import { describe, expect, it, vi } from "vitest";
import type { ChatTool } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { COMPUTER_USE_TOOLS } from "../computer-use.js";
import { NATIVE_TOOL_GROUPS, nativeToolGroupOf } from "../context/native-tools.js";
import { planContextEconomy } from "../context/economy.js";
import { routeContextGroups } from "../context/intent-router.js";
import { COMPUTER_PROMPT_LINES } from "./computer-refs.js";
import { executeComputerRefTool } from "./computer-refs.js";
import { parseScrollValue } from "./browser-act.js";
import {
	LEGACY_BROWSER_TOOLS,
	canonicalBrowserTool,
	isLegacyBrowserTool,
	resetLegacyBrowserWarnings,
	warnLegacyBrowserTool,
} from "./browser-vocabulary.js";

const BROWSER_OFFERED = ["navigate", "browser_read", "browser_find", "browser_snapshot", "browser_act", "browser_wait", "screenshot"];
const DESKTOP_OFFERED = ["click", "type", "key", "scroll"];

const byName = (name: string): ChatTool | undefined => COMPUTER_USE_TOOLS.find((tool) => tool.function.name === name);

describe("V6 - vocabulário do navegador", () => {
	it("o grupo browser oferece no máximo 8 tools e não inclui os nomes antigos", () => {
		const group = NATIVE_TOOL_GROUPS.browser.tools;
		// `sandbox_release` (desligar a VM) é do grupo mas não é ferramenta de navegação: o teto de 8 vale para as de navegação.
		expect(group.filter((name) => name !== "sandbox_release").length).toBeLessThanOrEqual(8);
		expect([...group].sort()).toEqual([...BROWSER_OFFERED, "computer", "sandbox_release"].sort());
		for (const legacy of Object.keys(LEGACY_BROWSER_TOOLS)) {
			expect(group).not.toContain(legacy);
			expect(byName(legacy)).toBeUndefined();
		}
		// Toda tool do grupo (menos a nativa `computer`) existe no registro.
		for (const name of BROWSER_OFFERED) expect(byName(name), name).toBeDefined();
	});

	it("o desktop é outro grupo, só por coordenada e teclado", () => {
		expect([...NATIVE_TOOL_GROUPS.desktop.tools]).toEqual(DESKTOP_OFFERED);
		for (const name of DESKTOP_OFFERED) expect(nativeToolGroupOf(name)).toBe("desktop");
		for (const name of BROWSER_OFFERED) expect(nativeToolGroupOf(name)).toBe("browser");
	});

	it("descrições em inglês, curtas, dizem quando usar e quando não usar, sem nome de site", () => {
		for (const name of [...BROWSER_OFFERED, ...DESKTOP_OFFERED]) {
			const description = byName(name)!.function.description ?? "";
			expect(description, name).toMatch(/USE|Desktop fallback|Press a key|Scroll the screen/);
			expect(description, name).not.toMatch(/[áàâãéêíóôõúç]/i);
			expect(description, name).not.toMatch(/google|moodle|bling|github|linkedin/i);
			expect(description.length, name).toBeLessThan(900);
		}
		for (const name of ["navigate", "screenshot", "browser_snapshot", "browser_act", "browser_wait", "browser_read", "browser_find", "click", "type"]) {
			expect(byName(name)!.function.description, name).toMatch(/Do NOT/);
		}
	});

	it("o total das tools do navegador fica enxuto (guarda de contexto)", () => {
		const size = BROWSER_OFFERED.map((name) => JSON.stringify(byName(name)).length).reduce((a, b) => a + b, 0);
		expect(size).toBeLessThan(6_800);
		expect(COMPUTER_PROMPT_LINES.join("\n").length).toBeLessThan(1_300);
	});

	it("browser_act aceita ref, text, selector e scroll sem exigir ref", () => {
		const act = byName("browser_act")!.function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
		expect(act.required).toEqual(["action"]);
		expect(Object.keys(act.properties)).toEqual(expect.arrayContaining(["ref", "text", "selector", "action", "value"]));
		expect(act.properties.action!.enum).toEqual(expect.arrayContaining(["click", "type", "select", "scroll"]));
	});

	it("nomes antigos mapeiam para a tool que os substitui e avisam uma vez", () => {
		expect(LEGACY_BROWSER_TOOLS).toEqual({
			browser_click: "browser_act",
			browser_type: "browser_act",
			browser_text: "browser_read",
			browser_links: "browser_read",
		});
		expect(isLegacyBrowserTool("browser_click")).toBe(true);
		expect(isLegacyBrowserTool("browser_act")).toBe(false);
		expect(isLegacyBrowserTool("toString")).toBe(false);
		expect(canonicalBrowserTool("browser_text")).toBe("browser_read");
		expect(canonicalBrowserTool("navigate")).toBe("navigate");
		// Checkpoint retomado com nome antigo carrega o grupo certo.
		expect(nativeToolGroupOf("browser_click")).toBe("browser");
		resetLegacyBrowserWarnings();
		const log = vi.fn();
		warnLegacyBrowserTool("browser_text", log);
		warnLegacyBrowserTool("browser_text", log);
		warnLegacyBrowserTool("navigate", log);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]![0]).toContain('"browser_text"');
	});
});

describe("V6 - o roteador de intenção pré-carrega o navegador", () => {
	const eligible = (names: string[]): ChatTool[] =>
		names.map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }));
	const plan = (extra: { preloadBrowser?: boolean; routerText?: string } = {}) =>
		planContextEconomy({
			eligible: eligible(["web_search", ...BROWSER_OFFERED, ...DESKTOP_OFFERED]),
			routerText: extra.routerText ?? "Bom dia",
			onboarding: false,
			hasImageAttachments: false,
			profileAllowed: false,
			profileRequested: false,
			...(extra.preloadBrowser !== undefined ? { preloadBrowser: extra.preloadBrowser } : {}),
		});

	it("com sandbox o grupo browser vai no 1º passo mesmo sem palavra-chave; o desktop não", () => {
		const loaded = plan({ preloadBrowser: true }).plan.preloaded.map((tool) => tool.function.name);
		expect(loaded).toEqual(expect.arrayContaining(BROWSER_OFFERED));
		for (const name of DESKTOP_OFFERED) expect(loaded).not.toContain(name);
	});

	it("sem o sinal de sandbox e sem palavra-chave nada do navegador é pré-carregado", () => {
		const loaded = plan().plan.preloaded.map((tool) => tool.function.name);
		expect(loaded).toEqual([]);
	});

	it("o índice do prompt não lista de novo o grupo já carregado", () => {
		const { index } = plan({ preloadBrowser: true });
		expect(index).not.toContain("browser:");
		expect(index).toContain("desktop: click, type, key, scroll");
	});

	it("pedido de app fora do navegador ou de arrastar carrega o desktop", () => {
		expect(routeContextGroups({ text: "abra o aplicativo desktop e arraste o ícone" }).has("desktop")).toBe(true);
		expect(routeContextGroups({ text: "clique nas coordenadas 10, 20" }).has("desktop")).toBe(true);
		expect(routeContextGroups({ text: "abra o site loja.exemplo.com.br" }).has("desktop")).toBe(false);
	});
});

describe("V6 - browser_act sem ref", () => {
	const ctx = (manager: Partial<SandboxManager>) => ({
		manager: manager as SandboxManager,
		getSessionId: async () => "s1",
		loginAsked: new Set<string>(),
	});

	it("clique por texto vai para o clique do sandbox e devolve o relatório de mudanças", async () => {
		const execBrowserClick = vi.fn(async () => ({
			ok: true,
			target: "Week 2",
			settled: true,
			waitMs: 120,
			url: "https://lms.test/c",
			navigated: false,
			changes: { added: "Unit 02" },
			newTotal: 0,
		}));
		const out = await executeComputerRefTool("browser_act", { action: "click", text: "Week 2" }, ctx({ execBrowserClick }));
		expect(execBrowserClick).toHaveBeenCalledWith("s1", { selector: undefined, text: "Week 2" });
		expect(out.summary).toContain("Clicked Week 2");
		expect(out.summary).toContain('Added content (7 chars): "Unit 02"');
	});

	it("type sem ref preenche o seletor (ou o foco) e aceita submit", async () => {
		const execBrowserType = vi.fn(async () => ({ ok: true, settled: true, waitMs: 90, url: "https://lms.test/s", navigated: false }));
		const out = await executeComputerRefTool("browser_act", { action: "type", selector: "#q", value: "unit", submit: true }, ctx({ execBrowserType }));
		expect(execBrowserType).toHaveBeenCalledWith("s1", { selector: "#q", text: "unit", submit: true });
		expect(out.summary).toContain("Filled #q + Enter");
	});

	it("scroll rola a página por direção ou pixels e informa a posição", async () => {
		const execScroll = vi.fn(async () => ({ scrollY: 600, scrollHeight: 3000, viewportHeight: 720 }));
		const out = await executeComputerRefTool("browser_act", { action: "scroll", value: "down" }, ctx({ execScroll }));
		expect(execScroll).toHaveBeenCalledWith("s1", 0, 600);
		expect(out.summary).toBe("Scrolled down 600 px; position 600/3000");
		expect(parseScrollValue("up")).toBe(-600);
		expect(parseScrollValue("-250")).toBe(-250);
		expect(parseScrollValue(undefined)).toBe(600);
		expect(() => parseScrollValue("sideways")).toThrow(/down, up, top, bottom/);
	});

	it("sem alvo ou com ação que exige ref, o erro diz o que fazer", async () => {
		const c = ctx({});
		await expect(executeComputerRefTool("browser_act", { action: "click" }, c)).rejects.toThrow(/`ref`.*visible `text`/);
		await expect(executeComputerRefTool("browser_act", { action: "select", value: "x" }, c)).rejects.toThrow(/select needs a `ref`/);
		await expect(executeComputerRefTool("browser_act", { action: "type" }, c)).rejects.toThrow(/needs `value`/);
		await expect(executeComputerRefTool("browser_act", { action: "dance" }, c)).rejects.toThrow(/invalid action/);
		await expect(executeComputerRefTool("browser_act", { ref: "zz", action: "click" }, c)).rejects.toThrow(/ref inválido/);
	});
});
