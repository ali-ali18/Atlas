import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

// Replay: o modelo fraco diz "entrou, painel logado" com a tela em branco / sem conferir a tela.

const step = (name: string, args: Record<string, unknown> = {}, id = `c-${name}`): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
});
const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content } });

const snapshotOf = (url: string, title = "Painel") => ({ url, title, total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['[e1] link "Cursos"'] });

async function run(input: { script: CompleteChatWithToolsResult[]; snapshotUrl?: string; message?: string }) {
	const manager = {
		execNavigate: vi.fn(async () => ({ url: "https://painel.exemplo.com/cursos", title: "Painel", ready: true })),
		execBrowserSnapshot: vi.fn(async () => snapshotOf(input.snapshotUrl ?? "https://painel.exemplo.com/cursos")),
		execBrowserAct: vi.fn(async () => ({ ok: true, action: "click", ref: "e1", settled: true })),
	} as unknown as SandboxManager;
	const events: Array<Record<string, unknown>> = [];
	const requests: Array<{ system: string[] }> = [];
	const script = [...input.script];
	const result = await runComputerUse({
		manager,
		getSessionId: async () => "s1",
		sandboxEnabled: true,
		apiKey: "test",
		model: "m",
		runId: "run-claims",
		userId: "user-a",
		botId: "bot-a",
		origin: "chat",
		contextEconomy: true,
		messages: [{ role: "user", content: input.message ?? "entra no painel e me diz o que tem" }],
		maxSteps: 10,
		onEvent: (event) => void events.push(event as unknown as Record<string, unknown>),
		streamChat: async (params) => {
			requests.push({ system: params.messages.filter((m) => m.role === "system").map((m) => String(m.content)) });
			return script.shift() ?? say("fim");
		},
	});
	return { result, events, requests, manager };
}

const NOTE = "verify the current screen with browser_snapshot";
const noteSeen = (requests: Array<{ system: string[] }>) => requests.some((r) => r.system.some((s) => s.toLowerCase().includes(NOTE)));

describe("portão contra inventar a tela", () => {
	it("diz 'entrou' sem conferir a tela depois de navegar: uma revisão com a nota, depois responde", async () => {
		const { result, events, requests } = await run({
			script: [step("navigate", { url: "https://painel.exemplo.com" }), say("Entrei, o painel está logado e mostra 3 cursos."), step("browser_snapshot"), say("Pronto: o painel mostra a lista de cursos.")],
		});
		expect(events.find((e) => e.type === "assistant_discard")).toMatchObject({ reason: "unverified_screen" });
		expect(noteSeen(requests)).toBe(true);
		expect(result.text).toContain("lista de cursos");
	});

	it("conferiu a tela (snapshot) depois da ação: responde direto, sem revisão", async () => {
		const { result, events, requests } = await run({
			script: [step("navigate", { url: "https://painel.exemplo.com" }), step("browser_snapshot"), say("Entrei: o painel mostra 3 cursos.")],
		});
		expect(events.some((e) => e.type === "assistant_discard")).toBe(false);
		expect(noteSeen(requests)).toBe(false);
		expect(result.text).toContain("3 cursos");
	});

	it("a tela lida é about:blank e o modelo afirma que entrou: pede conferência", async () => {
		const { events, requests } = await run({
			snapshotUrl: "about:blank",
			script: [step("browser_snapshot"), say("Entrei no painel, está logado."), say("A tela está em branco, não consegui entrar.")],
		});
		expect(events.find((e) => e.type === "assistant_discard")).toMatchObject({ reason: "unverified_screen" });
		expect(noteSeen(requests)).toBe(true);
	});

	it("página de login lida e afirmação de login: pede conferência", async () => {
		const { events } = await run({
			snapshotUrl: "https://painel.exemplo.com/login",
			script: [step("browser_snapshot"), say("Estou logado no painel."), say("Ainda vejo a tela de entrada.")],
		});
		expect(events.find((e) => e.type === "assistant_discard")).toMatchObject({ reason: "unverified_screen" });
	});

	it("revisa no máximo uma vez por run: a segunda afirmação sai como está", async () => {
		const { result, events } = await run({
			script: [step("navigate", { url: "https://painel.exemplo.com" }), say("Entrei no painel."), say("Entrei no painel, de verdade.")],
		});
		expect(events.filter((e) => e.type === "assistant_discard")).toHaveLength(1);
		expect(result.text).toBe("Entrei no painel, de verdade.");
	});

	it("sem navegador no run, ou sem afirmar a tela: nada muda ('Bom dia' continua simples)", async () => {
		const chat = await run({ script: [say("Entrei em contato com a equipe, já estou de volta.")], message: "Bom dia" });
		expect(chat.events.some((e) => e.type === "assistant_discard")).toBe(false);
		const plain = await run({ script: [step("navigate", { url: "https://painel.exemplo.com" }), say("Abri o site, quer que eu leia a página?")] });
		expect(plain.events.some((e) => e.type === "assistant_discard")).toBe(false);
	});
});
