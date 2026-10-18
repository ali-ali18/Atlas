import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
	};
});

export function step(
	calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		},
	};
}

export function text(content: string): CompleteChatWithToolsResult {
	return { model: "test-model", message: { role: "assistant", content } };
}

async function runWith(
	manager: Partial<SandboxManager>,
	queue: CompleteChatWithToolsResult[],
) {
	const toolResults: Array<{ name: string; ok: boolean; summary: string }> = [];
	const offered: string[][] = [];
	await runComputerUse({
		manager: manager as SandboxManager,
		getSessionId: async () => "session-1",
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "abra a página e faça (no desktop, por coordenadas)" }],
		runId: "run-browser",
		maxSteps: 12,
		onEvent: (event) => {
			if (event.type === "tool_result") {
				toolResults.push({ name: event.name, ok: event.ok, summary: event.summary });
			}
		},
		streamChat: async (request) => {
			offered.push((request.tools ?? []).map((tool) => tool.function.name));
			return queue.shift() ?? text("ok");
		},
	});
	return { toolResults, offered };
}

describe("F12/A1 - browser_click e browser_type sem ambiguidade", () => {
	it("envia text E selector juntos ao sandbox e avisa quando o clique foi ambíguo", async () => {
		const execBrowserClick = vi.fn(async () => ({
			ok: true,
			target: "Incluir proposta",
			matches: 2,
			ambiguous: true,
		}));
		const { toolResults } = await runWith({ execBrowserClick }, [
			step([{ id: "c1", name: "browser_click", args: { selector: "a", text: "Incluir proposta" } }]),
			text("feito"),
		]);
		expect(execBrowserClick).toHaveBeenCalledWith("session-1", {
			selector: "a",
			text: "Incluir proposta",
		});
		expect(toolResults[0]?.ok).toBe(true);
		expect(toolResults[0]?.summary).toMatch(/2 elements matched/);
	});

	it("erro do sandbox por seletor genérico chega ao modelo com a dica do snapshot", async () => {
		const execBrowserClick = vi.fn(async () => {
			throw new Error('Seletor genérico "a" casa com muitos elementos. Use browser_snapshot e depois browser_act com o ref do elemento.');
		});
		const { toolResults } = await runWith({ execBrowserClick }, [
			step([{ id: "c1", name: "browser_click", args: { selector: "a" } }]),
			text("ok"),
		]);
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).toContain("browser_snapshot");
	});
});

describe("F12/A2 - leitura paginada não dispara o detector de laço", () => {
	it("mesmos args com scrollY diferente (ler, rolar, ler) segue sem abortar", async () => {
		let y = 0;
		const execBrowserText = vi.fn(async () => ({
			url: "https://kabum.com.br/p",
			title: "Produto",
			text: "mesmo topo do menu",
			mode: "page" as const,
			offset: 0,
			totalLength: 9000,
			truncated: true,
			nextOffset: 4000,
			scrollY: (y += 700),
			scrollHeight: 9000,
		}));
		const execScroll = vi.fn(async () => ({ scrollY: y, scrollHeight: 9000 }));
		const { toolResults } = await runWith({ execBrowserText, execScroll }, [
			step([{ id: "t1", name: "browser_text", args: {} }]),
			step([{ id: "s1", name: "scroll", args: { deltaY: 700 } }]),
			step([{ id: "t2", name: "browser_text", args: {} }]),
			step([{ id: "s2", name: "scroll", args: { deltaY: 700 } }]),
			step([{ id: "t3", name: "browser_text", args: {} }]),
			text("li até o fim"),
		]);
		expect(toolResults.filter((r) => r.name === "browser_text" && r.ok)).toHaveLength(3);
		expect(toolResults[0]?.summary).toContain("scrollY=700/9000");
		expect(toolResults[0]?.summary).toContain("offset=4000");
		expect(toolResults[1]?.summary).toContain("posição");
	});

	it("repassa offset/limit/mode ao sandbox e valida args", async () => {
		const execBrowserText = vi.fn(async () => ({ url: "u", title: "t", text: "x", totalLength: 1 }));
		const { toolResults } = await runWith({ execBrowserText }, [
			step([{ id: "t1", name: "browser_text", args: { offset: 4000, limit: 500, mode: "viewport" } }]),
			step([{ id: "t2", name: "browser_text", args: { offset: -3 } }]),
			text("ok"),
		]);
		expect(execBrowserText).toHaveBeenCalledWith("session-1", {
			offset: 4000,
			limit: 500,
			mode: "viewport",
		});
		expect(toolResults[1]?.ok).toBe(false);
	});
});

describe("F12/A3 - resultado traz o efeito da ação", () => {
	it("click/navigate/browser_click mostram navegação e página instável", async () => {
		const { toolResults } = await runWith(
			{
				execNavigate: vi.fn(async () => ({ url: "https://erp.test/x", title: "ERP", settled: false })),
				execClick: vi.fn(async () => ({ ok: true, url: "https://erp.test/y", navigated: true, settled: true })),
				execBrowserClick: vi.fn(async () => ({ ok: true, target: "Salvar", url: "https://erp.test/z", navigated: true, settled: true })),
			},
			[
				step([{ id: "n", name: "navigate", args: { url: "https://erp.test/x" } }]),
				step([{ id: "c", name: "click", args: { x: 10, y: 20 } }]),
				step([{ id: "b", name: "browser_click", args: { text: "Salvar" } }]),
				text("ok"),
			],
		);
		expect(toolResults[0]?.summary).toMatch(/ainda estava mudando/);
		expect(toolResults[1]?.summary).toContain("navegou para https://erp.test/y");
		expect(toolResults[2]?.summary).toContain("Navigated to https://erp.test/z");
	});
});

describe("F12/A4-A5 - erros da VM", () => {
	it("type não devolve o texto longo e a falha não manda repetir", async () => {
		const tsv = "a\tb\n".repeat(300);
		const execType = vi.fn(async () => ({ ok: true }));
		const execKey = vi.fn(async () => {
			throw new Error("elemento sumiu");
		});
		const { toolResults } = await runWith({ execType, execKey }, [
			step([{ id: "t", name: "type", args: { text: tsv } }]),
			step([{ id: "k", name: "key", args: { combo: "ctrl+v" } }]),
			text("ok"),
		]);
		expect(execType).toHaveBeenCalledWith("session-1", tsv);
		expect(toolResults[0]?.summary).toContain("1200 caracteres");
		expect(toolResults[0]?.summary.length).toBeLessThan(150);
		expect(toolResults[1]?.ok).toBe(false);
		expect(toolResults[1]?.summary).not.toMatch(/repita|de novo uma vez/i);
	});

	it("duas falhas seguidas de infra mandam sair do computador", async () => {
		const execNavigate = vi.fn(async () => {
			throw new Error("Chrome indisponível após tentativa de recuperação na VM");
		});
		const { toolResults } = await runWith({ execNavigate }, [
			step([{ id: "n1", name: "navigate", args: { url: "https://a.com" } }]),
			step([{ id: "n2", name: "navigate", args: { url: "https://b.com" } }]),
			text("sem navegador"),
		]);
		expect(toolResults[0]?.summary).not.toContain("PARE de usar");
		expect(toolResults[1]?.summary).toContain("PARE de usar");
		expect(toolResults[1]?.summary).toContain("web_extract");
	});
});

describe("V1 - cliques que funcionam e navegação com prontidão", () => {
	it("browser_click informa o degrau e o banner recusado; navigate avisa SPA ainda montando", async () => {
		const { toolResults } = await runWith(
			{
				execNavigate: vi.fn(async () => ({ url: "https://erp.test/x", title: "ERP", ready: false, settled: false, hint: "page is still rendering; call browser_wait or read again" })),
				execBrowserClick: vi.fn(async () => ({
					ok: true,
					target: "Disciplina Alfa",
					rung: "overlay" as const,
					dismissed: "consent" as const,
					retargeted: '<a "Open Alfa">',
					url: "https://erp.test/alfa",
					navigated: true,
					settled: true,
				})),
			},
			[
				step([{ id: "n", name: "navigate", args: { url: "https://erp.test/x" } }]),
				step([{ id: "b", name: "browser_click", args: { text: "Disciplina Alfa" } }]),
				text("ok"),
			],
		);
		expect(toolResults[0]?.summary).toContain("still rendering");
		expect(toolResults[0]?.summary).not.toContain("ainda estava mudando");
		expect(toolResults[1]?.summary).toContain("worked via overlay step");
		expect(toolResults[1]?.summary).toContain("dismissed a consent banner");
		expect(toolResults[1]?.summary).toContain("Navigated to https://erp.test/alfa");
	});

	it("erro de clique com call log gigante chega compacto ao modelo", async () => {
		const NL = String.fromCharCode(10);
		const huge = ["locator.click: Timeout 15000ms exceeded.", "Call log:", ...Array(120).fill("  - <div id=onetrust> intercepts pointer events")].join(NL);
		const execBrowserClick = vi.fn(async () => {
			throw new Error(huge);
		});
		const { toolResults } = await runWith({ execBrowserClick }, [
			step([{ id: "c1", name: "browser_click", args: { text: "Alfa" } }]),
			text("ok"),
		]);
		expect(toolResults[0]?.ok).toBe(false);
		expect(toolResults[0]?.summary).not.toContain("intercepts pointer events");
		expect(toolResults[0]?.summary.length).toBeLessThan(900);
	});
});
