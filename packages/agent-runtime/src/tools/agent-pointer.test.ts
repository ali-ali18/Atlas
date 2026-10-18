import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { AgentPointerEvent } from "@workspace/shared";
import {
	buildPointerEvent,
	clickLabel,
	navigateLabel,
	pointerName,
	typeLabel,
	withAgentPointer,
} from "./agent-pointer.js";

const SCREEN = { width: 1280, height: 800 };

function setup(partial: Partial<SandboxManager>) {
	const events: AgentPointerEvent[] = [];
	const manager = withAgentPointer(
		{ execScreen: vi.fn(async () => SCREEN), ...partial } as SandboxManager,
		(event) => {
			events.push(event);
		},
		{ now: () => 1234 },
	);
	return { manager, events };
}

describe("agent_pointer — clique por ref", () => {
	it("usa o centro medido pelo sandbox e o nome do elemento", async () => {
		const execBrowserAct = vi.fn(async () => ({
			ok: true,
			ref: "e3",
			action: "click" as const,
			pointer: { x: 412, y: 233, screenW: 1280, screenH: 800, name: "Semana 1" },
			newElements: [],
			newTotal: 0,
		}));
		const { manager, events } = setup({ execBrowserAct });
		await manager.execBrowserAct("s1", { ref: "e3", action: "click" });
		expect(events).toEqual([
			{
				type: "agent_pointer",
				action: "click",
				x: 412,
				y: 233,
				viewportW: 1280,
				viewportH: 800,
				label: "Clicando em “Semana 1”",
				at: 1234,
			},
		]);
	});

	it("falha ao medir: a ação segue ok e o evento sai sem x/y", async () => {
		const result = { ok: true, ref: "e3", action: "click" as const, newElements: [], newTotal: 0 };
		const { manager, events } = setup({ execBrowserAct: vi.fn(async () => result) });
		await expect(manager.execBrowserAct("s1", { ref: "e3", action: "click" })).resolves.toBe(result);
		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty("x");
		expect(events[0]).not.toHaveProperty("y");
		expect(events[0]?.label).toBe("Clicando");
	});

	it("emitir com erro não derruba a ação", async () => {
		const result = { ok: true, target: "x" };
		const manager = withAgentPointer(
			{ execBrowserClick: vi.fn(async () => result) } as unknown as SandboxManager,
			() => {
				throw new Error("fila cheia");
			},
		);
		await expect(manager.execBrowserClick("s1", { text: "x" })).resolves.toBe(result);
	});
});

describe("agent_pointer — clique por coordenada e demais ações", () => {
	it("clique por coordenada leva x,y e o tamanho da tela", async () => {
		const execClick = vi.fn(async () => ({ ok: true }));
		const { manager, events } = setup({ execClick });
		await manager.execClick("s1", 640, 400);
		expect(execClick).toHaveBeenCalledWith("s1", 640, 400);
		expect(events[0]).toMatchObject({ action: "click", x: 640, y: 400, viewportW: 1280, viewportH: 800 });
	});

	it("sem tela conhecida o evento não inventa coordenadas", async () => {
		const events: AgentPointerEvent[] = [];
		const manager = withAgentPointer(
			{ execClick: vi.fn(async () => ({ ok: true })) } as unknown as SandboxManager,
			(event) => {
				events.push(event);
			},
		);
		await manager.execClick("s1", 10, 10);
		expect(events[0]).not.toHaveProperty("x");
		expect(events[0]?.viewportW).toBe(0);
	});

	it("rolar e navegar têm rótulo próprio", async () => {
		const { manager, events } = setup({
			execScroll: vi.fn(async () => ({})),
			execNavigate: vi.fn(async () => ({ url: "https://www.exemplo.com.br/a?token=1", title: "t" })),
		});
		await manager.execScroll("s1", 0, 600);
		await manager.execNavigate("s1", "https://www.exemplo.com.br/a?token=1");
		expect(events.map((e) => [e.action, e.label])).toEqual([
			["scroll", "Rolando a página"],
			["navigate", "Abrindo exemplo.com.br"],
		]);
	});

	it("o decorador sobrevive ao withExecutionContext", async () => {
		const events: AgentPointerEvent[] = [];
		const inner = { execScroll: vi.fn(async () => ({})) };
		const base = {
			withExecutionContext: () => inner,
			execScroll: vi.fn(async () => ({})),
		} as unknown as SandboxManager;
		const manager = withAgentPointer(base, (event) => {
			events.push(event);
		});
		await manager.withExecutionContext!({}).execScroll("s1", 0, 1);
		expect(inner.execScroll).toHaveBeenCalled();
		expect(events).toHaveLength(1);
	});
});

describe("agent_pointer — campos sensíveis", () => {
	it("digitar em senha: rótulo é só 'Digitando…', sem nome nem texto", async () => {
		const secret = "MinhaSenha#2026";
		const execBrowserAct = vi.fn(async () => ({
			ok: true,
			ref: "e9",
			action: "type" as const,
			pointer: { x: 300, y: 200, screenW: 1280, screenH: 800, sensitive: true },
			field: { secret: true },
			newElements: [],
			newTotal: 0,
		}));
		const { manager, events } = setup({ execBrowserAct });
		await manager.execBrowserAct("s1", { ref: "e9", action: "type", value: secret });
		expect(events[0]?.label).toBe("Digitando…");
		expect(JSON.stringify(events)).not.toContain(secret);
	});

	it("digitar por seletor: nunca cita o texto digitado", async () => {
		const execBrowserType = vi.fn(async () => ({
			ok: true,
			pointer: { x: 10, y: 20, screenW: 1280, screenH: 800, name: "Cliente" },
		}));
		const { manager, events } = setup({ execBrowserType });
		await manager.execBrowserType("s1", { selector: "#c", text: "texto confidencial" });
		expect(events[0]?.label).toBe("Digitando em “Cliente”");
		expect(JSON.stringify(events)).not.toContain("confidencial");
	});

	it("campo com nome de segredo vira 'Digitando…'", () => {
		expect(typeLabel("Senha do banco")).toBe("Digitando…");
		expect(typeLabel("Código de verificação")).toBe("Digitando…");
		expect(typeLabel(undefined)).toBe("Digitando…");
		expect(typeLabel("Cliente")).toBe("Digitando em “Cliente”");
	});
});

describe("agent_pointer — helpers puros", () => {
	it("nome é truncado em 40 caracteres e espaços são normalizados", () => {
		const name = pointerName(`  ${"a".repeat(80)}  `)!;
		expect(name).toHaveLength(40);
		expect(name.endsWith("…")).toBe(true);
		expect(pointerName("a   b\n c")).toBe("a b c");
		expect(pointerName("   ")).toBeUndefined();
		expect(clickLabel(undefined)).toBe("Clicando");
	});

	it("navigateLabel só mostra o domínio", () => {
		expect(navigateLabel("https://app.exemplo.com/x?token=abc")).toBe("Abrindo app.exemplo.com");
		expect(navigateLabel("lixo")).toBe("Abrindo página");
	});

	it("buildPointerEvent limita x/y à tela", () => {
		const event = buildPointerEvent({
			action: "click",
			label: "Clicando",
			x: 5000,
			y: -3,
			screen: { w: 1280, h: 800 },
			at: 1,
		});
		expect([event.x, event.y]).toEqual([1280, 0]);
	});
});
